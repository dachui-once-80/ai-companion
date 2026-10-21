/**
 * consolidate HTTP 响应分类与永久失败批次暂停队列。
 * 终态成功 / 延迟重试 / 永久失败 / 可重试 —— 不得把 400 或畸形 200 当成成功。
 */

export type ConsolidationDialogueTurn = {
  role: "user" | "companion" | "overheard";
  text: string;
};

/** 与服务端 ConsolidationResult.saved 对齐（consolidate.ts）。 */
export const CONSOLIDATION_SAVED_KEYS = [
  "episodes",
  "impressions",
  "notes",
  "profile",
  "between",
  "closedBetween",
  "retired",
  "views",
  "unresolved",
  "question",
  "closedUnresolved",
  "closedQuestion",
] as const;

export type ConsolidationSavedSummary = {
  total: number;
  views: number;
  open: boolean;
  between: boolean;
};

export type ConsolidationHttpOutcome =
  | { kind: "success"; saved: ConsolidationSavedSummary }
  | { kind: "deferred"; retryAfterMs: number }
  | { kind: "permanent"; status: number; message: string }
  | { kind: "retryable"; status: number; message: string };

export type ConsolidationEnqueueFailureResult = {
  pendingDialogue: ConsolidationDialogueTurn[];
  pausedBatches: ConsolidationDialogueTurn[][];
  action: "park" | "restore_deferred" | "restore_backoff";
  retryAfterMs?: number;
};

/** 配额等：稍后再试，不得当作整理成功。 */
export class ConsolidationDeferred extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("consolidation deferred");
    this.retryAfterMs = retryAfterMs;
  }
}

/** 输入被拒绝等：保留批次但暂停，不自动退避空转。 */
export class ConsolidationPermanentError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function readRetryAfterMs(data: unknown): number {
  if (
    typeof data !== "object" ||
    data === null ||
    !("retryAfterMs" in data)
  ) {
    return 0;
  }

  const value = data.retryAfterMs;

  if (typeof value !== "number" || !Number.isFinite(value)) return 0;

  return Math.max(0, value);
}

function savedRecord(
  data: unknown,
): Record<string, unknown> | null {
  if (typeof data !== "object" || data === null || !("saved" in data)) {
    return null;
  }

  const saved = data.saved;

  if (typeof saved !== "object" || saved === null || Array.isArray(saved)) {
    return null;
  }

  const record = saved as Record<string, unknown>;

  for (const key of CONSOLIDATION_SAVED_KEYS) {
    const value = record[key];

    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
  }

  return record;
}

/** 契约：saved 须含服务端 12 个有限 number 字段（允许全 0）。 */
export function isConsolidationSuccessBody(data: unknown): boolean {
  return savedRecord(data) !== null;
}

export function summarizeConsolidationSaved(
  data: unknown,
): ConsolidationSavedSummary | null {
  const saved = savedRecord(data);

  if (!saved) return null;

  let total = 0;

  for (const key of [
    "episodes",
    "impressions",
    "notes",
    "profile",
    "between",
    "closedBetween",
    "retired",
    "views",
  ] as const) {
    total += saved[key] as number;
  }

  const part = (key: (typeof CONSOLIDATION_SAVED_KEYS)[number]): number =>
    saved[key] as number;

  return {
    total,
    views: part("views"),
    open:
      part("unresolved") +
        part("question") +
        part("closedUnresolved") +
        part("closedQuestion") >
      0,
    between: part("between") + part("closedBetween") > 0,
  };
}

/**
 * 永久：明确的坏请求 / 不可用资源。
 * 401/403：可重试（短暂鉴权），不进永久。
 * 408/429：可重试。
 */
function isPermanentHttpStatus(status: number): boolean {
  if (status === 400 || status === 404 || status === 422) return true;

  if (
    status === 401 ||
    status === 403 ||
    status === 408 ||
    status === 429
  ) {
    return false;
  }

  if (status >= 400 && status < 500) return true;

  return false;
}

/**
 * 根据 HTTP 状态与已解析 JSON 体分类。
 * body 在 JSON 解析失败时应传 undefined。
 */
export function classifyConsolidationHttp(
  status: number,
  ok: boolean,
  body: unknown,
): ConsolidationHttpOutcome {
  if (!ok) {
    if (isPermanentHttpStatus(status)) {
      return {
        kind: "permanent",
        status,
        message: `consolidation rejected: ${status}`,
      };
    }

    return {
      kind: "retryable",
      status,
      message: `consolidation failed: ${status}`,
    };
  }

  const retryAfterMs = readRetryAfterMs(body);

  if (retryAfterMs > 0) {
    return { kind: "deferred", retryAfterMs };
  }

  const saved = summarizeConsolidationSaved(body);

  if (!saved) {
    return {
      kind: "retryable",
      status,
      message: "consolidation response missing saved",
    };
  }

  return { kind: "success", saved };
}

/** 永久失败：整批进入暂停队列，不并入 pending（普通 flush 不会消费）。 */
export function parkPermanentConsolidationBatch(
  pausedBatches: ConsolidationDialogueTurn[][],
  batch: readonly ConsolidationDialogueTurn[],
): ConsolidationDialogueTurn[][] {
  if (batch.length === 0) return pausedBatches;

  return [...pausedBatches, [...batch]];
}

/**
 * enqueue 失败后的队列更新（纯函数，供 RealtimeClient 与测试共用）。
 * 永久 → park；可重试/延迟 → 回塞 pending 头部，保留期间新到达的对话。
 */
export function applyConsolidationEnqueueFailure(input: {
  batch: readonly ConsolidationDialogueTurn[];
  error: unknown;
  pendingDialogue: ConsolidationDialogueTurn[];
  pausedBatches: ConsolidationDialogueTurn[][];
}): ConsolidationEnqueueFailureResult {
  if (input.error instanceof ConsolidationPermanentError) {
    return {
      pendingDialogue: input.pendingDialogue,
      pausedBatches: parkPermanentConsolidationBatch(
        input.pausedBatches,
        input.batch,
      ),
      action: "park",
    };
  }

  const restored = [...input.batch, ...input.pendingDialogue];

  if (input.error instanceof ConsolidationDeferred) {
    return {
      pendingDialogue: restored,
      pausedBatches: input.pausedBatches,
      action: "restore_deferred",
      retryAfterMs: input.error.retryAfterMs,
    };
  }

  return {
    pendingDialogue: restored,
    pausedBatches: input.pausedBatches,
    action: "restore_backoff",
  };
}

/**
 * 显式恢复暂停批到 pending（本阶段不自动调用）。
 * 不与 paused 去重合并为同一引用；清空 paused。
 */
export function releasePausedConsolidationBatches(input: {
  pendingDialogue: ConsolidationDialogueTurn[];
  pausedBatches: ConsolidationDialogueTurn[][];
}): {
  pendingDialogue: ConsolidationDialogueTurn[];
  pausedBatches: ConsolidationDialogueTurn[][];
  releasedBatchCount: number;
} {
  if (input.pausedBatches.length === 0) {
    return {
      pendingDialogue: input.pendingDialogue,
      pausedBatches: input.pausedBatches,
      releasedBatchCount: 0,
    };
  }

  const released = input.pausedBatches.flat();

  return {
    pendingDialogue: [...released, ...input.pendingDialogue],
    pausedBatches: [],
    releasedBatchCount: input.pausedBatches.length,
  };
}
