/**
 * 客户端提醒交付状态（可离线测试）。
 *
 * 状态：claimed → detecting → heard true/false → settling
 *   → confirmed | deferred | pendingSettle(不确定) | stale
 *
 * mentionDue 成功 = 转写命中到点句（非「已入队」）。
 * 崩溃且 settle 未达服务器时，45s 后他页仍可能重播——无法仅靠客户端 Set 保证恰好一次。
 */

export type ReminderFromServer = {
  id: string;
  line: string;
  delivery: "speak" | "left";
  leftAt?: string;
  /** speak 领取时的服务端 updatedAt，settle 带回以防陈旧 claim */
  claimedAt?: string;
};

export type ReminderPlan = {
  settleSpoken: string[];
  showLeft: Array<{ id: string; line: string; leftAt: string }>;
  toSpeak: Array<{ id: string; line: string; claimedAt?: string }>;
  /**
   * 仍在 deferred 退避中，但本轮已被服务端 claim 为 speak：
   * 只 settle(heard=false) 释放租约，不 mentionDue。
   */
  releaseDeferred: Array<{ id: string; line: string; claimedAt?: string }>;
};

/** 不确定 settle 最多补试次数（× 轮询间隔，须短于 45s 回收窗口内有意义地重试）。 */
export const MAX_SETTLE_ATTEMPTS = 6;

/** Aside deferred 后，同提醒至少这么久不触发 mentionDue（仍可 settle 释放租约）。 */
export const DEFERRED_BACKOFF_MS = 45_000;

export type PendingSettle = {
  id: string;
  heard: boolean;
  claimedAt?: string;
  /** 已消耗的不确定重试次数；达到 MAX_SETTLE_ATTEMPTS 后丢弃 pending。 */
  attempts?: number;
};

/** 不确定结果后是否继续挂 pending（有界）。 */
export function nextPendingAfterUncertain(
  item: PendingSettle,
): PendingSettle | null {
  const attempts = (item.attempts ?? 0) + 1;
  if (attempts >= MAX_SETTLE_ATTEMPTS) return null;
  return { ...item, attempts };
}

/**
 * 规划本轮要处理的提醒。
 * spoken / pendingSettle(heard=true) 只补 settle，不重新 speak。
 */
export function planReminderBatch(input: {
  reminders: readonly ReminderFromServer[];
  spoken: ReadonlySet<string>;
  handled: ReadonlySet<string>;
  inFlight: ReadonlySet<string>;
  pendingSettleIds: ReadonlySet<string>;
  /** 有界重试耗尽：仍阻止重播，但不再 settleSpoken。 */
  settleGaveUp?: ReadonlySet<string>;
  /** id → 退避结束时间（epoch ms）；期间不 mentionDue。 */
  deferredUntil?: ReadonlyMap<string, number>;
  nowMs?: number;
}): ReminderPlan {
  const settleSpoken: string[] = [];
  const showLeft: Array<{ id: string; line: string; leftAt: string }> = [];
  const toSpeak: Array<{ id: string; line: string; claimedAt?: string }> = [];
  const releaseDeferred: Array<{
    id: string;
    line: string;
    claimedAt?: string;
  }> = [];
  const gaveUp = input.settleGaveUp ?? new Set<string>();
  const nowMs = input.nowMs ?? Date.now();
  const deferredUntil = input.deferredUntil;

  for (const reminder of input.reminders) {
    if (input.spoken.has(reminder.id)) {
      // pending 补记中或已放弃：勿再走 settleSpoken（放弃仍靠 spoken 防重播）。
      if (
        !input.pendingSettleIds.has(reminder.id) &&
        !gaveUp.has(reminder.id)
      ) {
        settleSpoken.push(reminder.id);
      }
      continue;
    }

    if (input.handled.has(reminder.id)) continue;
    if (input.inFlight.has(reminder.id)) continue;
    if (input.pendingSettleIds.has(reminder.id)) continue;
    if (gaveUp.has(reminder.id)) continue;

    if (reminder.delivery === "left") {
      showLeft.push({
        id: reminder.id,
        line: reminder.line,
        leftAt: reminder.leftAt ?? "",
      });
      continue;
    }

    const line = reminder.line.trim();
    if (!line) continue;

    const until = deferredUntil?.get(reminder.id);
    if (until != null && nowMs < until) {
      releaseDeferred.push({
        id: reminder.id,
        line,
        claimedAt: reminder.claimedAt,
      });
      continue;
    }

    toSpeak.push({
      id: reminder.id,
      line,
      claimedAt: reminder.claimedAt,
    });
  }

  return { settleSpoken, showLeft, toSpeak, releaseDeferred };
}

/** deferred 成功后写入退避截止时间。 */
export function markDeferredBackoff(
  deferredUntil: Map<string, number>,
  id: string,
  nowMs: number,
  backoffMs: number = DEFERRED_BACKOFF_MS,
): void {
  deferredUntil.set(id, nowMs + backoffMs);
}

export type SpeakSettleOutcome = {
  markHandled: string[];
  markSpoken: string[];
  pendingSettle: PendingSettle[];
  clearInFlight: string[];
};

export function resolveAfterMentionDue(input: {
  ids: readonly string[];
  heard: boolean;
  settleSucceeded: ReadonlySet<string>;
  settleDeferred?: ReadonlySet<string>;
  settleStale?: ReadonlySet<string>;
  claimedAtById?: ReadonlyMap<string, string | undefined>;
}): SpeakSettleOutcome {
  const markSpoken = input.heard ? [...input.ids] : [];
  const markHandled: string[] = [];
  const pendingSettle: PendingSettle[] = [];
  const deferred = input.settleDeferred ?? new Set<string>();
  const stale = input.settleStale ?? new Set<string>();

  for (const id of input.ids) {
    if (input.settleSucceeded.has(id)) {
      markHandled.push(id);
      continue;
    }

    // deferred / stale：不挂 pending；stale 表示租约已易主，不得再 settle 完成新领取。
    if (deferred.has(id) || stale.has(id)) continue;

    pendingSettle.push({
      id,
      heard: input.heard,
      claimedAt: input.claimedAtById?.get(id),
    });
  }

  return {
    markHandled,
    markSpoken,
    pendingSettle,
    clearInFlight: [...input.ids],
  };
}

/**
 * mentionDue 抛错：视为未听到，必须立刻走 settle(heard=false) 释放 speaking，
 * 不得只靠 45s 回收。
 */
export function resolveMentionDueThrow(
  ids: readonly string[],
  claimedAtById?: ReadonlyMap<string, string | undefined>,
): {
  markHandled: string[];
  pendingSettle: PendingSettle[];
  clearInFlight: string[];
} {
  return {
    markHandled: [],
    pendingSettle: ids.map((id) => ({
      id,
      heard: false,
      claimedAt: claimedAtById?.get(id),
    })),
    clearInFlight: [...ids],
  };
}

/** settle HTTP 结果分类：成功 / 延期 / 陈旧租约 / 不确定失败。 */
export type SettleHttpKind =
  | "ok"
  | "deferred"
  | "stale"
  | "uncertain";

export function classifySettleHttpResult(input: {
  ok: boolean;
  status: number;
  deferred?: boolean;
  stale?: boolean;
}): SettleHttpKind {
  if (input.ok && input.deferred) return "deferred";
  if (input.ok) return "ok";
  if (input.status === 409 || input.stale) return "stale";
  return "uncertain";
}
