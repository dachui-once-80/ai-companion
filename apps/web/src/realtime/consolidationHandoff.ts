/**
 * 内存对话批次 → outbox 安全交接（本步不发送、不 drain）。
 *
 * 生命周期约定：
 * 1. 调用方从 pendingDialogue splice 出 batch；
 * 2. 先用 dialogueWorthKeeping 过滤短对话（规则不变）；
 * 3. 调用 handOffDialogueBatchToOutbox；
 * 4. 仅当结果允许 removeFromPending 时才丢弃内存批次；
 * 5. 失败时保留 batchId + 已冻结 payload（若已算出）供重试。
 */

import {
  ConsolidationOutbox,
  ConsolidationOutboxConflictError,
  ConsolidationOutboxError,
  type ConsolidationOutboxItem,
} from "./consolidationOutbox.ts";
import {
  computeConsolidationPayloadHash,
  normalizeConsolidationOccurredOn,
  normalizeConsolidationTurnText,
  type ConsolidationPayloadTurn,
} from "./consolidationPayload.ts";
import { dialogueWorthKeeping, type DialogueBatchTurn } from "./dialogueBatchPolicy.ts";

export { dialogueWorthKeeping };
export type { DialogueBatchTurn };

/**
 * 首次规范化成功后冻结的最终 payload。
 * 重试必须原样复用；不得再用当前 todayLocal 重算。
 */
export type FrozenConsolidationPayload = {
  batchId: string;
  occurredOn: string;
  turns: ConsolidationPayloadTurn[];
  payloadHash: string;
};

export type HandOffDialogueBatchInput = {
  outbox: ConsolidationOutbox;
  /** 内存中的原始 turns（worth-keeping／失败恢复）；有 frozen 时仍用于诊断保留。 */
  turns: readonly DialogueBatchTurn[];
  /** 原始 occurredOn；仅无 frozen 时与 todayLocal 一起规范化。 */
  occurredOnRaw?: string;
  todayLocal: string;
  /**
   * 重试时传入上次失败返回的 batchId，保证稳定 ID。
   * 首次可省略，由 createBatchId 生成。
   */
  batchId?: string;
  /**
   * 已冻结的最终 payload。若提供则跳过 normalize／hash，
   * 且不得用当前 todayLocal 改写。
   */
  frozen?: FrozenConsolidationPayload;
  createBatchId?: () => string;
};

export type HandOffDialogueBatchResult =
  | {
      kind: "persisted";
      batchId: string;
      item: ConsolidationOutboxItem;
      removeFromPending: true;
      frozen: FrozenConsolidationPayload;
    }
  | {
      kind: "already_dead_letter";
      batchId: string;
      item: ConsolidationOutboxItem;
      /** 所有权在 outbox；不得自动 revive／重排到 pending。 */
      removeFromPending: true;
      frozen: FrozenConsolidationPayload;
    }
  | {
      kind: "skipped_not_worth_keeping";
      removeFromPending: false;
    }
  | {
      kind: "failed";
      batchId: string;
      error: ConsolidationOutboxError;
      removeFromPending: false;
      /** 供调用方保留的原始 turns。 */
      turns: DialogueBatchTurn[];
      /**
       * 已成功规范化并算出 hash 时必有；normalize 前失败则缺省。
       * 不得在缺省时凭空编造 hash。
       */
      frozen?: FrozenConsolidationPayload;
    }
  | {
      /**
       * add 已调用但未能确认信封里有没有这行。
       * 必须沿用 frozen，禁止退回无 batchId 的 pending。
       */
      kind: "uncertain";
      batchId: string;
      error: ConsolidationOutboxError;
      removeFromPending: false;
      turns: DialogueBatchTurn[];
      frozen: FrozenConsolidationPayload;
    };

function defaultCreateBatchId(): string {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return globalThis.crypto.randomUUID();
  }

  return `batch-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

function cloneFrozen(
  frozen: FrozenConsolidationPayload,
): FrozenConsolidationPayload {
  return {
    batchId: frozen.batchId,
    occurredOn: frozen.occurredOn,
    payloadHash: frozen.payloadHash,
    turns: frozen.turns.map((turn) => ({ role: turn.role, text: turn.text })),
  };
}

/** 拷贝失败时保留原对象，避免异常把已经算出的身份丢掉。 */
function safeCloneFrozen(
  frozen: FrozenConsolidationPayload,
): FrozenConsolidationPayload {
  try {
    return cloneFrozen(frozen);
  } catch (error) {
    console.warn(
      "[Memory] consolidation frozen clone failed; keeping the original identity:",
      error,
    );
    return frozen;
  }
}

function normalizeTurnsForOutbox(
  turns: readonly DialogueBatchTurn[],
): ConsolidationPayloadTurn[] {
  const normalized: ConsolidationPayloadTurn[] = [];

  for (const turn of turns) {
    if (
      turn.role !== "user" &&
      turn.role !== "companion" &&
      turn.role !== "overheard"
    ) {
      throw new ConsolidationOutboxError("invalid_input", "Invalid turn role");
    }

    if (typeof turn.text !== "string") {
      throw new ConsolidationOutboxError("invalid_input", "Invalid turn text");
    }

    const text = normalizeConsolidationTurnText(turn.text);

    if (text === null) continue;

    normalized.push({ role: turn.role, text });
  }

  if (!normalized.some((turn) => turn.role === "user" || turn.role === "overheard")) {
    throw new ConsolidationOutboxError(
      "invalid_input",
      "A user turn is required after normalization",
    );
  }

  return normalized;
}

/**
 * 解析最终 payload 身份。
 * - 有 frozen：原样复用（忽略 todayLocal）。
 * - 无 frozen：用 occurredOnRaw + todayLocal 规范化并算 hash（仅首次路径）。
 */
export async function resolveConsolidationPayloadIdentity(
  input: {
    turns: readonly DialogueBatchTurn[];
    occurredOnRaw?: string;
    todayLocal: string;
    batchId?: string;
    frozen?: FrozenConsolidationPayload;
    createBatchId?: () => string;
  },
): Promise<FrozenConsolidationPayload> {
  if (input.frozen) {
    const frozen = cloneFrozen(input.frozen);
    const requestedId = input.batchId?.trim();

    if (requestedId && requestedId !== frozen.batchId) {
      throw new ConsolidationOutboxError(
        "invalid_input",
        "frozen.batchId does not match batchId",
      );
    }

    if (
      typeof frozen.payloadHash !== "string" ||
      frozen.payloadHash.length !== 64
    ) {
      throw new ConsolidationOutboxError(
        "invalid_input",
        "frozen.payloadHash is invalid",
      );
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(frozen.occurredOn)) {
      throw new ConsolidationOutboxError(
        "invalid_input",
        "frozen.occurredOn is invalid",
      );
    }

    return frozen;
  }

  const batchId = input.batchId?.trim()
    ? input.batchId.trim()
    : (input.createBatchId ?? defaultCreateBatchId)();

  const occurredOn = normalizeConsolidationOccurredOn(
    input.occurredOnRaw,
    input.todayLocal,
  );
  const turns = normalizeTurnsForOutbox(input.turns);
  const payloadHash = await computeConsolidationPayloadHash(occurredOn, turns);

  return { batchId, occurredOn, turns, payloadHash };
}

/**
 * 将值得整理的批次写入 outbox。持久化成功（或已是同 ID 同 hash 的死信）才建议移出 pending。
 * 不发送 HTTP；不修改 dead_letter 状态。
 */
export async function handOffDialogueBatchToOutbox(
  input: HandOffDialogueBatchInput,
): Promise<HandOffDialogueBatchResult> {
  let frozen: FrozenConsolidationPayload | undefined = input.frozen
    ? safeCloneFrozen(input.frozen)
    : undefined;
  let batchId = frozen?.batchId || input.batchId?.trim() || "";
  let rawTurns: DialogueBatchTurn[] = [];
  let persistedItem: ConsolidationOutboxItem | null = null;
  let writeAttempted = false;

  try {
    rawTurns = input.turns.map((turn) => ({
      role: turn.role,
      text: turn.text,
    }));

    if (!dialogueWorthKeeping(rawTurns)) {
      return { kind: "skipped_not_worth_keeping", removeFromPending: false };
    }

    frozen = await resolveConsolidationPayloadIdentity({
      turns: rawTurns,
      occurredOnRaw: input.occurredOnRaw,
      todayLocal: input.todayLocal,
      batchId: input.batchId,
      frozen: input.frozen,
      createBatchId: input.createBatchId,
    });
    batchId = frozen.batchId;

    const existing = input.outbox.get(batchId);

    if (existing) {
      if (existing.payloadHash !== frozen.payloadHash) {
        throw new ConsolidationOutboxConflictError(
          "batchId was already used with a different payloadHash",
        );
      }

      if (existing.status === "dead_letter") {
        return {
          kind: "already_dead_letter",
          batchId,
          item: existing,
          removeFromPending: true,
          frozen: safeCloneFrozen(frozen),
        };
      }

      return {
        kind: "persisted",
        batchId,
        item: existing,
        removeFromPending: true,
        frozen: safeCloneFrozen(frozen),
      };
    }

    writeAttempted = true;
    const item = input.outbox.add({
      batchId,
      payloadHash: frozen.payloadHash,
      occurredOn: frozen.occurredOn,
      turns: frozen.turns,
      status: "pending",
    });
    persistedItem = item;

    if (item.status === "dead_letter") {
      return {
        kind: "already_dead_letter",
        batchId,
        item,
        removeFromPending: true,
        frozen: safeCloneFrozen(frozen),
      };
    }

    return {
      kind: "persisted",
      batchId,
      item,
      removeFromPending: true,
      frozen: safeCloneFrozen(frozen),
    };
  } catch (error) {
    // 读取原文失败且还没有 frozen 时，把原 turns 交回调用方，不在这里生成 batchId。
    if (
      !writeAttempted &&
      !frozen &&
      input.turns.length > 0 &&
      rawTurns.length === 0
    ) {
      throw error;
    }

    const wrapped =
      error instanceof ConsolidationOutboxError
        ? error
        : new ConsolidationOutboxError(
            "unavailable",
            error instanceof Error ? error.message : String(error),
          );
    const identity = frozen ? safeCloneFrozen(frozen) : undefined;
    const retainedTurns = identity ? identity.turns : rawTurns;

    if (persistedItem && identity) {
      return {
        kind: "persisted",
        batchId: identity.batchId,
        item: persistedItem,
        removeFromPending: true,
        frozen: identity,
      };
    }

    if (identity && writeAttempted) {
      try {
        const found = input.outbox.get(identity.batchId);
        if (found && found.payloadHash === identity.payloadHash) {
          return {
            kind: "persisted",
            batchId: identity.batchId,
            item: found,
            removeFromPending: true,
            frozen: identity,
          };
        }
      } catch (probeError) {
        console.warn(
          "[Memory] consolidation handoff could not verify outbox write:",
          probeError,
        );
        return {
          kind: "uncertain",
          batchId: identity.batchId,
          error: wrapped,
          removeFromPending: false,
          turns: retainedTurns,
          frozen: identity,
        };
      }

      return {
        kind: "failed",
        batchId: identity.batchId,
        error: wrapped,
        removeFromPending: false,
        turns: retainedTurns,
        frozen: identity,
      };
    }

    if (identity) {
      return {
        kind: "failed",
        batchId: identity.batchId,
        error: wrapped,
        removeFromPending: false,
        turns: retainedTurns,
        frozen: identity,
      };
    }

    if (!batchId) {
      batchId =
        input.batchId?.trim() ||
        (input.createBatchId ?? defaultCreateBatchId)();
    }

    return {
      kind: "failed",
      batchId,
      error: wrapped,
      removeFromPending: false,
      turns: rawTurns,
    };
  }
}

/** 交接失败或跳过短对话时：把 batch 放回 pending 头部。 */
export function restorePendingAfterFailedHandoff<T extends DialogueBatchTurn>(
  pending: readonly T[],
  batch: readonly T[],
): T[] {
  return [...batch, ...pending];
}

/**
 * 根据交接结果更新 pending。
 * - removeFromPending：pending 保持（batch 已 splice 且不再放回）
 * - 否则：batch 放回头部
 */
export function applyHandoffResultToPending<T extends DialogueBatchTurn>(
  pendingAfterSplice: readonly T[],
  batch: readonly T[],
  result: HandOffDialogueBatchResult,
): T[] {
  if (result.removeFromPending) {
    return [...pendingAfterSplice];
  }

  return restorePendingAfterFailedHandoff(pendingAfterSplice, batch);
}
