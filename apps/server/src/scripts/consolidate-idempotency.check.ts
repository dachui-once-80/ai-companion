/**
 * consolidate 收据幂等：隔离临时库；不触碰正式 companion.db。
 */
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { prepareOfflineDb, assertOfflineDbIsolated } from "./offlineDb.ts";

const file = prepareOfflineDb("consolidate-idempotency-");

const sqlite = new Database(file);
sqlite.exec(`
  CREATE TABLE memories (
    id text PRIMARY KEY NOT NULL,
    category text NOT NULL,
    key text NOT NULL DEFAULT 'unknown',
    content text NOT NULL,
    importance text NOT NULL,
    status text NOT NULL DEFAULT 'current',
    source text NOT NULL DEFAULT 'user',
    created_at text NOT NULL,
    updated_at text NOT NULL
  );
  CREATE TABLE companion_thoughts (
    id text PRIMARY KEY NOT NULL,
    kind text NOT NULL,
    content text NOT NULL,
    about text NOT NULL DEFAULT '',
    created_at text NOT NULL,
    updated_at text NOT NULL
  );
  CREATE TABLE consolidation_receipts (
    batch_id text PRIMARY KEY NOT NULL,
    payload_hash text NOT NULL,
    result_json text NOT NULL,
    occurred_on text NOT NULL,
    created_at text NOT NULL
  );
`);
sqlite.close();

await assertOfflineDbIsolated(file);

const {
  ConsolidationInputError,
  ConsolidationPayloadConflictError,
  ConsolidationQuotaError,
  commitConsolidationWithReceipt,
  computeConsolidationPayloadHash,
  consolidateConversation,
  httpBodyForConsolidationError,
  readConsolidationRequest,
} = await import("../memory/consolidate.ts");

const { MemoryManager } = await import("../memory/MemoryManager");
const { MemoryStore } = await import("../memory/MemoryStore");
const { ThoughtStore } = await import("../companion/ThoughtStore");
const { formatLocalDate } = await import("../memory/openMemory.ts");
const { db } = await import("../db/index.ts");
const { consolidationReceipts } = await import("../db/schema.ts");
const { memories } = await import("../db/schema.ts");
const { companionThoughts } = await import("../db/schema.ts");

function countRows(): { memories: number; thoughts: number; receipts: number } {
  return {
    memories: db.select().from(memories).all().length,
    thoughts: db.select().from(companionThoughts).all().length,
    receipts: db.select().from(consolidationReceipts).all().length,
  };
}

const store = new MemoryStore();
const thoughts = new ThoughtStore();
const memory = new MemoryManager(store, null, null);

const occurredOn = "2026-10-20";
const turns = [
  { role: "user" as const, text: "我周末去看了展，记得一下" },
  { role: "companion" as const, text: "好，我记下了。" },
];
const payloadHash = computeConsolidationPayloadHash(occurredOn, turns);
const batchId = "11111111-2222-4333-8444-555555555555";

const planJson = JSON.stringify({
  episodes: [
    {
      date: occurredOn,
      content: "周末一起去看了展",
      importance: "medium",
    },
  ],
  impressions: [],
  retireImpressions: [],
  notes: [],
  profile: [],
  between: [],
  resolveBetween: [],
  views: [
    {
      about: "看展",
      content: "喜欢慢慢看展",
    },
  ],
  unresolved: [],
  resolveUnresolved: [],
  question: [],
  resolveQuestion: [],
});

let generateCalls = 0;

async function runOnce(body: unknown) {
  return consolidateConversation({
    body,
    memory,
    thoughts,
    generate: async () => {
      generateCalls += 1;
      return planJson;
    },
  });
}

const body = {
  occurredOn,
  turns,
  batchId,
  payloadHash,
};

// --- 1) 同 batchId 重放只应用一次 ---
generateCalls = 0;
const first = await runOnce(body);
assert.equal(generateCalls, 1);
assert.ok(first.saved.episodes >= 1);
assert.ok(first.saved.views >= 1);
const afterFirst = countRows();
assert.equal(afterFirst.receipts, 1);

generateCalls = 0;
const second = await runOnce(body);
assert.equal(generateCalls, 0, "replay must not call LLM");
assert.deepEqual(second.saved, first.saved);
assert.equal(countRows().receipts, 1);
assert.equal(countRows().memories, afterFirst.memories);
assert.equal(countRows().thoughts, afterFirst.thoughts);

// --- 2) 同 ID、不同 payload hash → 冲突 ---
{
  const otherTurns = [
    { role: "user" as const, text: "完全另一段对话内容足够长" },
    { role: "companion" as const, text: "嗯" },
  ];
  const otherHash = computeConsolidationPayloadHash(occurredOn, otherTurns);

  await assert.rejects(
    () =>
      runOnce({
        occurredOn,
        turns: otherTurns,
        batchId,
        payloadHash: otherHash,
      }),
    (error: unknown) => error instanceof ConsolidationPayloadConflictError,
  );
  assert.equal(countRows().receipts, 1);
}

// --- 客户端自报 hash 与正文不符 → 400 输入错误 ---
{
  await assert.rejects(
    () =>
      runOnce({
        occurredOn,
        turns,
        batchId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        payloadHash: "0".repeat(64),
      }),
    (error: unknown) => error instanceof ConsolidationInputError,
  );
}

// --- 3) 丢响应重试：同上，行数不增（已覆盖 second）---

// --- 4) 事务中途抛错：记忆与 thought 回滚，无成功收据 ---
{
  const failId = "fail0000-0000-4000-8000-000000000001";
  const failTurns = [
    { role: "user" as const, text: "事务回滚测试请记住这件事" },
    { role: "companion" as const, text: "好" },
  ];
  const failHash = computeConsolidationPayloadHash(occurredOn, failTurns);
  const before = countRows();

  assert.throws(
    () =>
      commitConsolidationWithReceipt({
        batchId: failId,
        payloadHash: failHash,
        occurredOn,
        apply: () => {
          memory.saveEpisode(occurredOn, "不应留下的片段", "low");
          thoughts.save({
            kind: "view",
            about: "回滚",
            content: "也不应留下",
          });
          throw new Error("simulated apply failure");
        },
      }),
    /simulated apply failure/,
  );

  const after = countRows();
  assert.equal(after.memories, before.memories);
  assert.equal(after.thoughts, before.thoughts);
  assert.equal(after.receipts, before.receipts);
  assert.equal(
    db
      .select()
      .from(consolidationReceipts)
      .all()
      .some((row) => row.batchId === failId),
    false,
  );
}

// --- 5) 空结果也有收据 ---
{
  const emptyId = "empty000-0000-4000-8000-000000000002";
  const emptyTurns = [{ role: "user" as const, text: "天气怎么样" }];
  const emptyHash = computeConsolidationPayloadHash(occurredOn, emptyTurns);
  let emptyGenerate = 0;

  const emptyFirst = await consolidateConversation({
    body: {
      occurredOn,
      turns: emptyTurns,
      batchId: emptyId,
      payloadHash: emptyHash,
    },
    memory,
    thoughts,
    generate: async () => {
      emptyGenerate += 1;
      return planJson;
    },
  });

  assert.equal(emptyGenerate, 0, "disposable must skip LLM");
  assert.equal(emptyFirst.saved.episodes, 0);
  assert.ok(
    db
      .select()
      .from(consolidationReceipts)
      .all()
      .some((row) => row.batchId === emptyId),
  );

  emptyGenerate = 0;
  const emptyReplay = await consolidateConversation({
    body: {
      occurredOn,
      turns: emptyTurns,
      batchId: emptyId,
      payloadHash: emptyHash,
    },
    memory,
    thoughts,
    generate: async () => {
      emptyGenerate += 1;
      return planJson;
    },
  });
  assert.equal(emptyGenerate, 0);
  assert.deepEqual(emptyReplay.saved, emptyFirst.saved);
}

// --- 6) generate 配额 → ConsolidationQuotaError → 软延迟；不写库、无收据 ---
{
  const quotaId = "quota000-0000-4000-8000-000000000003";
  const quotaTurns = [
    { role: "user" as const, text: "我想记住今天去爬山了很开心" },
    { role: "companion" as const, text: "记下了" },
  ];
  const quotaHash = computeConsolidationPayloadHash(occurredOn, quotaTurns);
  const before = countRows();

  let caught: unknown;

  try {
    await consolidateConversation({
      body: {
        occurredOn,
        turns: quotaTurns,
        batchId: quotaId,
        payloadHash: quotaHash,
      },
      memory,
      thoughts,
      generate: async () => {
        const error = new Error(
          'RESOURCE_EXHAUSTED Quota exceeded {"retryDelay":"30s"}',
        );
        (error as { status?: number }).status = 429;
        throw error;
      },
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof ConsolidationQuotaError);
  assert.equal(caught.retryAfterMs, 30_000);

  const mapped = httpBodyForConsolidationError(caught);
  assert.equal(mapped.status, 200);
  assert.equal(mapped.json.retryAfterMs, 30_000);
  assert.deepEqual(mapped.json.saved, {
    episodes: 0,
    impressions: 0,
    notes: 0,
    profile: 0,
    between: 0,
    closedBetween: 0,
    retired: 0,
    views: 0,
    unresolved: 0,
    question: 0,
    closedUnresolved: 0,
    closedQuestion: 0,
  });

  const after = countRows();
  assert.equal(after.memories, before.memories);
  assert.equal(after.thoughts, before.thoughts);
  assert.equal(after.receipts, before.receipts);
}

// --- 6b) apply／收据阶段抛出含 Quota exceeded 的错误 → 不得软成功 ---
{
  const fakeQuotaId = "fakeq000-0000-4000-8000-00000000000a";
  const fakeTurns = [
    { role: "user" as const, text: "数据库阶段伪配额不得软成功" },
    { role: "companion" as const, text: "好" },
  ];
  const fakeHash = computeConsolidationPayloadHash(occurredOn, fakeTurns);
  const before = countRows();

  let caught: unknown;

  try {
    commitConsolidationWithReceipt({
      batchId: fakeQuotaId,
      payloadHash: fakeHash,
      occurredOn,
      apply: () => {
        memory.saveEpisode(occurredOn, "不应留下的伪配额片段", "low");
        thoughts.save({
          kind: "view",
          about: "伪配额",
          content: "也不应留下",
        });
        throw new Error("Quota exceeded during apply (simulated db failure)");
      },
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof Error);
  assert.equal(caught instanceof ConsolidationQuotaError, false);
  assert.match(caught.message, /Quota exceeded/);

  const mapped = httpBodyForConsolidationError(caught);
  assert.equal(mapped.status, 502);
  assert.equal("retryAfterMs" in mapped.json, false);

  const after = countRows();
  assert.equal(after.memories, before.memories);
  assert.equal(after.thoughts, before.thoughts);
  assert.equal(after.receipts, before.receipts);
  assert.equal(
    db
      .select()
      .from(consolidationReceipts)
      .all()
      .some((row) => row.batchId === fakeQuotaId),
    false,
  );
}

// --- 7) 无 batchId 旧客户端仍兼容 ---
{
  const legacyTurns = [
    { role: "user" as const, text: "旧客户端路径请记住喝了咖啡" },
    { role: "companion" as const, text: "好" },
  ];
  const receiptsBefore = countRows().receipts;
  let legacyGenerate = 0;

  const legacy = await consolidateConversation({
    body: { occurredOn, turns: legacyTurns },
    memory,
    thoughts,
    generate: async () => {
      legacyGenerate += 1;
      return JSON.stringify({
        episodes: [
          {
            date: occurredOn,
            content: "喝了咖啡",
            importance: "low",
          },
        ],
        impressions: [],
        retireImpressions: [],
        notes: [],
        profile: [],
        between: [],
        resolveBetween: [],
        views: [],
        unresolved: [],
        resolveUnresolved: [],
        question: [],
        resolveQuestion: [],
      });
    },
  });

  assert.equal(legacyGenerate, 1);
  assert.ok(legacy.saved.episodes >= 1);
  assert.equal(countRows().receipts, receiptsBefore, "legacy must not write receipt");
}

// --- 8) 并发相同批次不会重复应用 ---
// 边界：单 Node 事件环 + 同一 better-sqlite3 连接上的同步 IMMEDIATE 事务串行；
// 不验证多进程／多连接竞争。
{
  const raceId = "race0000-0000-4000-8000-000000000004";
  const raceTurns = [
    { role: "user" as const, text: "并发整理测试记得去书店" },
    { role: "companion" as const, text: "好" },
  ];
  const raceHash = computeConsolidationPayloadHash(occurredOn, raceTurns);
  let applyCount = 0;
  const before = countRows();

  const emptySaved = {
    episodes: 1,
    impressions: 0,
    notes: 0,
    profile: 0,
    between: 0,
    closedBetween: 0,
    retired: 0,
    views: 0,
    unresolved: 0,
    question: 0,
    closedUnresolved: 0,
    closedQuestion: 0,
  };

  const run = () =>
    commitConsolidationWithReceipt({
      batchId: raceId,
      payloadHash: raceHash,
      occurredOn,
      apply: () => {
        applyCount += 1;
        memory.saveEpisode(occurredOn, "去了书店", "medium");
        return { saved: emptySaved };
      },
    });

  const [a, b] = await Promise.all([
    Promise.resolve().then(run),
    Promise.resolve().then(run),
  ]);

  assert.equal(applyCount, 1);
  assert.deepEqual(a.saved, b.saved);
  assert.equal(countRows().receipts, before.receipts + 1);
}

// --- 8b) 空结果同 batchId 并发：一份收据、结果一致 ---
// 同上：单事件环／单连接边界，非多进程。
{
  const emptyRaceId = "emprace0-0000-4000-8000-000000000005";
  const emptyRaceTurns = [{ role: "user" as const, text: "天气怎么样" }];
  const emptyRaceHash = computeConsolidationPayloadHash(
    occurredOn,
    emptyRaceTurns,
  );
  const before = countRows();

  const run = () =>
    consolidateConversation({
      body: {
        occurredOn,
        turns: emptyRaceTurns,
        batchId: emptyRaceId,
        payloadHash: emptyRaceHash,
      },
      memory,
      thoughts,
      generate: async () => {
        throw new Error("LLM must not run for disposable empty race");
      },
    });

  const [a, b] = await Promise.all([run(), run()]);

  assert.deepEqual(a.saved, b.saved);
  assert.equal(a.saved.episodes, 0);
  assert.equal(countRows().receipts, before.receipts + 1);
  assert.equal(
    db
      .select()
      .from(consolidationReceipts)
      .all()
      .filter((row) => row.batchId === emptyRaceId).length,
    1,
  );
}

// --- 8c) 同 batchId、不同 hash 竞争：一方成功、一方 409；仅一次 apply ---
// 同上：单事件环／单连接边界，非多进程。
{
  const conflictRaceId = "conflict-0000-4000-8000-000000000006";
  const turnsA = [
    { role: "user" as const, text: "竞争正文甲请记住去了公园" },
    { role: "companion" as const, text: "好" },
  ];
  const turnsB = [
    { role: "user" as const, text: "竞争正文乙请记住去了海边" },
    { role: "companion" as const, text: "好" },
  ];
  const hashA = computeConsolidationPayloadHash(occurredOn, turnsA);
  const hashB = computeConsolidationPayloadHash(occurredOn, turnsB);
  let applyCount = 0;
  const before = countRows();

  const savedShape = {
    episodes: 1,
    impressions: 0,
    notes: 0,
    profile: 0,
    between: 0,
    closedBetween: 0,
    retired: 0,
    views: 0,
    unresolved: 0,
    question: 0,
    closedUnresolved: 0,
    closedQuestion: 0,
  };

  const runA = () =>
    commitConsolidationWithReceipt({
      batchId: conflictRaceId,
      payloadHash: hashA,
      occurredOn,
      apply: () => {
        applyCount += 1;
        memory.saveEpisode(occurredOn, "去了公园", "medium");
        return { saved: savedShape };
      },
    });

  const runB = () =>
    commitConsolidationWithReceipt({
      batchId: conflictRaceId,
      payloadHash: hashB,
      occurredOn,
      apply: () => {
        applyCount += 1;
        memory.saveEpisode(occurredOn, "去了海边", "medium");
        return { saved: savedShape };
      },
    });

  const settled = await Promise.allSettled([
    Promise.resolve().then(runA),
    Promise.resolve().then(runB),
  ]);

  const fulfilled = settled.filter((item) => item.status === "fulfilled");
  const rejected = settled.filter((item) => item.status === "rejected");

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(
    rejected[0]!.status === "rejected" &&
      rejected[0].reason instanceof ConsolidationPayloadConflictError,
  );
  assert.equal(applyCount, 1);
  assert.equal(countRows().receipts, before.receipts + 1);
  assert.equal(countRows().memories, before.memories + 1);

  const mapped = httpBodyForConsolidationError(
    (rejected[0] as PromiseRejectedResult).reason,
  );
  assert.equal(mapped.status, 409);
}

// --- 9) 方案 A：带 batchId 保留冻结日；无 batchId 仍两日窗口 ---
{
  const serverToday = formatLocalDate();
  // 相对服务器今天远超 +3 天，无需注入 formatLocalDate。
  const frozenD0 = "2020-01-01";
  assert.notEqual(frozenD0, serverToday);

  const hashTurns = [{ role: "user" as const, text: "天气怎么样" }];
  const before = countRows();

  // 9a) 无 batchId：过旧日期仍改写为服务器当天
  const legacy = readConsolidationRequest({
    occurredOn: frozenD0,
    turns: hashTurns,
  });
  assert.equal(legacy.today, serverToday);

  // 9b) 带 batchId + 正确冻结 hash：保留 D0，即使距服务器今天 >2 天
  const frozenHash = computeConsolidationPayloadHash(frozenD0, hashTurns);
  const staleId = "hashok00-0000-4000-8000-000000000008";
  const ok = await consolidateConversation({
    body: {
      occurredOn: frozenD0,
      turns: hashTurns,
      batchId: staleId,
      payloadHash: frozenHash,
    },
    memory,
    thoughts,
    generate: async () => {
      throw new Error("unreachable");
    },
  });
  assert.equal(ok.saved.episodes, 0);
  const receipt = db
    .select()
    .from(consolidationReceipts)
    .all()
    .find((row) => row.batchId === staleId);
  assert.ok(receipt);
  assert.equal(receipt.occurredOn, frozenD0);
  assert.equal(receipt.payloadHash, frozenHash);

  // 9c) 同 ID 同 hash 重放：不重复应用、无副作用
  const rowsAfterOk = countRows();
  const replay = await consolidateConversation({
    body: {
      occurredOn: frozenD0,
      turns: hashTurns,
      batchId: staleId,
      payloadHash: frozenHash,
    },
    memory,
    thoughts,
    generate: async () => {
      throw new Error("unreachable");
    },
  });
  assert.deepEqual(replay.saved, ok.saved);
  assert.equal(countRows().receipts, rowsAfterOk.receipts);
  assert.equal(countRows().memories, rowsAfterOk.memories);
  assert.equal(countRows().thoughts, rowsAfterOk.thoughts);

  // 9d) 带 batchId 但 hash 按「改写后的今天」计算 → 不匹配 → 400，无副作用
  const mismatchBefore = countRows();
  await assert.rejects(
    () =>
      consolidateConversation({
        body: {
          occurredOn: frozenD0,
          turns: hashTurns,
          batchId: "hashbad0-0000-4000-8000-000000000007",
          payloadHash: computeConsolidationPayloadHash(serverToday, hashTurns),
        },
        memory,
        thoughts,
        generate: async () => {
          throw new Error("unreachable");
        },
      }),
    (error: unknown) =>
      error instanceof ConsolidationInputError &&
      /payloadHash does not match/.test(error.message),
  );
  assert.deepEqual(countRows(), mismatchBefore);

  // 9e) 非法／非日历日期 + batchId → 400，无副作用
  for (const [badDate, suffix] of [
    ["not-a-date", "9"],
    ["2026-02-31", "a"],
  ] as const) {
    const snap = countRows();
    let rejected: unknown;

    await assert.rejects(
      async () => {
        try {
          await consolidateConversation({
            body: {
              occurredOn: badDate,
              turns: hashTurns,
              batchId: `hashinv0-0000-4000-8000-00000000000${suffix}`,
              payloadHash: frozenHash,
            },
            memory,
            thoughts,
            generate: async () => {
              throw new Error("unreachable");
            },
          });
        } catch (error) {
          rejected = error;
          throw error;
        }
      },
      (error: unknown) => error instanceof ConsolidationInputError,
    );
    assert.equal(httpBodyForConsolidationError(rejected).status, 400);
    assert.deepEqual(countRows(), snap);
  }

  // 9f) 同 ID 异 hash → 409（沿用已有 receipt）
  const otherTurns = [
    { role: "user" as const, text: "完全另一段足够长的对话内容" },
    { role: "companion" as const, text: "嗯" },
  ];
  const conflictBefore = countRows();
  await assert.rejects(
    () =>
      consolidateConversation({
        body: {
          occurredOn: frozenD0,
          turns: otherTurns,
          batchId: staleId,
          payloadHash: computeConsolidationPayloadHash(frozenD0, otherTurns),
        },
        memory,
        thoughts,
        generate: async () => {
          throw new Error("unreachable");
        },
      }),
    (error: unknown) => error instanceof ConsolidationPayloadConflictError,
  );
  assert.equal(
    httpBodyForConsolidationError(
      new ConsolidationPayloadConflictError("x"),
    ).status,
    409,
  );
  assert.deepEqual(countRows(), conflictBefore);

  // 基线：本节开始前的行数只增 1 张收据（staleId）
  assert.equal(countRows().receipts, before.receipts + 1);
}

console.log("[consolidate-idempotency] offline ok");
