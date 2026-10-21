/**
 * RealtimeClient flush → outbox handoff 编排（1B-3C／1B-3D-0A／0B）。
 * 成功持久化后不调用网络发送／drain；失败粘住 batchId + 冻结 payload。
 */

import {
  applyHandoffResultToPending,
  handOffDialogueBatchToOutbox,
  type FrozenConsolidationPayload,
  type HandOffDialogueBatchResult,
} from "./consolidationHandoff.ts";
import type { ConsolidationOutbox } from "./consolidationOutbox.ts";
import { dialogueWorthKeeping, type DialogueBatchTurn } from "./dialogueBatchPolicy.ts";

export type FlushHandoffMode = "scheduled" | "hangup";

/** 软 cleanup 等待 hangupHandoffBoundary 的上限；超时 ≠ handoff 成功。 */
export const CLEANUP_HANDOFF_WAIT_MS = 5_000;

export type HandoffTailWaitStatus = "completed" | "timeout";

/**
 * 独占定时器状态（与 RealtimeClient.consolidateTimer 同形）。
 * 抽出供假时钟测「后一次 schedule 替换前一次」，生产行为不变。
 */
export type ExclusiveTimeoutState = {
  timerId: number | null;
};

export type ExclusiveTimeoutTimers = {
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
};

/**
 * 先 clear 再 set：保证同一 state 上至多一个未触发 timer。
 * RealtimeClient.scheduleConsolidation 的最小可测 seam。
 */
export function scheduleExclusiveTimeout(
  state: ExclusiveTimeoutState,
  delayMs: number,
  onFire: () => void,
  timers: ExclusiveTimeoutTimers,
): void {
  if (state.timerId !== null) {
    timers.clearTimeout(state.timerId);
  }

  state.timerId = timers.setTimeout(() => {
    state.timerId = null;
    onFire();
  }, delayMs);
}

/**
 * 有界等待 handoff 串行队列。超时不取消已在飞的 handoff；
 * 调用方不得把 timeout 当作 persist 成功。
 * 不保证硬关闭／崩溃时完成。
 */
export async function awaitHandoffTailWithTimeout(
  tail: Promise<unknown>,
  timeoutMs: number,
  timers?: {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
  },
): Promise<HandoffTailWaitStatus> {
  if (timeoutMs <= 0) return "timeout";

  const setTimer = timers?.setTimeout ?? setTimeout;
  const clearTimer = timers?.clearTimeout ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      Promise.resolve(tail).then(
        () => "completed" as const,
        () => "completed" as const,
      ),
      new Promise<HandoffTailWaitStatus>((resolve) => {
        timer = setTimer(() => resolve("timeout"), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimer(timer);
  }
}

/**
 * hangup 与 scheduled 在 handoff 失败后均走 failure_backoff，
 * 复用 scheduleConsolidation，避免 hangup 后无限期饥饿。
 */
export function followUpAfterHandoffFailure(
  mode: FlushHandoffMode,
): FlushHandoffDiagnostics["followUp"] {
  void mode;
  return "failure_backoff";
}

/**
 * 模拟 cleanup 对 handoff 的门闩（供离线测试；RealtimeClient 内联同等逻辑）。
 * handoffGuaranteed 仅在 wait 完成时为 true。
 */
export async function gateCleanupOnHandoffTail(input: {
  flush: () => void;
  tail: () => Promise<unknown>;
  timeoutMs?: number;
  timers?: {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
  };
}): Promise<{
  waitStatus: HandoffTailWaitStatus;
  handoffGuaranteed: boolean;
}> {
  input.flush();
  const waitStatus = await awaitHandoffTailWithTimeout(
    input.tail(),
    input.timeoutMs ?? CLEANUP_HANDOFF_WAIT_MS,
    input.timers,
  );

  return {
    waitStatus,
    handoffGuaranteed: waitStatus === "completed",
  };
}

/**
 * handoff 失败后待重试。
 * - `frozen`：1B-3D-0A 起必有（首次已算出 hash）；重试原样复用。
 * - `occurredOnRaw`：兼容旧 sticky（无 frozen）；派生时用 raw 自身作 todayLocal 锚点，
 *   不得用“当前日历日”凭空编 hash。
 */
export type StickyHandoffBatch = {
  batchId: string;
  turns: DialogueBatchTurn[];
  /** @deprecated 仅无 frozen 的旧条目兼容；新失败路径写 frozen。 */
  occurredOnRaw?: string;
  frozen?: FrozenConsolidationPayload;
};

export type FlushHandoffState = {
  pendingDialogue: DialogueBatchTurn[];
  handoffRetryQueue: StickyHandoffBatch[];
};

export type FlushHandoffDiagnostics = {
  attempts: Array<{
    source: "retry_queue" | "pending";
    batchId?: string;
    resultKind: HandOffDialogueBatchResult["kind"];
    errorCode?: string;
    errorMessage?: string;
  }>;
  /**
   * - failure_backoff：handoff 失败（scheduled 或 hangup），复用 scheduleConsolidation
   * - continue_pending：scheduled 成功且仍有 pending，短延迟再 flush
   * - none：不调度
   */
  followUp: "failure_backoff" | "continue_pending" | "none";
};

export type FlushDialogueThroughHandoffInput = {
  mode: FlushHandoffMode;
  outbox: ConsolidationOutbox;
  pendingDialogue: readonly DialogueBatchTurn[];
  handoffRetryQueue: readonly StickyHandoffBatch[];
  /** 日历日 YYYY-MM-DD；仅首次（无 frozen）规范化时使用。 */
  todayLocal: string;
  handOff?: typeof handOffDialogueBatchToOutbox;
  /**
   * 调用方可预先种入 not_attempted 记录。flush 抛错前会就地更新，
   * 外层用这份账恢复，而不是重放领取前的整份数组。
   */
  ledger?: FlushBatchLedger;
  /** 默认把未写入的 pending 批次放回队列；测试可注入一次失败。 */
  restoreDetached?: (
    pending: readonly DialogueBatchTurn[],
    detached: readonly DialogueBatchTurn[],
  ) => DialogueBatchTurn[];
};

export type FlushBatchPhase =
  | "not_attempted"
  | "failed"
  | "persisted"
  | "uncertain"
  | "dropped";

export type FlushBatchRecord = {
  source: "retry" | "pending";
  phase: FlushBatchPhase;
  batchId?: string;
  sticky: StickyHandoffBatch | null;
  turns: DialogueBatchTurn[];
};

export type FlushBatchLedger = {
  records: FlushBatchRecord[];
};

export type FlushDialogueThroughHandoffOutput = FlushHandoffState & {
  diagnostics: FlushHandoffDiagnostics;
};

/**
 * scheduled：不值得保留 → 放回 pending。
 * hangup：不值得保留 → 丢弃。
 */
export function decideShortDialogueAction(
  mode: FlushHandoffMode,
  batch: readonly DialogueBatchTurn[],
): "handoff" | "restore" | "drop" {
  if (dialogueWorthKeeping(batch)) return "handoff";
  return mode === "scheduled" ? "restore" : "drop";
}

/**
 * 领取当前 pending 缓冲区，换成空数组供 await 期间 pushDialogue 写入。
 * 不引入跨标签锁。
 */
export function claimPendingDialogueBuffer<T>(holder: {
  pendingDialogue: T[];
}): T[] {
  const claimed = holder.pendingDialogue;
  holder.pendingDialogue = [];
  return claimed;
}

/**
 * flush 产出的剩余 pending（旧批 restore／未处理）在前，
 * await 期间新写入的对话在后；不覆盖、不丢新对话。
 */
export function mergePendingAfterFlush<T>(
  flushOutputPending: readonly T[],
  arrivedDuringFlush: readonly T[],
): T[] {
  return [...flushOutputPending, ...arrivedDuringFlush];
}

function appendTurnsByIndex(
  target: DialogueBatchTurn[],
  source: readonly DialogueBatchTurn[],
): void {
  const length = source.length;

  for (let index = 0; index < length; index += 1) {
    target.push(source[index]!);
  }
}

/**
 * 把尚未持久化的批次放回 pending 前面。
 * 展开失败时按下标拷贝；下标也失败时保留 detached 原数组，避免静默丢掉。
 */
export function restoreDetachedPending(
  pending: readonly DialogueBatchTurn[],
  detached: readonly DialogueBatchTurn[],
): DialogueBatchTurn[] {
  try {
    return [...detached, ...pending];
  } catch (error) {
    console.warn(
      "[Memory] consolidation handoff restore copy failed; retrying by index:",
      error,
    );
    const restored: DialogueBatchTurn[] = [];

    try {
      appendTurnsByIndex(restored, detached);
      appendTurnsByIndex(restored, pending);
      return restored;
    } catch (indexError) {
      console.warn(
        "[Memory] consolidation handoff restore by index failed; keeping the detached batch:",
        indexError,
      );
      return detached as DialogueBatchTurn[];
    }
  }
}

export function materializeFlushLedger(ledger: FlushBatchLedger): {
  pendingDialogue: DialogueBatchTurn[];
  handoffRetryQueue: StickyHandoffBatch[];
} {
  const pendingDialogue: DialogueBatchTurn[] = [];
  const handoffRetryQueue: StickyHandoffBatch[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < ledger.records.length; index += 1) {
    const record = ledger.records[index]!;

    if (record.phase === "persisted" || record.phase === "dropped") continue;

    if (
      record.sticky &&
      (record.phase === "failed" ||
        record.phase === "uncertain" ||
        (record.source === "retry" && record.phase === "not_attempted"))
    ) {
      if (seen.has(record.sticky.batchId)) continue;
      seen.add(record.sticky.batchId);
      handoffRetryQueue.push(record.sticky);
      continue;
    }

    if (record.phase === "not_attempted") {
      appendTurnsByIndex(pendingDialogue, record.turns);
    }
  }

  return { pendingDialogue, handoffRetryQueue };
}

function seedLedger(input: FlushDialogueThroughHandoffInput): FlushBatchLedger {
  if (input.ledger && input.ledger.records.length > 0) return input.ledger;

  const ledger: FlushBatchLedger = input.ledger ?? { records: [] };
  ledger.records = [];

  for (let index = 0; index < input.handoffRetryQueue.length; index += 1) {
    const entry = input.handoffRetryQueue[index]!;
    ledger.records.push({
      source: "retry",
      phase: "not_attempted",
      batchId: entry.batchId,
      sticky: entry,
      turns: [...entry.turns],
    });
  }

  ledger.records.push({
    source: "pending",
    phase: "not_attempted",
    sticky: null,
    turns: [...input.pendingDialogue],
  });

  return ledger;
}

function stickyFromResult(
  result: Extract<
    HandOffDialogueBatchResult,
    { kind: "failed" | "uncertain" }
  >,
  occurredOnRawFallback: string,
): StickyHandoffBatch {
  return {
    batchId: result.batchId,
    turns: result.turns,
    occurredOnRaw: result.frozen?.occurredOn ?? occurredOnRawFallback,
    frozen: result.frozen,
  };
}

/**
 * 为 sticky 重试构造 handOff 输入。
 * - 有 frozen：原样复用，todayLocal 仅占位。
 * - 无 frozen 但有 occurredOnRaw：用 raw 作 todayLocal 锚点确定性派生（兼容旧 RAM sticky）。
 * - 两者皆无：不可证明身份 → 交给 handOff 用非法路径失败（调用方应避免）。
 */
function handOffInputForSticky(
  entry: StickyHandoffBatch,
  outbox: ConsolidationOutbox,
  sessionTodayLocal: string,
): Parameters<typeof handOffDialogueBatchToOutbox>[0] {
  if (entry.frozen) {
    return {
      outbox,
      turns: entry.turns,
      batchId: entry.frozen.batchId,
      frozen: entry.frozen,
      // 占位；resolve 有 frozen 时忽略
      todayLocal: entry.frozen.occurredOn,
      occurredOnRaw: entry.frozen.occurredOn,
    };
  }

  if (entry.occurredOnRaw) {
    return {
      outbox,
      turns: entry.turns,
      batchId: entry.batchId,
      occurredOnRaw: entry.occurredOnRaw,
      // 兼容：不得用 session 当前日重算；以冻结 raw 为锚
      todayLocal: entry.occurredOnRaw,
    };
  }

  return {
    outbox,
    turns: entry.turns,
    batchId: entry.batchId,
    todayLocal: sessionTodayLocal,
  };
}

function attemptDiagnostics(
  result: HandOffDialogueBatchResult,
): Omit<FlushHandoffDiagnostics["attempts"][number], "source"> {
  return {
    batchId:
      result.kind === "failed" ||
      result.kind === "uncertain" ||
      result.kind === "persisted" ||
      result.kind === "already_dead_letter"
        ? result.batchId
        : undefined,
    resultKind: result.kind,
    errorCode:
      result.kind === "failed" || result.kind === "uncertain"
        ? result.error.code
        : undefined,
    errorMessage:
      result.kind === "failed" || result.kind === "uncertain"
        ? result.error.message
        : undefined,
  };
}

/**
 * 先排空 handoffRetryQueue（稳定冻结 payload），再处理一次 splice 出的 pending 批次。
 * 每个批次单独记账。已确认写入的批次不再回到 pending。
 */
export async function flushDialogueThroughHandoff(
  input: FlushDialogueThroughHandoffInput,
): Promise<FlushDialogueThroughHandoffOutput> {
  const handOff = input.handOff ?? handOffDialogueBatchToOutbox;
  const restore = input.restoreDetached ?? restoreDetachedPending;
  const ledger = seedLedger(input);
  const attempts: FlushHandoffDiagnostics["attempts"] = [];
  let inflight: {
    record: FlushBatchRecord;
    detached: DialogueBatchTurn[];
  } | null = null;

  const pendingRecord = (): FlushBatchRecord | null => {
    for (let index = 0; index < ledger.records.length; index += 1) {
      const record = ledger.records[index]!;
      if (record.source === "pending") return record;
    }
    return null;
  };

  const publish = (
    followUp: FlushHandoffDiagnostics["followUp"],
  ): FlushDialogueThroughHandoffOutput => {
    const queues = materializeFlushLedger(ledger);
    return {
      pendingDialogue: queues.pendingDialogue,
      handoffRetryQueue: queues.handoffRetryQueue,
      diagnostics: { attempts, followUp },
    };
  };

  const keepDetached = (): void => {
    if (!inflight || inflight.record.phase !== "not_attempted") return;
    const detached = inflight.detached;

    try {
      inflight.record.turns = restore(inflight.record.turns, detached);
      return;
    } catch (error) {
      console.warn("[Memory] consolidation handoff restore failed:", error);
    }

    // 恢复函数可能已经改过 record.turns 再抛错。用 detached 原批次覆盖，
    // 不要把整批再拼到半成品后面。
    try {
      inflight.record.turns = restoreDetachedPending([], detached);
    } catch (fallbackError) {
      console.warn(
        "[Memory] consolidation handoff restore fallback failed; keeping detached turns:",
        fallbackError,
      );
      inflight.record.turns = detached;
    }
  };

  try {
    for (let index = 0; index < ledger.records.length; index += 1) {
      const record = ledger.records[index]!;
      if (record.source !== "retry" || !record.sticky) continue;
      if (record.phase !== "not_attempted") continue;

      const entry = record.sticky;
      let result: HandOffDialogueBatchResult;

      try {
        result = await handOff(
          handOffInputForSticky(entry, input.outbox, input.todayLocal),
        );
      } catch (error) {
        // add() 尚未返回结果。保持 not_attempted 和原 sticky，不能标成 uncertain。
        console.warn(
          "[Memory] consolidation handoff flush failed; restoring unpersisted dialogue:",
          error,
        );
        keepDetached();
        return publish(followUpAfterHandoffFailure(input.mode));
      }

      if (result.removeFromPending) {
        record.phase = "persisted";
        record.batchId = result.batchId;
      }

      attempts.push({
        source: "retry_queue",
        ...attemptDiagnostics(result),
      });

      if (result.removeFromPending) continue;

      if (result.kind === "failed" || result.kind === "uncertain") {
        const rawFallback =
          entry.occurredOnRaw ??
          entry.frozen?.occurredOn ??
          input.todayLocal;
        record.sticky = stickyFromResult(result, rawFallback);
        record.batchId = record.sticky.batchId;
        record.phase = result.kind === "uncertain" ? "uncertain" : "failed";
        return publish(followUpAfterHandoffFailure(input.mode));
      }

      if (input.mode === "scheduled") {
        const pending = pendingRecord();
        if (pending && pending.phase === "not_attempted") {
          pending.turns = applyHandoffResultToPending(
            pending.turns,
            entry.turns,
            result,
          );
        }
      }
      record.phase = "dropped";
    }

    const pending = pendingRecord();
    if (!pending || pending.phase !== "not_attempted") {
      return publish("none");
    }

    const batch = pending.turns.splice(0);
    inflight = { record: pending, detached: batch };
    const decision = decideShortDialogueAction(input.mode, batch);

    if (decision === "restore") {
      pending.turns = restore(pending.turns, batch);
      inflight = null;
      return publish("none");
    }

    if (decision === "drop" || batch.length === 0) {
      pending.phase = "dropped";
      inflight = null;
      return publish("none");
    }

    const occurredOnRaw = input.todayLocal;
    let result: HandOffDialogueBatchResult;

    try {
      result = await handOff({
        outbox: input.outbox,
        turns: batch,
        occurredOnRaw,
        todayLocal: input.todayLocal,
      });
    } catch (error) {
      console.warn(
        "[Memory] consolidation handoff flush failed; restoring unpersisted dialogue:",
        error,
      );
      keepDetached();
      return publish(followUpAfterHandoffFailure(input.mode));
    }

    if (result.removeFromPending) {
      pending.phase = "persisted";
      pending.batchId = result.batchId;
      inflight = null;
    }

    attempts.push({
      source: "pending",
      ...attemptDiagnostics(result),
    });

    if (result.removeFromPending) {
      const remaining = pending.turns.length > 0;
      return publish(
        input.mode === "scheduled" && remaining ? "continue_pending" : "none",
      );
    }

    if (result.kind === "failed" || result.kind === "uncertain") {
      const sticky = stickyFromResult(result, occurredOnRaw);
      pending.sticky = sticky;
      pending.batchId = sticky.batchId;
      pending.phase = result.kind === "uncertain" ? "uncertain" : "failed";
      pending.turns = [];
      inflight = null;
      return publish(followUpAfterHandoffFailure(input.mode));
    }

    if (input.mode === "scheduled") {
      pending.turns = applyHandoffResultToPending([], batch, result);
    } else {
      pending.phase = "dropped";
      pending.turns = [];
    }
    inflight = null;

    return publish("none");
  } catch (error) {
    console.warn(
      "[Memory] consolidation handoff flush failed; restoring unpersisted dialogue:",
      error,
    );
    keepDetached();
    return publish(followUpAfterHandoffFailure(input.mode));
  }
}
