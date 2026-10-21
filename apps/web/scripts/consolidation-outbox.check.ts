/**
 * consolidation outbox 存储层离线测试：可注入 Memory Storage，无网络／无正式库。
 */
import assert from "node:assert/strict";
import {
  CONSOLIDATION_OUTBOX_MAX_ITEMS,
  CONSOLIDATION_OUTBOX_MAX_SERIALIZED_CHARS,
  CONSOLIDATION_OUTBOX_MAX_TURNS,
  CONSOLIDATION_OUTBOX_STORAGE_KEY,
  CONSOLIDATION_OUTBOX_VERSION,
  ConsolidationOutbox,
  ConsolidationOutboxCapacityError,
  ConsolidationOutboxConflictError,
  ConsolidationOutboxCorruptError,
  ConsolidationOutboxError,
  ConsolidationOutboxTransitionError,
  ConsolidationOutboxUnavailableError,
  createMemoryOutboxStorage,
} from "../src/realtime/consolidationOutbox.ts";
import { CONSOLIDATION_MAX_TURN_CHARS } from "../src/realtime/consolidationPayload.ts";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const BATCH_A = "11111111-2222-4333-8444-555555555555";
const BATCH_B = "22222222-3333-4444-8555-666666666666";

let clock = 0;

function nowIso(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 9, 20, 12, 0, 0, clock)).toISOString();
}

function sampleTurns() {
  return [
    { role: "user" as const, text: "我周末去看了展" },
    { role: "companion" as const, text: "记下了" },
  ];
}

function makeOutbox(
  storage = createMemoryOutboxStorage(),
): ConsolidationOutbox {
  return new ConsolidationOutbox({ storage, now: nowIso });
}

// --- 1) 空 outbox 读取与正常添加 ---
{
  const storage = createMemoryOutboxStorage();
  const outbox = makeOutbox(storage);
  const empty = outbox.load();
  assert.equal(empty.items.length, 0);
  assert.equal(storage.store.has(CONSOLIDATION_OUTBOX_STORAGE_KEY), false);

  const added = outbox.add({
    batchId: BATCH_A,
    payloadHash: HASH_A,
    occurredOn: "2026-10-20",
    turns: sampleTurns(),
  });
  assert.equal(added.batchId, BATCH_A);
  assert.equal(added.status, "pending");
  assert.equal(added.attempts, 0);
  assert.ok(storage.store.has(CONSOLIDATION_OUTBOX_STORAGE_KEY));
  assert.equal(outbox.list().length, 1);
}

// --- 2) 同 ID 同 hash 幂等 ---
{
  const outbox = makeOutbox();
  const first = outbox.add({
    batchId: BATCH_A,
    payloadHash: HASH_A,
    occurredOn: "2026-10-20",
    turns: sampleTurns(),
  });
  const second = outbox.add({
    batchId: BATCH_A,
    payloadHash: HASH_A,
    occurredOn: "2026-10-20",
    turns: sampleTurns(),
  });
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(outbox.list().length, 1);
}

// --- 3) 同 ID 不同 hash 冲突 ---
{
  const outbox = makeOutbox();
  outbox.add({
    batchId: BATCH_A,
    payloadHash: HASH_A,
    occurredOn: "2026-10-20",
    turns: sampleTurns(),
  });
  assert.throws(
    () =>
      outbox.add({
        batchId: BATCH_A,
        payloadHash: HASH_B,
        occurredOn: "2026-10-20",
        turns: sampleTurns(),
      }),
    (error: unknown) => error instanceof ConsolidationOutboxConflictError,
  );
  assert.equal(outbox.list().length, 1);
  assert.equal(outbox.get(BATCH_A)?.payloadHash, HASH_A);
}

// --- 4) 状态更新、删除、dead-letter 查询 ---
{
  const outbox = makeOutbox();
  outbox.add({
    batchId: BATCH_A,
    payloadHash: HASH_A,
    occurredOn: "2026-10-20",
    turns: sampleTurns(),
  });
  outbox.add({
    batchId: BATCH_B,
    payloadHash: HASH_B,
    occurredOn: "2026-10-20",
    turns: sampleTurns(),
  });

  const updated = outbox.update(BATCH_A, {
    status: "dead_letter",
    attempts: 3,
    lastError: "consolidation rejected: 400",
    nextAttemptAt: "2099-01-01T00:00:00.000Z",
  });
  assert.equal(updated.status, "dead_letter");
  assert.equal(updated.attempts, 3);
  assert.equal(outbox.listDeadLetters().length, 1);
  assert.equal(outbox.listDeadLetters()[0]?.batchId, BATCH_A);

  assert.equal(outbox.remove(BATCH_A), true);
  assert.equal(outbox.get(BATCH_A), null);
  assert.equal(outbox.listDeadLetters().length, 0);
  assert.equal(outbox.list().length, 1);
  assert.equal(outbox.remove(BATCH_A), false);
}

// --- 5) 损坏 JSON 不被覆盖 ---
{
  const storage = createMemoryOutboxStorage({
    [CONSOLIDATION_OUTBOX_STORAGE_KEY]: "{not-json",
  });
  const outbox = makeOutbox(storage);
  assert.throws(
    () => outbox.load(),
    (error: unknown) => error instanceof ConsolidationOutboxCorruptError,
  );
  assert.equal(storage.store.get(CONSOLIDATION_OUTBOX_STORAGE_KEY), "{not-json");

  assert.throws(
    () =>
      outbox.add({
        batchId: BATCH_A,
        payloadHash: HASH_A,
        occurredOn: "2026-10-20",
        turns: sampleTurns(),
      }),
    (error: unknown) => error instanceof ConsolidationOutboxCorruptError,
  );
  assert.equal(storage.store.get(CONSOLIDATION_OUTBOX_STORAGE_KEY), "{not-json");
}

// --- 6) setItem 抛错 → Unavailable，不伪装成功 ---
{
  const base = createMemoryOutboxStorage();
  const storage = {
    store: base.store,
    getItem: (key: string) => base.getItem(key),
    removeItem: (key: string) => base.removeItem(key),
    setItem() {
      throw new Error("QuotaExceededError");
    },
  };
  const outbox = makeOutbox(storage);
  assert.throws(
    () =>
      outbox.add({
        batchId: BATCH_A,
        payloadHash: HASH_A,
        occurredOn: "2026-10-20",
        turns: sampleTurns(),
      }),
    (error: unknown) => error instanceof ConsolidationOutboxUnavailableError,
  );
  assert.equal(base.store.has(CONSOLIDATION_OUTBOX_STORAGE_KEY), false);
}

// --- 7) 容量限制：满员拒绝，已有记录完整保留 ---
{
  const storage = createMemoryOutboxStorage();
  const outbox = makeOutbox(storage);

  for (let i = 0; i < CONSOLIDATION_OUTBOX_MAX_ITEMS; i += 1) {
    const id = `batch-${String(i).padStart(4, "0")}-0000-4000-8000-000000000000`;
    outbox.add({
      batchId: id,
      payloadHash: HASH_A,
      occurredOn: "2026-10-20",
      turns: [{ role: "user", text: `记住第${i}条` }],
    });
  }

  const before = storage.store.get(CONSOLIDATION_OUTBOX_STORAGE_KEY)!;
  assert.throws(
    () =>
      outbox.add({
        batchId: "overflow0-0000-4000-8000-000000000099",
        payloadHash: HASH_B,
        occurredOn: "2026-10-20",
        turns: [{ role: "user", text: "不应写入" }],
      }),
    (error: unknown) => error instanceof ConsolidationOutboxCapacityError,
  );
  assert.equal(storage.store.get(CONSOLIDATION_OUTBOX_STORAGE_KEY), before);
  assert.equal(outbox.list().length, CONSOLIDATION_OUTBOX_MAX_ITEMS);
}

// --- 8) 非法输入、超长 turn、超限批次 ---
{
  const outbox = makeOutbox();

  assert.throws(
    () =>
      outbox.add({
        batchId: "",
        payloadHash: HASH_A,
        occurredOn: "2026-10-20",
        turns: sampleTurns(),
      }),
    (error: unknown) =>
      error instanceof ConsolidationOutboxError && error.code === "invalid_input",
  );

  assert.throws(
    () =>
      outbox.add({
        batchId: BATCH_A,
        payloadHash: "zz",
        occurredOn: "2026-10-20",
        turns: sampleTurns(),
      }),
    (error: unknown) =>
      error instanceof ConsolidationOutboxError && error.code === "invalid_input",
  );

  assert.throws(
    () =>
      outbox.add({
        batchId: BATCH_A,
        payloadHash: HASH_A,
        occurredOn: "2026-10-20",
        turns: [
          {
            role: "user",
            text: "x".repeat(CONSOLIDATION_MAX_TURN_CHARS + 1),
          },
        ],
      }),
    (error: unknown) =>
      error instanceof ConsolidationOutboxError && error.code === "invalid_input",
  );

  const tooMany = Array.from({ length: CONSOLIDATION_OUTBOX_MAX_TURNS + 1 }, () => ({
    role: "user" as const,
    text: "一句",
  }));
  assert.throws(
    () =>
      outbox.add({
        batchId: BATCH_A,
        payloadHash: HASH_A,
        occurredOn: "2026-10-20",
        turns: tooMany,
      }),
    (error: unknown) =>
      error instanceof ConsolidationOutboxError && error.code === "invalid_input",
  );

  assert.equal(outbox.list().length, 0);
}

// --- 9) 新实例从同一 Storage 重建，确认持久化 ---
{
  const storage = createMemoryOutboxStorage();
  const first = makeOutbox(storage);
  first.add({
    batchId: BATCH_A,
    payloadHash: HASH_A,
    occurredOn: "2026-10-20",
    turns: sampleTurns(),
  });
  first.update(BATCH_A, { status: "in_flight", attempts: 1, leaseOwner: "tab-1" });

  const second = new ConsolidationOutbox({ storage, now: nowIso });
  const loaded = second.get(BATCH_A);
  assert.ok(loaded);
  assert.equal(loaded.status, "in_flight");
  assert.equal(loaded.attempts, 1);
  assert.equal(loaded.leaseOwner, "tab-1");
  assert.deepEqual(loaded.turns, sampleTurns());
}

// --- 10) 状态转换：合法、非法、显式 revive ---
{
  const storage = createMemoryOutboxStorage();
  const outbox = makeOutbox(storage);
  outbox.add({
    batchId: BATCH_A,
    payloadHash: HASH_A,
    occurredOn: "2026-10-20",
    turns: sampleTurns(),
  });

  assert.equal(outbox.update(BATCH_A, { status: "in_flight" }).status, "in_flight");
  assert.equal(outbox.update(BATCH_A, { status: "pending" }).status, "pending");
  assert.equal(outbox.update(BATCH_A, { status: "dead_letter" }).status, "dead_letter");

  const beforeIllegal = storage.store.get(CONSOLIDATION_OUTBOX_STORAGE_KEY)!;
  assert.throws(
    () => outbox.update(BATCH_A, { status: "pending" }),
    (error: unknown) => error instanceof ConsolidationOutboxTransitionError,
  );
  assert.throws(
    () => outbox.update(BATCH_A, { status: "in_flight" }),
    (error: unknown) => error instanceof ConsolidationOutboxTransitionError,
  );
  assert.equal(storage.store.get(CONSOLIDATION_OUTBOX_STORAGE_KEY), beforeIllegal);
  assert.equal(outbox.get(BATCH_A)?.status, "dead_letter");

  // dead_letter 上仍可改元数据（保持 dead_letter）
  assert.equal(
    outbox.update(BATCH_A, {
      lastError: "noted",
      attempts: 2,
      leaseOwner: "tab-dead",
    }).status,
    "dead_letter",
  );

  const beforeRevive = storage.store.get(CONSOLIDATION_OUTBOX_STORAGE_KEY)!;
  const nowBeforeRevive = clock;
  const revived = outbox.reviveDeadLetter(BATCH_A);
  const expectedNow = new Date(
    Date.UTC(2026, 9, 20, 12, 0, 0, nowBeforeRevive + 1),
  ).toISOString();
  assert.equal(revived.status, "pending");
  assert.equal(revived.lastError, null);
  assert.equal(revived.leaseOwner, null);
  assert.equal(revived.nextAttemptAt, expectedNow);
  assert.equal(outbox.get(BATCH_A)?.status, "pending");
  assert.equal(outbox.get(BATCH_A)?.leaseOwner, null);
  assert.equal(outbox.get(BATCH_A)?.nextAttemptAt, expectedNow);
  assert.notEqual(storage.store.get(CONSOLIDATION_OUTBOX_STORAGE_KEY), beforeRevive);

  assert.throws(
    () => outbox.reviveDeadLetter(BATCH_A),
    (error: unknown) => error instanceof ConsolidationOutboxTransitionError,
  );
}

// --- 11) 已有数据时 setItem 抛错：原 key 不变 ---
{
  const base = createMemoryOutboxStorage();
  const outboxOk = makeOutbox(base);
  outboxOk.add({
    batchId: BATCH_A,
    payloadHash: HASH_A,
    occurredOn: "2026-10-20",
    turns: sampleTurns(),
  });
  const before = base.store.get(CONSOLIDATION_OUTBOX_STORAGE_KEY)!;

  const storage = {
    getItem: (key: string) => base.getItem(key),
    removeItem: (key: string) => base.removeItem(key),
    setItem() {
      throw new Error("QuotaExceededError");
    },
  };
  const outbox = makeOutbox(storage);
  assert.throws(
    () => outbox.update(BATCH_A, { attempts: 9 }),
    (error: unknown) => error instanceof ConsolidationOutboxUnavailableError,
  );
  assert.equal(base.store.get(CONSOLIDATION_OUTBOX_STORAGE_KEY), before);
  assert.equal(JSON.parse(before).items[0].attempts, 0);
}

// --- 12) 非法 envelope：错版本／缺 items／重复 ID／非法 status ---
{
  const stamp = "2026-10-20T12:00:00.000Z";
  const validItem = {
    batchId: BATCH_A,
    payloadHash: HASH_A,
    occurredOn: "2026-10-20",
    turns: sampleTurns(),
    createdAt: stamp,
    updatedAt: stamp,
    attempts: 0,
    nextAttemptAt: stamp,
    status: "pending",
    lastError: null,
    leaseOwner: null,
  };

  const cases: Array<{ label: string; raw: string }> = [
    {
      label: "bad-version",
      raw: JSON.stringify({ v: 99, updatedAt: stamp, items: [] }),
    },
    {
      label: "missing-items",
      raw: JSON.stringify({ v: CONSOLIDATION_OUTBOX_VERSION, updatedAt: stamp }),
    },
    {
      label: "duplicate-id",
      raw: JSON.stringify({
        v: CONSOLIDATION_OUTBOX_VERSION,
        updatedAt: stamp,
        items: [validItem, { ...validItem }],
      }),
    },
    {
      label: "illegal-status",
      raw: JSON.stringify({
        v: CONSOLIDATION_OUTBOX_VERSION,
        updatedAt: stamp,
        items: [{ ...validItem, status: "done" }],
      }),
    },
  ];

  for (const testCase of cases) {
    const storage = createMemoryOutboxStorage({
      [CONSOLIDATION_OUTBOX_STORAGE_KEY]: testCase.raw,
    });
    const outbox = makeOutbox(storage);
    assert.throws(
      () => outbox.load(),
      (error: unknown) => error instanceof ConsolidationOutboxCorruptError,
      testCase.label,
    );
    assert.equal(
      storage.store.get(CONSOLIDATION_OUTBOX_STORAGE_KEY),
      testCase.raw,
      testCase.label,
    );
  }
}

// --- 13) 精确 40 turns、每 turn 恰好 2000 字符 ---
{
  const outbox = makeOutbox();
  const turns = Array.from({ length: CONSOLIDATION_OUTBOX_MAX_TURNS }, () => ({
    role: "user" as const,
    text: "x".repeat(CONSOLIDATION_MAX_TURN_CHARS),
  }));
  const added = outbox.add({
    batchId: BATCH_A,
    payloadHash: HASH_A,
    occurredOn: "2026-10-20",
    turns,
  });
  assert.equal(added.turns.length, CONSOLIDATION_OUTBOX_MAX_TURNS);
  assert.equal(added.turns[0]?.text.length, CONSOLIDATION_MAX_TURN_CHARS);
}

// --- 14) 序列化超过 450000：拒绝且保留已有 ---
{
  const storage = createMemoryOutboxStorage();
  const outbox = makeOutbox(storage);
  const fatTurns = Array.from({ length: CONSOLIDATION_OUTBOX_MAX_TURNS }, () => ({
    role: "user" as const,
    text: "y".repeat(CONSOLIDATION_MAX_TURN_CHARS),
  }));

  outbox.add({
    batchId: "fat00000-0000-4000-8000-000000000001",
    payloadHash: HASH_A,
    occurredOn: "2026-10-20",
    turns: fatTurns,
  });

  let lastGood = storage.store.get(CONSOLIDATION_OUTBOX_STORAGE_KEY)!;
  assert.ok(lastGood.length < CONSOLIDATION_OUTBOX_MAX_SERIALIZED_CHARS);

  let rejected = false;

  for (let i = 2; i <= CONSOLIDATION_OUTBOX_MAX_ITEMS; i += 1) {
    try {
      outbox.add({
        batchId: `fat00000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        payloadHash: HASH_A,
        occurredOn: "2026-10-20",
        turns: fatTurns,
      });
      lastGood = storage.store.get(CONSOLIDATION_OUTBOX_STORAGE_KEY)!;
    } catch (error) {
      assert.ok(
        error instanceof ConsolidationOutboxCapacityError,
        "expected capacity on oversized serialize",
      );
      assert.equal(storage.store.get(CONSOLIDATION_OUTBOX_STORAGE_KEY), lastGood);
      assert.ok(lastGood.length <= CONSOLIDATION_OUTBOX_MAX_SERIALIZED_CHARS);
      rejected = true;
      break;
    }
  }

  assert.equal(rejected, true);
  assert.ok(outbox.list().length >= 1);
}

// --- 15) dead_letter 占位时满载仍拒绝，不驱逐 ---
{
  const storage = createMemoryOutboxStorage();
  const outbox = makeOutbox(storage);

  for (let i = 0; i < CONSOLIDATION_OUTBOX_MAX_ITEMS - 1; i += 1) {
    outbox.add({
      batchId: `fill-${String(i).padStart(4, "0")}-0000-4000-8000-000000000000`,
      payloadHash: HASH_A,
      occurredOn: "2026-10-20",
      turns: [{ role: "user", text: `p${i}` }],
    });
  }

  outbox.add({
    batchId: BATCH_A,
    payloadHash: HASH_B,
    occurredOn: "2026-10-20",
    turns: [{ role: "user", text: "dead" }],
    status: "dead_letter",
  });
  assert.equal(outbox.list().length, CONSOLIDATION_OUTBOX_MAX_ITEMS);
  assert.equal(outbox.listDeadLetters().length, 1);

  const before = storage.store.get(CONSOLIDATION_OUTBOX_STORAGE_KEY)!;
  assert.throws(
    () =>
      outbox.add({
        batchId: "overflow1-0000-4000-8000-000000000099",
        payloadHash: HASH_A,
        occurredOn: "2026-10-20",
        turns: [{ role: "user", text: "nope" }],
      }),
    (error: unknown) => error instanceof ConsolidationOutboxCapacityError,
  );
  assert.equal(storage.store.get(CONSOLIDATION_OUTBOX_STORAGE_KEY), before);
  assert.equal(outbox.get(BATCH_A)?.status, "dead_letter");
}

// --- 16) 时间戳：真实日历校验 + 失败不写盘 ---
{
  const storage = createMemoryOutboxStorage();
  const outbox = makeOutbox(storage);
  outbox.add({
    batchId: BATCH_A,
    payloadHash: HASH_A,
    occurredOn: "2026-10-20",
    turns: sampleTurns(),
  });
  const before = storage.store.get(CONSOLIDATION_OUTBOX_STORAGE_KEY)!;

  const rejectCreatedAt = (createdAt: string) => {
    assert.throws(
      () =>
        outbox.add({
          batchId: BATCH_B,
          payloadHash: HASH_B,
          occurredOn: "2026-10-20",
          turns: sampleTurns(),
          createdAt,
        }),
      (error: unknown) =>
        error instanceof ConsolidationOutboxError && error.code === "invalid_input",
      createdAt,
    );
    assert.equal(
      storage.store.get(CONSOLIDATION_OUTBOX_STORAGE_KEY),
      before,
      createdAt,
    );
  };

  rejectCreatedAt("yesterday");
  rejectCreatedAt("2026-02-31T00:00:00.000Z");
  rejectCreatedAt("2025-02-29T00:00:00.000Z");
  rejectCreatedAt("2026-13-01T00:00:00.000Z");
  rejectCreatedAt("2026-10-20T24:00:00.000Z");
  rejectCreatedAt("2026-10-20T12:60:00.000Z");
  rejectCreatedAt("2026-10-20T12:00:60.000Z");
  rejectCreatedAt("2026-10-20T12:00:00+08:00");

  // 闰年 2-29、有效月末
  outbox.add({
    batchId: "leap0000-0000-4000-8000-000000000001",
    payloadHash: HASH_B,
    occurredOn: "2026-10-20",
    turns: sampleTurns(),
    createdAt: "2024-02-29T00:00:00.000Z",
    nextAttemptAt: "2026-01-31T23:59:59.999Z",
  });
  assert.equal(
    outbox.get("leap0000-0000-4000-8000-000000000001")?.createdAt,
    "2024-02-29T00:00:00.000Z",
  );
  assert.equal(
    outbox.get("leap0000-0000-4000-8000-000000000001")?.nextAttemptAt,
    "2026-01-31T23:59:59.999Z",
  );

  outbox.add({
    batchId: "monthend-0000-4000-8000-000000000002",
    payloadHash: HASH_A,
    occurredOn: "2026-10-20",
    turns: sampleTurns(),
    createdAt: "2026-04-30T12:00:00.000Z",
  });
  assert.ok(outbox.get("monthend-0000-4000-8000-000000000002"));
}

console.log("[consolidation-outbox] ok");
