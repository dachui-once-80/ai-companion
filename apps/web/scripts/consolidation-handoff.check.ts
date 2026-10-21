/**
 * outbox 交接（无网络／无正式库）：先持久化再移出 pending。
 */
import assert from "node:assert/strict";
import {
  applyHandoffResultToPending,
  dialogueWorthKeeping,
  handOffDialogueBatchToOutbox,
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
const HASH_READY_TURNS = [
  { role: "user" as const, text: "我周末去看了展，记得一下" },
  { role: "companion" as const, text: "好，记下了" },
];

let clock = 0;

function nowIso(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 9, 20, 12, 0, 0, clock)).toISOString();
}

function makeOutbox(storage = createMemoryOutboxStorage()) {
  return new ConsolidationOutbox({ storage, now: nowIso });
}

// --- 短对话规则未变 ---
{
  assert.equal(
    dialogueWorthKeeping([{ role: "user", text: "天气怎么样" }]),
    false,
  );
  assert.equal(dialogueWorthKeeping(HASH_READY_TURNS), true);
}

// --- 1) 正常交接：先持久化，再允许移出内存 ---
{
  const storage = createMemoryOutboxStorage();
  const outbox = makeOutbox(storage);
  let pending = [...HASH_READY_TURNS, { role: "user" as const, text: "后面还有一句" }];
  const batch = pending.splice(0, 2);

  const result = await handOffDialogueBatchToOutbox({
    outbox,
    turns: batch,
    occurredOnRaw: TODAY,
    todayLocal: TODAY,
    createBatchId: () => "handoff0-0000-4000-8000-000000000001",
  });

  assert.equal(result.kind, "persisted");
  assert.equal(result.removeFromPending, true);
  assert.ok(storage.store.has(CONSOLIDATION_OUTBOX_STORAGE_KEY));
  assert.equal(outbox.list().length, 1);

  pending = applyHandoffResultToPending(pending, batch, result);
  assert.deepEqual(pending, [{ role: "user", text: "后面还有一句" }]);
  assert.equal(outbox.get("handoff0-0000-4000-8000-000000000001")?.status, "pending");
}

// --- 2) Storage 写入失败：内存批次仍完整 ---
{
  const base = createMemoryOutboxStorage();
  const storage = {
    getItem: (key: string) => base.getItem(key),
    removeItem: (key: string) => base.removeItem(key),
    setItem() {
      throw new Error("QuotaExceededError");
    },
  };
  const outbox = makeOutbox(storage);
  let pending: typeof HASH_READY_TURNS = [];
  const batch = [...HASH_READY_TURNS];

  const result = await handOffDialogueBatchToOutbox({
    outbox,
    turns: batch,
    occurredOnRaw: TODAY,
    todayLocal: TODAY,
    createBatchId: () => "handoff0-0000-4000-8000-000000000002",
  });

  assert.equal(result.kind, "failed");
  assert.equal(result.removeFromPending, false);
  if (result.kind === "failed") {
    assert.ok(result.error instanceof ConsolidationOutboxUnavailableError);
  }
  pending = applyHandoffResultToPending(pending, batch, result);
  assert.deepEqual(pending, HASH_READY_TURNS);
  assert.equal(base.store.has(CONSOLIDATION_OUTBOX_STORAGE_KEY), false);
}

// --- 3a) 容量不足：内存仍在 ---
{
  const storage = createMemoryOutboxStorage();
  const outbox = makeOutbox(storage);

  for (let i = 0; i < CONSOLIDATION_OUTBOX_MAX_ITEMS; i += 1) {
    outbox.add({
      batchId: `full-${String(i).padStart(4, "0")}-0000-4000-8000-000000000000`,
      payloadHash: "a".repeat(64),
      occurredOn: TODAY,
      turns: [{ role: "user", text: `已满${i}` }],
    });
  }

  const before = storage.store.get(CONSOLIDATION_OUTBOX_STORAGE_KEY)!;
  const batch = [...HASH_READY_TURNS];
  let pending: typeof HASH_READY_TURNS = [];

  const result = await handOffDialogueBatchToOutbox({
    outbox,
    turns: batch,
    occurredOnRaw: TODAY,
    todayLocal: TODAY,
    createBatchId: () => "handoff0-0000-4000-8000-000000000003",
  });

  assert.equal(result.kind, "failed");
  if (result.kind === "failed") {
    assert.ok(result.error instanceof ConsolidationOutboxCapacityError);
  }
  pending = applyHandoffResultToPending(pending, batch, result);
  assert.deepEqual(pending, HASH_READY_TURNS);
  assert.equal(storage.store.get(CONSOLIDATION_OUTBOX_STORAGE_KEY), before);
}

// --- 3b) 损坏数据：内存仍在 ---
{
  const storage = createMemoryOutboxStorage({
    [CONSOLIDATION_OUTBOX_STORAGE_KEY]: "{broken",
  });
  const outbox = makeOutbox(storage);
  const batch = [...HASH_READY_TURNS];
  let pending: typeof HASH_READY_TURNS = [];

  const result = await handOffDialogueBatchToOutbox({
    outbox,
    turns: batch,
    occurredOnRaw: TODAY,
    todayLocal: TODAY,
    createBatchId: () => "handoff0-0000-4000-8000-000000000004",
  });

  assert.equal(result.kind, "failed");
  if (result.kind === "failed") {
    assert.ok(result.error instanceof ConsolidationOutboxCorruptError);
  }
  pending = applyHandoffResultToPending(pending, batch, result);
  assert.deepEqual(pending, HASH_READY_TURNS);
  assert.equal(storage.store.get(CONSOLIDATION_OUTBOX_STORAGE_KEY), "{broken");
}

// --- 4) 同一批次重复交接：稳定 ID，不重复占位 ---
{
  const outbox = makeOutbox();
  let stableId = "";
  let createCalls = 0;

  const first = await handOffDialogueBatchToOutbox({
    outbox,
    turns: HASH_READY_TURNS,
    occurredOnRaw: TODAY,
    todayLocal: TODAY,
    createBatchId: () => {
      createCalls += 1;
      return "stable00-0000-4000-8000-000000000005";
    },
  });
  assert.equal(first.kind, "persisted");
  if (first.kind === "persisted") stableId = first.batchId;
  assert.equal(createCalls, 1);
  assert.equal(outbox.list().length, 1);

  const second = await handOffDialogueBatchToOutbox({
    outbox,
    turns: HASH_READY_TURNS,
    occurredOnRaw: TODAY,
    todayLocal: TODAY,
    batchId: stableId,
    createBatchId: () => {
      createCalls += 1;
      return "should-not-run";
    },
  });
  assert.equal(second.kind, "persisted");
  assert.equal(second.kind === "persisted" && second.batchId, stableId);
  assert.equal(createCalls, 1);
  assert.equal(outbox.list().length, 1);
}

// --- 4b) 同 ID 异 hash：失败、不覆盖、可按原 payload 幂等重试 ---
{
  const outbox = makeOutbox();
  const batchId = "conflict-0000-4000-8000-00000000000a";
  const originalTurns = [...HASH_READY_TURNS];
  const conflictingTurns = [
    { role: "user" as const, text: "我换了完全不同的对话内容，记得一下" },
    { role: "companion" as const, text: "好，记下了另一件事" },
  ];

  const first = await handOffDialogueBatchToOutbox({
    outbox,
    turns: originalTurns,
    occurredOnRaw: TODAY,
    todayLocal: TODAY,
    batchId,
  });
  assert.equal(first.kind, "persisted");
  assert.equal(first.removeFromPending, true);

  const snapshot = outbox.get(batchId);
  assert.ok(snapshot);
  const beforeList = outbox.list();
  assert.equal(beforeList.length, 1);

  let pending: typeof conflictingTurns = [];
  const conflictBatch = [...conflictingTurns];
  const conflict = await handOffDialogueBatchToOutbox({
    outbox,
    turns: conflictBatch,
    occurredOnRaw: TODAY,
    todayLocal: TODAY,
    batchId,
  });

  assert.equal(conflict.kind, "failed");
  assert.equal(conflict.removeFromPending, false);
  if (conflict.kind === "failed") {
    assert.ok(conflict.error instanceof ConsolidationOutboxConflictError);
    assert.equal(conflict.batchId, batchId);
    assert.deepEqual(conflict.turns, conflictingTurns);
  }

  pending = applyHandoffResultToPending(pending, conflictBatch, conflict);
  assert.deepEqual(pending, conflictingTurns);

  const afterConflict = outbox.get(batchId);
  assert.ok(afterConflict);
  assert.equal(afterConflict.batchId, snapshot!.batchId);
  assert.equal(afterConflict.payloadHash, snapshot!.payloadHash);
  assert.equal(afterConflict.occurredOn, snapshot!.occurredOn);
  assert.deepEqual(afterConflict.turns, snapshot!.turns);
  assert.equal(outbox.list().length, 1);

  const retryOriginal = await handOffDialogueBatchToOutbox({
    outbox,
    turns: originalTurns,
    occurredOnRaw: TODAY,
    todayLocal: TODAY,
    batchId,
  });
  assert.equal(retryOriginal.kind, "persisted");
  assert.equal(retryOriginal.removeFromPending, true);
  if (retryOriginal.kind === "persisted") {
    assert.equal(retryOriginal.batchId, batchId);
    assert.equal(retryOriginal.item.payloadHash, snapshot!.payloadHash);
  }
  assert.equal(outbox.list().length, 1);
}

// --- 5) dead-letter 不自动重排／不 revive ---
{
  const outbox = makeOutbox();
  const batchId = "dead0000-0000-4000-8000-000000000006";

  const first = await handOffDialogueBatchToOutbox({
    outbox,
    turns: HASH_READY_TURNS,
    occurredOnRaw: TODAY,
    todayLocal: TODAY,
    batchId,
  });
  assert.equal(first.kind, "persisted");
  outbox.update(batchId, { status: "dead_letter", lastError: "400" });

  const again = await handOffDialogueBatchToOutbox({
    outbox,
    turns: HASH_READY_TURNS,
    occurredOnRaw: TODAY,
    todayLocal: TODAY,
    batchId,
  });

  assert.equal(again.kind, "already_dead_letter");
  assert.equal(again.removeFromPending, true);
  assert.equal(outbox.get(batchId)?.status, "dead_letter");
  assert.equal(outbox.list().length, 1);
  assert.equal(outbox.listDeadLetters().length, 1);
}

// --- 6) 短对话：跳过交接，规则与 RealtimeClient 一致 ---
{
  const outbox = makeOutbox();
  const short = [{ role: "user" as const, text: "天气怎么样" }];
  assert.equal(dialogueWorthKeeping(short), false);

  let pending: typeof short = [];
  const batch = [...short];
  const result = await handOffDialogueBatchToOutbox({
    outbox,
    turns: batch,
    occurredOnRaw: TODAY,
    todayLocal: TODAY,
  });

  assert.equal(result.kind, "skipped_not_worth_keeping");
  assert.equal(result.removeFromPending, false);
  pending = applyHandoffResultToPending(pending, batch, result);
  assert.deepEqual(pending, short);
  assert.equal(outbox.list().length, 0);
}

console.log("[consolidation-handoff] ok");
