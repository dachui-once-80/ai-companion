/**
 * 1B-3C／1B-3D-0A：flush → handoff 编排离线测试（无 RealtimeClient 网络／无正式库）。
 * 覆盖冻结 payload（P1）、claim/merge（P2）、短对话与冲突。
 */
import assert from "node:assert/strict";
import {
  claimPendingDialogueBuffer,
  decideShortDialogueAction,
  flushDialogueThroughHandoff,
  mergePendingAfterFlush,
  type StickyHandoffBatch,
} from "../src/realtime/consolidationFlushHandoff.ts";
import {
  handOffDialogueBatchToOutbox,
  resolveConsolidationPayloadIdentity,
} from "../src/realtime/consolidationHandoff.ts";
import {
  CONSOLIDATION_OUTBOX_MAX_ITEMS,
  CONSOLIDATION_OUTBOX_STORAGE_KEY,
  ConsolidationOutbox,
  ConsolidationOutboxCapacityError,
  ConsolidationOutboxConflictError,
  ConsolidationOutboxCorruptError,
  ConsolidationOutboxUnavailableError,
  createMemoryOutboxStorage,
} from "../src/realtime/consolidationOutbox.ts";

const TODAY = "2026-10-20";
const PLUS_THREE = "2026-10-23";
const KEEP = [
  { role: "user" as const, text: "我周末去看了展，记得一下" },
  { role: "companion" as const, text: "好，记下了" },
];
const SHORT = [{ role: "user" as const, text: "天气怎么样" }];
const NEWER = [
  { role: "user" as const, text: "这是后来才说的话要记住" },
  { role: "companion" as const, text: "好" },
];

let clock = 0;

function nowIso(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 9, 20, 12, 0, 0, clock)).toISOString();
}

function makeOutbox(storage = createMemoryOutboxStorage()) {
  return new ConsolidationOutbox({ storage, now: nowIso });
}

function failingStorage(base = createMemoryOutboxStorage()) {
  return {
    base,
    storage: {
      getItem: (key: string) => base.getItem(key),
      removeItem: (key: string) => base.removeItem(key),
      setItem() {
        throw new Error("QuotaExceededError");
      },
    },
  };
}

// --- T5：短对话 scheduled 放回／hangup 丢弃 ---
{
  assert.equal(decideShortDialogueAction("scheduled", SHORT), "restore");
  assert.equal(decideShortDialogueAction("hangup", SHORT), "drop");
  assert.equal(decideShortDialogueAction("scheduled", KEEP), "handoff");
  assert.equal(decideShortDialogueAction("hangup", KEEP), "handoff");

  const outbox = makeOutbox();
  const scheduledShort = await flushDialogueThroughHandoff({
    mode: "scheduled",
    outbox,
    pendingDialogue: SHORT,
    handoffRetryQueue: [],
    todayLocal: TODAY,
  });
  assert.deepEqual(scheduledShort.pendingDialogue, SHORT);
  assert.equal(outbox.list().length, 0);

  const hangupShort = await flushDialogueThroughHandoff({
    mode: "hangup",
    outbox,
    pendingDialogue: SHORT,
    handoffRetryQueue: [],
    todayLocal: TODAY,
  });
  assert.equal(hangupShort.pendingDialogue.length, 0);
  assert.equal(outbox.list().length, 0);
}

// --- handoff 成功：离开 pending；outbox 有条 ---
{
  const outbox = makeOutbox();
  const output = await flushDialogueThroughHandoff({
    mode: "scheduled",
    outbox,
    pendingDialogue: KEEP,
    handoffRetryQueue: [],
    todayLocal: TODAY,
  });

  assert.equal(output.diagnostics.attempts[0]?.resultKind, "persisted");
  assert.deepEqual(output.pendingDialogue, []);
  assert.equal(output.handoffRetryQueue.length, 0);
  assert.equal(outbox.list().length, 1);
  assert.equal(outbox.list()[0]?.occurredOn, TODAY);
}

// --- hangup：值得保留则 handoff ---
{
  const outbox = makeOutbox();
  const kept = await flushDialogueThroughHandoff({
    mode: "hangup",
    outbox,
    pendingDialogue: KEEP,
    handoffRetryQueue: [],
    todayLocal: TODAY,
  });
  assert.equal(kept.pendingDialogue.length, 0);
  assert.equal(outbox.list().length, 1);
  assert.equal(kept.diagnostics.followUp, "none");
}

// --- T1：失败后 todayLocal +3 天；batchId／occurredOn／turns／payloadHash 完全一致 ---
{
  const { storage } = failingStorage();
  const outbox = makeOutbox(storage);
  const first = await flushDialogueThroughHandoff({
    mode: "scheduled",
    outbox,
    pendingDialogue: KEEP,
    handoffRetryQueue: [],
    todayLocal: TODAY,
  });

  assert.equal(first.diagnostics.attempts[0]?.resultKind, "failed");
  assert.equal(first.handoffRetryQueue.length, 1);
  const sticky = first.handoffRetryQueue[0]!;
  assert.ok(sticky.frozen, "first failure must freeze payload");
  assert.equal(sticky.frozen!.occurredOn, TODAY);
  assert.equal(sticky.frozen!.batchId, sticky.batchId);
  assert.deepEqual(sticky.turns, KEEP);

  const frozenSnapshot = {
    batchId: sticky.frozen!.batchId,
    occurredOn: sticky.frozen!.occurredOn,
    payloadHash: sticky.frozen!.payloadHash,
    turns: sticky.frozen!.turns.map((t) => ({ ...t })),
  };

  // 即便 todayLocal 前进 3 天，重试仍复用 frozen（不得重算）
  const second = await flushDialogueThroughHandoff({
    mode: "scheduled",
    outbox,
    pendingDialogue: [],
    handoffRetryQueue: first.handoffRetryQueue,
    todayLocal: PLUS_THREE,
  });

  assert.equal(second.handoffRetryQueue.length, 1);
  const again = second.handoffRetryQueue[0]!;
  assert.equal(again.batchId, frozenSnapshot.batchId);
  assert.ok(again.frozen);
  assert.equal(again.frozen!.batchId, frozenSnapshot.batchId);
  assert.equal(again.frozen!.occurredOn, frozenSnapshot.occurredOn);
  assert.equal(again.frozen!.payloadHash, frozenSnapshot.payloadHash);
  assert.deepEqual(again.frozen!.turns, frozenSnapshot.turns);
  assert.deepEqual(again.turns, KEEP);

  // 与“若用 PLUS_THREE 重算”不同，证明未漂移
  const drifted = await resolveConsolidationPayloadIdentity({
    turns: KEEP,
    occurredOnRaw: TODAY,
    todayLocal: PLUS_THREE,
    batchId: frozenSnapshot.batchId,
  });
  assert.notEqual(
    drifted.occurredOn,
    frozenSnapshot.occurredOn,
    "control: +3d without freeze would rewrite occurredOn",
  );
  assert.notEqual(drifted.payloadHash, frozenSnapshot.payloadHash);
}

// --- 兼容：旧 sticky 仅有 occurredOnRaw（无 frozen）→ 以 raw 为锚派生，不用 session 日 ---
{
  const { storage } = failingStorage();
  const outbox = makeOutbox(storage);
  const legacy: StickyHandoffBatch = {
    batchId: "legacy-0000-0000-4000-8000-000000000001",
    turns: KEEP,
    occurredOnRaw: TODAY,
  };

  const expected = await resolveConsolidationPayloadIdentity({
    turns: KEEP,
    occurredOnRaw: TODAY,
    todayLocal: TODAY,
    batchId: legacy.batchId,
  });

  const output = await flushDialogueThroughHandoff({
    mode: "scheduled",
    outbox,
    pendingDialogue: [],
    handoffRetryQueue: [legacy],
    todayLocal: PLUS_THREE,
  });

  assert.equal(output.handoffRetryQueue.length, 1);
  const sticky = output.handoffRetryQueue[0]!;
  assert.ok(sticky.frozen, "compat retry should attach proven frozen");
  assert.equal(sticky.frozen!.occurredOn, expected.occurredOn);
  assert.equal(sticky.frozen!.payloadHash, expected.payloadHash);
  assert.equal(sticky.frozen!.batchId, legacy.batchId);
}

// --- T2／T6：claim + merge；await 期间新对话保留；重复 flush 不覆盖 ---
{
  const holder = {
    pendingDialogue: [...KEEP],
  };
  const claimed = claimPendingDialogueBuffer(holder);
  assert.deepEqual(claimed, KEEP);
  assert.deepEqual(holder.pendingDialogue, []);

  holder.pendingDialogue.push(...NEWER);
  const merged = mergePendingAfterFlush(
    [{ role: "user" as const, text: "restore-old" }],
    holder.pendingDialogue,
  );
  assert.deepEqual(merged, [
    { role: "user", text: "restore-old" },
    ...NEWER,
  ]);

  // 模拟 enqueueHandoffFlush：领取 → 慢 handoff → 期间 push → merge
  const live = {
    pendingDialogue: [...KEEP] as Array<{
      role: "user" | "companion" | "overheard";
      text: string;
    }>,
  };
  const taken = claimPendingDialogueBuffer(live);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const flushPromise = (async () => {
    const output = await flushDialogueThroughHandoff({
      mode: "scheduled",
      outbox: makeOutbox(failingStorage().storage),
      pendingDialogue: taken,
      handoffRetryQueue: [],
      todayLocal: TODAY,
      handOff: async (input) => {
        await gate;
        return handOffDialogueBatchToOutbox(input);
      },
    });
    live.pendingDialogue = mergePendingAfterFlush(
      output.pendingDialogue,
      live.pendingDialogue,
    );
    return output;
  })();

  live.pendingDialogue.push(...NEWER);
  release();
  const output = await flushPromise;

  assert.equal(output.handoffRetryQueue.length, 1);
  assert.deepEqual(output.handoffRetryQueue[0]!.turns, KEEP);
  assert.deepEqual(live.pendingDialogue, NEWER);

  // T6：再 flush 一次领取 NEWER，不重复吞掉 sticky／不丢队列
  const taken2 = claimPendingDialogueBuffer(live);
  assert.deepEqual(taken2, NEWER);
  assert.deepEqual(live.pendingDialogue, []);
  const second = await flushDialogueThroughHandoff({
    mode: "scheduled",
    outbox: makeOutbox(failingStorage().storage),
    pendingDialogue: taken2,
    handoffRetryQueue: output.handoffRetryQueue,
    todayLocal: TODAY,
  });
  // sticky 仍失败在前；NEWER 因失败停后续应仍在 pending
  assert.equal(second.handoffRetryQueue.length, 1);
  assert.equal(second.handoffRetryQueue[0]!.batchId, output.handoffRetryQueue[0]!.batchId);
  assert.deepEqual(second.pendingDialogue, NEWER);
}

// --- T3：旧批失败 + 新对话同时到达；两者保留，旧身份不变 ---
{
  const live = {
    pendingDialogue: [...KEEP] as Array<{
      role: "user" | "companion" | "overheard";
      text: string;
    }>,
  };
  const taken = claimPendingDialogueBuffer(live);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const flushPromise = (async () => {
    const output = await flushDialogueThroughHandoff({
      mode: "scheduled",
      outbox: makeOutbox(failingStorage().storage),
      pendingDialogue: taken,
      handoffRetryQueue: [],
      todayLocal: TODAY,
      handOff: async (input) => {
        await gate;
        return handOffDialogueBatchToOutbox(input);
      },
    });
    live.pendingDialogue = mergePendingAfterFlush(
      output.pendingDialogue,
      live.pendingDialogue,
    );
    return output;
  })();

  live.pendingDialogue.push(...NEWER);
  release();
  const output = await flushPromise;
  const frozenId = output.handoffRetryQueue[0]!.frozen!.batchId;
  const frozenHash = output.handoffRetryQueue[0]!.frozen!.payloadHash;

  assert.deepEqual(live.pendingDialogue, NEWER);
  assert.equal(output.handoffRetryQueue[0]!.frozen!.occurredOn, TODAY);

  const retry = await flushDialogueThroughHandoff({
    mode: "scheduled",
    outbox: makeOutbox(failingStorage().storage),
    pendingDialogue: live.pendingDialogue,
    handoffRetryQueue: output.handoffRetryQueue,
    todayLocal: PLUS_THREE,
  });
  assert.equal(retry.handoffRetryQueue[0]!.batchId, frozenId);
  assert.equal(retry.handoffRetryQueue[0]!.frozen!.payloadHash, frozenHash);
  assert.deepEqual(retry.pendingDialogue, NEWER);
}

// --- T4：同 ID 异 hash；原 outbox 不变；可诊断；不静默丢 ---
{
  const outbox = makeOutbox();
  const first = await flushDialogueThroughHandoff({
    mode: "scheduled",
    outbox,
    pendingDialogue: KEEP,
    handoffRetryQueue: [],
    todayLocal: TODAY,
  });
  assert.equal(first.diagnostics.attempts[0]?.resultKind, "persisted");
  const existingId = outbox.list()[0]!.batchId;
  const snapshot = outbox.get(existingId)!;
  const other = [
    { role: "user" as const, text: "完全不同的内容也要记住哦" },
    { role: "companion" as const, text: "换了" },
  ];
  const otherFrozen = await resolveConsolidationPayloadIdentity({
    turns: other,
    occurredOnRaw: TODAY,
    todayLocal: TODAY,
    batchId: existingId,
  });
  assert.notEqual(otherFrozen.payloadHash, snapshot.payloadHash);

  const sticky: StickyHandoffBatch = {
    batchId: existingId,
    turns: other,
    frozen: otherFrozen,
  };

  const output = await flushDialogueThroughHandoff({
    mode: "scheduled",
    outbox,
    pendingDialogue: [],
    handoffRetryQueue: [sticky],
    todayLocal: TODAY,
  });

  assert.equal(output.diagnostics.attempts[0]?.resultKind, "failed");
  assert.equal(
    output.diagnostics.attempts[0]?.errorCode,
    new ConsolidationOutboxConflictError("x").code,
  );
  assert.deepEqual(output.handoffRetryQueue[0]!.turns, other);
  assert.equal(output.handoffRetryQueue[0]!.frozen!.payloadHash, otherFrozen.payloadHash);
  const after = outbox.get(existingId)!;
  assert.equal(after.payloadHash, snapshot.payloadHash);
  assert.deepEqual(after.turns, snapshot.turns);
}

// --- storage／容量／损坏：保留 sticky + frozen ---
{
  const { storage, base } = failingStorage();
  const outbox = makeOutbox(storage);
  const output = await flushDialogueThroughHandoff({
    mode: "scheduled",
    outbox,
    pendingDialogue: KEEP,
    handoffRetryQueue: [],
    todayLocal: TODAY,
  });
  assert.equal(output.diagnostics.attempts[0]?.errorCode, "unavailable");
  assert.ok(output.handoffRetryQueue[0]!.frozen);
  assert.equal(base.store.has(CONSOLIDATION_OUTBOX_STORAGE_KEY), false);
}

{
  const storage = createMemoryOutboxStorage();
  const outbox = makeOutbox(storage);
  for (let i = 0; i < CONSOLIDATION_OUTBOX_MAX_ITEMS; i += 1) {
    outbox.add({
      batchId: `full-${String(i).padStart(4, "0")}-0000-4000-8000-000000000000`,
      payloadHash: "a".repeat(64),
      occurredOn: TODAY,
      turns: [{ role: "user", text: `占位${i}` }],
    });
  }
  const before = storage.store.get(CONSOLIDATION_OUTBOX_STORAGE_KEY)!;
  const output = await flushDialogueThroughHandoff({
    mode: "scheduled",
    outbox,
    pendingDialogue: KEEP,
    handoffRetryQueue: [],
    todayLocal: TODAY,
  });
  assert.equal(
    output.diagnostics.attempts[0]?.errorCode,
    new ConsolidationOutboxCapacityError("x").code,
  );
  assert.ok(output.handoffRetryQueue[0]!.frozen);
  assert.equal(storage.store.get(CONSOLIDATION_OUTBOX_STORAGE_KEY), before);
}

{
  const storage = createMemoryOutboxStorage({
    [CONSOLIDATION_OUTBOX_STORAGE_KEY]: "{broken",
  });
  const outbox = makeOutbox(storage);
  const output = await flushDialogueThroughHandoff({
    mode: "hangup",
    outbox,
    pendingDialogue: KEEP,
    handoffRetryQueue: [],
    todayLocal: TODAY,
  });
  assert.equal(
    output.diagnostics.attempts[0]?.errorCode,
    new ConsolidationOutboxCorruptError("x").code,
  );
  assert.ok(output.handoffRetryQueue[0]!.frozen);
  assert.equal(storage.store.get(CONSOLIDATION_OUTBOX_STORAGE_KEY), "{broken");
}

// --- 同批 retry 幂等（有 frozen）：不重复 outbox 条目 ---
{
  const outbox = makeOutbox();
  const persisted = await flushDialogueThroughHandoff({
    mode: "scheduled",
    outbox,
    pendingDialogue: KEEP,
    handoffRetryQueue: [],
    todayLocal: TODAY,
  });
  assert.equal(persisted.diagnostics.attempts[0]?.resultKind, "persisted");
  const item = outbox.list()[0]!;
  const sticky: StickyHandoffBatch = {
    batchId: item.batchId,
    turns: KEEP,
    frozen: {
      batchId: item.batchId,
      occurredOn: item.occurredOn,
      turns: item.turns,
      payloadHash: item.payloadHash,
    },
  };
  const b = await flushDialogueThroughHandoff({
    mode: "scheduled",
    outbox,
    pendingDialogue: [],
    handoffRetryQueue: [sticky],
    todayLocal: PLUS_THREE,
  });
  assert.equal(b.diagnostics.attempts[0]?.resultKind, "persisted");
  assert.equal(b.handoffRetryQueue.length, 0);
  assert.equal(outbox.list().length, 1);
  assert.equal(outbox.list()[0]!.occurredOn, TODAY);
}

// --- 失败停后续：retry 成功后才处理 pending ---
{
  const base = createMemoryOutboxStorage();
  let fail = true;
  const storage = {
    getItem: (key: string) => base.getItem(key),
    removeItem: (key: string) => base.removeItem(key),
    setItem(key: string, value: string) {
      if (fail) throw new ConsolidationOutboxUnavailableError("full");
      base.setItem(key, value);
    },
  };
  const outbox = makeOutbox(storage);
  const first = await flushDialogueThroughHandoff({
    mode: "scheduled",
    outbox,
    pendingDialogue: KEEP,
    handoffRetryQueue: [],
    todayLocal: TODAY,
  });
  assert.equal(first.handoffRetryQueue.length, 1);
  const frozenHash = first.handoffRetryQueue[0]!.frozen!.payloadHash;

  fail = false;
  const second = await flushDialogueThroughHandoff({
    mode: "scheduled",
    outbox,
    pendingDialogue: NEWER,
    handoffRetryQueue: first.handoffRetryQueue,
    todayLocal: PLUS_THREE,
  });

  assert.equal(second.diagnostics.attempts[0]?.source, "retry_queue");
  assert.equal(second.handoffRetryQueue.length, 0);
  assert.equal(outbox.list().length, 2);
  assert.equal(outbox.list()[0]!.payloadHash, frozenHash);
  assert.equal(outbox.list()[0]!.occurredOn, TODAY);
  assert.deepEqual(second.pendingDialogue, []);
}

console.log("[consolidation-flush-handoff] ok");
