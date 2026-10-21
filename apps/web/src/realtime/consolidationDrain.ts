/**
 * consolidation outbox drain：可注入依赖的纯发送逻辑。
 * 本模块不在 import 时发请求或启定时器；不接入 RealtimeClient。
 *
 * 限制（须在接线文档中保留）：
 * - localStorage 无原子 CAS；多标签可能竞态；幂等依赖服务端 receipt。
 * - 前端 lease 不能替代服务端幂等。
 */

import {
  classifyConsolidationHttp,
  readRetryAfterMs,
} from "./consolidateResult.ts";
import {
  ConsolidationOutbox,
  ConsolidationOutboxError,
  type ConsolidationOutboxItem,
} from "./consolidationOutbox.ts";

export const CONSOLIDATION_DRAIN_PATH = "/api/memory/consolidate";
export const CONSOLIDATION_DRAIN_DEFAULT_LEASE_MS = 60_000;
export const CONSOLIDATION_DRAIN_DEFAULT_MAX_BATCHES = 8;
export const CONSOLIDATION_DRAIN_DEFAULT_BUDGET_MS = 25_000;
export const CONSOLIDATION_DRAIN_DEFAULT_MAX_BACKOFF_MS = 120_000;

export type DrainFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export type DrainConsolidationOptions = {
  outbox: ConsolidationOutbox;
  /** 测试注入 mock；禁止默认真实网络。调用方接线时再传入 window.fetch。 */
  fetchImpl: DrainFetch;
  /** 返回 UTC ISO Z。 */
  now: () => string;
  leaseOwner: string;
  leaseDurationMs?: number;
  maxBatches?: number;
  timeBudgetMs?: number;
  consolidatePath?: string;
  /**
   * 可选请求头（如 Authorization）。由调用方注入；本模块不读 secret／.env。
   * RealtimeClient 现网 consolidate 请求本身不带 Authorization（依赖同源／代理）。
   */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  backoffMs?: (attempts: number) => number;
  maxBackoffMs?: number;
};

export type DrainBatchOutcomeKind =
  | "sent_removed"
  | "retry_scheduled"
  | "dead_letter"
  | "skipped"
  | "failed";

export type DrainBatchOutcome = {
  batchId: string;
  kind: DrainBatchOutcomeKind;
  detail?: string;
};

export type DrainConsolidationResult = {
  outcomes: DrainBatchOutcome[];
  processed: number;
  stoppedReason: "done" | "max_batches" | "time_budget" | "storage_error";
  error?: ConsolidationOutboxError | Error;
};

function parseInstantMs(iso: string): number | null {
  const ms = Date.parse(iso);

  if (!Number.isFinite(ms)) return null;

  return ms;
}

function addMsToIso(nowIso: string, deltaMs: number): string {
  const base = parseInstantMs(nowIso);

  if (base === null) {
    throw new ConsolidationOutboxError("invalid_input", "now is not a valid ISO instant");
  }

  return new Date(base + Math.max(0, deltaMs)).toISOString();
}

export function defaultDrainBackoffMs(
  attempts: number,
  maxBackoffMs = CONSOLIDATION_DRAIN_DEFAULT_MAX_BACKOFF_MS,
): number {
  const exp = Math.min(Math.max(0, attempts), 4);
  const raw = 30_000 * 2 ** exp;

  return Math.min(maxBackoffMs, Math.max(1_000, raw));
}

/**
 * 判断条目是否可被本 owner 领取。
 * - pending：nextAttemptAt <= now
 * - in_flight：仅当 leaseExpiresAt 存在且 <= now（过期可抢）
 * - in_flight 且 leaseExpiresAt == null：ambiguous（旧数据／损坏租约）— 不抢占
 */
export function classifyClaimEligibility(
  item: ConsolidationOutboxItem,
  nowIso: string,
): "claimable" | "not_due" | "leased" | "ambiguous_lease" | "ignore" {
  const nowMs = parseInstantMs(nowIso);

  if (nowMs === null) return "ignore";

  if (item.status === "dead_letter") return "ignore";

  if (item.status === "pending") {
    const dueMs = parseInstantMs(item.nextAttemptAt);

    if (dueMs === null) return "ambiguous_lease";
    if (dueMs > nowMs) return "not_due";

    return "claimable";
  }

  if (item.status === "in_flight") {
    if (item.leaseExpiresAt === null) return "ambiguous_lease";

    const expMs = parseInstantMs(item.leaseExpiresAt);

    if (expMs === null) return "ambiguous_lease";
    if (expMs > nowMs) return "leased";

    return "claimable";
  }

  return "ignore";
}

async function resolveHeaders(
  headers: DrainConsolidationOptions["headers"],
): Promise<HeadersInit> {
  if (!headers) return {};

  if (typeof headers === "function") return headers();

  return headers;
}

function buildConsolidateBody(item: ConsolidationOutboxItem): string {
  return JSON.stringify({
    batchId: item.batchId,
    payloadHash: item.payloadHash,
    occurredOn: item.occurredOn,
    turns: item.turns.map((turn) => ({ role: turn.role, text: turn.text })),
  });
}

async function claimItem(
  outbox: ConsolidationOutbox,
  item: ConsolidationOutboxItem,
  options: {
    nowIso: string;
    leaseOwner: string;
    leaseDurationMs: number;
  },
): Promise<ConsolidationOutboxItem> {
  const leaseExpiresAt = addMsToIso(options.nowIso, options.leaseDurationMs);

  return outbox.update(item.batchId, {
    status: "in_flight",
    leaseOwner: options.leaseOwner,
    leaseExpiresAt,
    attempts: item.attempts + 1,
    lastError: null,
  });
}

function scheduleRetry(
  outbox: ConsolidationOutbox,
  batchId: string,
  options: {
    nowIso: string;
    attempts: number;
    lastError: string;
    retryAfterMs?: number;
    backoffMs: (attempts: number) => number;
  },
): ConsolidationOutboxItem {
  const delay =
    options.retryAfterMs !== undefined && options.retryAfterMs > 0
      ? options.retryAfterMs
      : options.backoffMs(options.attempts);

  return outbox.update(batchId, {
    status: "pending",
    leaseOwner: null,
    leaseExpiresAt: null,
    nextAttemptAt: addMsToIso(options.nowIso, delay),
    lastError: options.lastError,
  });
}

function markDeadLetter(
  outbox: ConsolidationOutbox,
  batchId: string,
  lastError: string,
): ConsolidationOutboxItem {
  return outbox.update(batchId, {
    status: "dead_letter",
    leaseOwner: null,
    leaseExpiresAt: null,
    lastError,
  });
}

/**
 * 执行一轮有界 drain。不启动定时器；不修改 RealtimeClient。
 */
export async function drainConsolidationOutbox(
  options: DrainConsolidationOptions,
): Promise<DrainConsolidationResult> {
  const leaseDurationMs =
    options.leaseDurationMs ?? CONSOLIDATION_DRAIN_DEFAULT_LEASE_MS;
  const maxBatches = options.maxBatches ?? CONSOLIDATION_DRAIN_DEFAULT_MAX_BATCHES;
  const timeBudgetMs =
    options.timeBudgetMs ?? CONSOLIDATION_DRAIN_DEFAULT_BUDGET_MS;
  const path = options.consolidatePath ?? CONSOLIDATION_DRAIN_PATH;
  const maxBackoffMs =
    options.maxBackoffMs ?? CONSOLIDATION_DRAIN_DEFAULT_MAX_BACKOFF_MS;
  const backoffMs =
    options.backoffMs ??
    ((attempts: number) => defaultDrainBackoffMs(attempts, maxBackoffMs));

  const startedMs = parseInstantMs(options.now()) ?? Date.now();
  const outcomes: DrainBatchOutcome[] = [];
  const handled = new Set<string>();

  let items: ConsolidationOutboxItem[];

  try {
    items = options.outbox.list();
  } catch (error) {
    const wrapped =
      error instanceof ConsolidationOutboxError
        ? error
        : new ConsolidationOutboxError(
            "unavailable",
            error instanceof Error ? error.message : String(error),
          );

    return {
      outcomes,
      processed: 0,
      stoppedReason: "storage_error",
      error: wrapped,
    };
  }

  const candidates = items
    .filter((item) => classifyClaimEligibility(item, options.now()) === "claimable")
    .sort((a, b) => {
      const aMs = parseInstantMs(a.nextAttemptAt) ?? 0;
      const bMs = parseInstantMs(b.nextAttemptAt) ?? 0;
      return aMs - bMs;
    });

  for (const candidate of candidates) {
    if (handled.has(candidate.batchId)) continue;

    if (outcomes.filter((o) => o.kind !== "skipped").length >= maxBatches) {
      return {
        outcomes,
        processed: outcomes.filter((o) => o.kind !== "skipped").length,
        stoppedReason: "max_batches",
      };
    }

    const nowIso = options.now();
    const nowMs = parseInstantMs(nowIso) ?? Date.now();

    if (nowMs - startedMs >= timeBudgetMs) {
      return {
        outcomes,
        processed: outcomes.filter((o) => o.kind !== "skipped").length,
        stoppedReason: "time_budget",
      };
    }

    let fresh: ConsolidationOutboxItem | null;

    try {
      fresh = options.outbox.get(candidate.batchId);
    } catch (error) {
      const wrapped =
        error instanceof ConsolidationOutboxError
          ? error
          : new ConsolidationOutboxError(
              "unavailable",
              error instanceof Error ? error.message : String(error),
            );

      return {
        outcomes,
        processed: outcomes.filter((o) => o.kind !== "skipped").length,
        stoppedReason: "storage_error",
        error: wrapped,
      };
    }

    if (!fresh) continue;

    const eligibility = classifyClaimEligibility(fresh, nowIso);

    if (eligibility === "ambiguous_lease") {
      outcomes.push({
        batchId: fresh.batchId,
        kind: "failed",
        detail: "in_flight leaseExpiresAt missing; refusing to guess",
      });
      handled.add(fresh.batchId);
      continue;
    }

    if (eligibility !== "claimable") {
      outcomes.push({
        batchId: fresh.batchId,
        kind: "skipped",
        detail: eligibility,
      });
      continue;
    }

    let claimed: ConsolidationOutboxItem;

    try {
      claimed = await claimItem(options.outbox, fresh, {
        nowIso,
        leaseOwner: options.leaseOwner,
        leaseDurationMs,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);

      outcomes.push({
        batchId: fresh.batchId,
        kind: "failed",
        detail: `claim failed: ${message}`,
      });
      handled.add(fresh.batchId);

      if (error instanceof ConsolidationOutboxError) {
        if (error.code === "corrupt" || error.code === "unavailable") {
          return {
            outcomes,
            processed: outcomes.filter((o) => o.kind !== "skipped").length,
            stoppedReason: "storage_error",
            error,
          };
        }
      }

      continue;
    }

    handled.add(claimed.batchId);

    const body = buildConsolidateBody(claimed);
    let response: Response;
    let responseBody: unknown;

    try {
      const extra = await resolveHeaders(options.headers);
      response = await options.fetchImpl(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...normalizeHeaders(extra),
        },
        body,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      const afterClaimNow = options.now();

      try {
        scheduleRetry(options.outbox, claimed.batchId, {
          nowIso: afterClaimNow,
          attempts: claimed.attempts,
          lastError: `network: ${message}`,
          backoffMs,
        });
        outcomes.push({
          batchId: claimed.batchId,
          kind: "retry_scheduled",
          detail: message,
        });
      } catch (updateError) {
        const detail =
          updateError instanceof Error
            ? updateError.message
            : String(updateError);

        outcomes.push({
          batchId: claimed.batchId,
          kind: "failed",
          detail: `network then update failed: ${detail}`,
        });

        if (updateError instanceof ConsolidationOutboxError) {
          return {
            outcomes,
            processed: outcomes.filter((o) => o.kind !== "skipped").length,
            stoppedReason: "storage_error",
            error: updateError,
          };
        }
      }

      continue;
    }

    try {
      responseBody = await response.json();
    } catch {
      responseBody = undefined;
    }

    const outcome = classifyConsolidationHttp(
      response.status,
      response.ok,
      responseBody,
    );
    const afterNow = options.now();

    try {
      if (outcome.kind === "success") {
        const removed = options.outbox.remove(claimed.batchId);

        if (!removed) {
          outcomes.push({
            batchId: claimed.batchId,
            kind: "failed",
            detail: "remove returned false after success",
          });
          continue;
        }

        outcomes.push({
          batchId: claimed.batchId,
          kind: "sent_removed",
        });
        continue;
      }

      if (outcome.kind === "permanent") {
        markDeadLetter(
          options.outbox,
          claimed.batchId,
          outcome.message,
        );
        outcomes.push({
          batchId: claimed.batchId,
          kind: "dead_letter",
          detail: outcome.message,
        });
        continue;
      }

      // deferred（如 200+retryAfterMs）或 retryable（含 429／5xx／malformed 200）
      // 429 在 classify 中为 retryable；仍须尊重 body.retryAfterMs（与配额 deferred 一致）。
      const retryAfterMs =
        outcome.kind === "deferred"
          ? outcome.retryAfterMs
          : readRetryAfterMs(responseBody);

      scheduleRetry(options.outbox, claimed.batchId, {
        nowIso: afterNow,
        attempts: claimed.attempts,
        lastError:
          outcome.kind === "deferred"
            ? `deferred: ${outcome.retryAfterMs}ms`
            : outcome.message,
        retryAfterMs: retryAfterMs > 0 ? retryAfterMs : undefined,
        backoffMs,
      });
      outcomes.push({
        batchId: claimed.batchId,
        kind: "retry_scheduled",
        detail:
          outcome.kind === "deferred"
            ? `deferred ${outcome.retryAfterMs}`
            : outcome.message,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);

      outcomes.push({
        batchId: claimed.batchId,
        kind: "failed",
        detail: `post-response outbox update failed: ${detail}`,
      });

      if (error instanceof ConsolidationOutboxError) {
        if (error.code === "corrupt" || error.code === "unavailable") {
          return {
            outcomes,
            processed: outcomes.filter((o) => o.kind !== "skipped").length,
            stoppedReason: "storage_error",
            error,
          };
        }
      }
    }
  }

  return {
    outcomes,
    processed: outcomes.filter((o) => o.kind !== "skipped").length,
    stoppedReason: "done",
  };
}

function normalizeHeaders(headers: HeadersInit): Record<string, string> {
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};

    headers.forEach((value, key) => {
      out[key] = value;
    });

    return out;
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  return { ...headers };
}
