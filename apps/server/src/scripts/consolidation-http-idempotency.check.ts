/**
 * consolidate HTTP 幂等：生产 `registerConsolidateRoute` + 临时 SQLite + mock LLM。
 * 不触碰正式 companion.db；不连 127.0.0.1:3000；不读 .env。
 */
import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import express from "express";
import {
  prepareOfflineDb,
  assertOfflineDbIsolated,
  cleanupOfflineDb,
} from "./offlineDb.ts";

function assertUnderTmpdir(absolutePath: string, label: string): void {
  const resolved = resolve(absolutePath);
  const tempRoot = realpathSync(resolve(tmpdir()));
  const probe = existsSync(resolved) ? realpathSync(resolved) : realpathSync(dirname(resolved));
  assert.ok(
    probe === tempRoot || probe.startsWith(`${tempRoot}/`),
    `${label} must live under os.tmpdir(): ${probe} (from ${resolved})`,
  );
}

const file = prepareOfflineDb("consolidation-http-idempotency-");
assertUnderTmpdir(file, "prepared COMPANION_DB");

const bootstrap = new Database(file);
bootstrap.exec(`
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
bootstrap.close();

const opened = await assertOfflineDbIsolated(file);
console.log("[consolidation-http-idempotency] isolated db", opened);
assert.equal(realpathSync(opened), realpathSync(resolve(file)));
assertUnderTmpdir(opened, "opened dbFile");

const { computeConsolidationPayloadHash } = await import(
  "../memory/consolidate.ts"
);
const { registerConsolidateRoute } = await import(
  "../memory/consolidateRoute.ts"
);
const { MemoryManager } = await import("../memory/MemoryManager");
const { MemoryStore } = await import("../memory/MemoryStore");
const { ThoughtStore } = await import("../companion/ThoughtStore");
const { db, dbFile } = await import("../db/index.ts");
const { consolidationReceipts } = await import("../db/schema.ts");
const { memories } = await import("../db/schema.ts");
const { companionThoughts } = await import("../db/schema.ts");

assert.equal(realpathSync(resolve(dbFile)), realpathSync(opened));

function countRows(): { memories: number; thoughts: number; receipts: number } {
  return {
    memories: db.select().from(memories).all().length,
    thoughts: db.select().from(companionThoughts).all().length,
    receipts: db.select().from(consolidationReceipts).all().length,
  };
}

const occurredOn = "2026-10-20";
const turns = [
  { role: "user" as const, text: "我周末去看了展，记得一下" },
  { role: "companion" as const, text: "好，我记下了。" },
];
const payloadHash = computeConsolidationPayloadHash(occurredOn, turns);
const batchId = "http1111-2222-4333-8444-555555555555";

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

const store = new MemoryStore();
const baseMemory = new MemoryManager(store, null, null);
const thoughts = new ThoughtStore();

let generateCalls = 0;
let episodeApplyCalls = 0;
let failAfterFirstEpisode = false;
/** 测试可替换 mock plan；默认 T1／T2 用 planJson。 */
let activePlanJson = planJson;

const deps = {
  memory: baseMemory as InstanceType<typeof MemoryManager>,
  thoughts,
  generate: async () => {
    generateCalls += 1;
    return activePlanJson;
  },
};

const originalSaveEpisode = baseMemory.saveEpisode.bind(baseMemory);
baseMemory.saveEpisode = ((date, content, importance) => {
  episodeApplyCalls += 1;
  const result = originalSaveEpisode(date, content, importance);
  if (failAfterFirstEpisode) {
    throw new Error("injected apply failure after memory write");
  }
  return result;
}) as typeof baseMemory.saveEpisode;

const app = express();
app.use(express.json());
registerConsolidateRoute(app, deps);

const server = http.createServer(app);
await new Promise<void>((resolveListen, rejectListen) => {
  server.once("error", rejectListen);
  server.listen(0, "127.0.0.1", () => resolveListen());
});

const address = server.address();
assert.ok(address && typeof address === "object");
const port = address.port;
assert.notEqual(port, 3000, "must not bind production port");

type HttpOk = { status: number; json: unknown };
type HttpDiscarded = { discarded: true; status: number };

function postConsolidate(
  body: unknown,
  options?: { discardResponseBody?: boolean },
): Promise<HttpOk | HttpDiscarded> {
  const payload = JSON.stringify(body);

  return new Promise((resolvePost, rejectPost) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/memory/consolidate",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        if (options?.discardResponseBody) {
          // 客户端已收到响应头/status；handler 已 await 完成（事务已提交）。丢弃 body，不解析。
          res.resume();
          res.destroy();
          req.destroy();
          resolvePost({ discarded: true, status: res.statusCode ?? 0 });
          return;
        }

        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json: unknown;
          try {
            json = raw ? JSON.parse(raw) : undefined;
          } catch {
            json = { parseError: true, raw };
          }
          resolvePost({ status: res.statusCode ?? 0, json });
        });
        res.on("error", rejectPost);
      },
    );

    req.on("error", (error) => {
      // destroy 后可能触发；丢弃响应路径已 resolve
      if (options?.discardResponseBody) return;
      rejectPost(error);
    });
    req.write(payload);
    req.end();
  });
}

const body = {
  occurredOn,
  turns,
  batchId,
  payloadHash,
};

let firstSaved: unknown;

try {
  // --- T1：首次请求成功 ---
  {
    const before = countRows();
    generateCalls = 0;
    episodeApplyCalls = 0;

    const result = await postConsolidate(body);
    assert.ok(!("discarded" in result), "T1 must observe full response");
    assert.equal(result.status, 200);
    assert.ok(result.json && typeof result.json === "object");
    const saved = (result.json as { saved: { episodes: number; views: number } })
      .saved;
    assert.ok(saved.episodes >= 1);
    assert.ok(saved.views >= 1);
    assert.equal(generateCalls, 1);
    assert.ok(episodeApplyCalls >= 1);
    firstSaved = (result.json as { saved: unknown }).saved;

    const after = countRows();
    assert.equal(after.receipts, before.receipts + 1);
    assert.ok(after.memories > before.memories);
    assert.ok(after.thoughts > before.thoughts);

    const receipt = db
      .select()
      .from(consolidationReceipts)
      .all()
      .find((row) => row.batchId === batchId);
    assert.ok(receipt);
    assert.equal(receipt.payloadHash, payloadHash);
    assert.equal(receipt.occurredOn, occurredOn);
    console.log("[consolidation-http-idempotency] T1 ok");
  }

  const afterT1 = countRows();
  const generateAfterT1 = generateCalls;
  const episodesAfterT1 = episodeApplyCalls;

  // --- T2：相同请求重放 ---
  {
    const result = await postConsolidate(body);
    assert.ok(!("discarded" in result), "T2 must observe full response");
    assert.equal(result.status, 200);
    assert.deepEqual(
      (result.json as { saved: unknown }).saved,
      firstSaved,
    );
    assert.equal(generateCalls, generateAfterT1, "replay must not call LLM");
    assert.equal(
      episodeApplyCalls,
      episodesAfterT1,
      "replay must not re-apply episodes",
    );
    assert.deepEqual(countRows(), afterT1);
    console.log("[consolidation-http-idempotency] T2 ok");
  }

  // --- T3：相同 ID、不同 payload → 409 ---
  {
    const otherTurns = [
      { role: "user" as const, text: "我改去海边了，记得一下" },
      { role: "companion" as const, text: "好" },
    ];
    const otherHash = computeConsolidationPayloadHash(occurredOn, otherTurns);
    assert.notEqual(otherHash, payloadHash);

    const before = countRows();
    const genBefore = generateCalls;
    const epBefore = episodeApplyCalls;

    const result = await postConsolidate({
      occurredOn,
      turns: otherTurns,
      batchId,
      payloadHash: otherHash,
    });
    assert.ok(!("discarded" in result), "T3 must observe full response");
    assert.equal(result.status, 409);
    assert.deepEqual(countRows(), before);
    assert.equal(generateCalls, genBefore);
    assert.equal(episodeApplyCalls, epBefore);
    console.log("[consolidation-http-idempotency] T3 ok");
  }

  // --- T4：事务中途失败 → 全回滚；库仍可用 ---
  {
    const failId = "httpfail-2222-4333-8444-555555555555";
    const failTurns = [
      { role: "user" as const, text: "事务回滚 HTTP 测试请记住书店" },
      { role: "companion" as const, text: "好" },
    ];
    const failHash = computeConsolidationPayloadHash(occurredOn, failTurns);
    const before = countRows();
    const genBefore = generateCalls;

    failAfterFirstEpisode = true;
    const result = await postConsolidate({
      occurredOn,
      turns: failTurns,
      batchId: failId,
      payloadHash: failHash,
    });
    failAfterFirstEpisode = false;

    assert.ok(!("discarded" in result), "T4 must observe full response");
    assert.equal(result.status, 502);
    assert.deepEqual(countRows(), before);
    assert.equal(
      db
        .select()
        .from(consolidationReceipts)
        .all()
        .some((row) => row.batchId === failId),
      false,
    );
    assert.equal(generateCalls, genBefore + 1, "LLM ran before apply failed");

    // 同一临时库仍可继续：成功写入另一批次
    const recoverId = "httprecv-2222-4333-8444-555555555555";
    const recoverTurns = [
      { role: "user" as const, text: "回滚后继续整理请记住咖啡馆" },
      { role: "companion" as const, text: "好" },
    ];
    const recoverHash = computeConsolidationPayloadHash(
      occurredOn,
      recoverTurns,
    );
    const recover = await postConsolidate({
      occurredOn,
      turns: recoverTurns,
      batchId: recoverId,
      payloadHash: recoverHash,
    });
    assert.ok(!("discarded" in recover), "T4 recover must observe full response");
    assert.equal(recover.status, 200);
    assert.ok(countRows().receipts > before.receipts);
    console.log("[consolidation-http-idempotency] T4 ok");
  }

  // --- T5：提交成功后客户端丢弃响应体，再以相同 batchId/payloadHash/turns/occurredOn 重放，验证不重复应用 ---
  {
    const lostOn = "2026-10-21";
    const lostId = "httplost-2222-4333-8444-555555555555";
    const lostTurns = [
      { role: "user" as const, text: "丢弃响应体测试请记住去了公园" },
      { role: "companion" as const, text: "好" },
    ];
    const lostHash = computeConsolidationPayloadHash(lostOn, lostTurns);
    const before = countRows();
    const genBefore = generateCalls;
    const epBefore = episodeApplyCalls;

    activePlanJson = JSON.stringify({
      episodes: [
        {
          date: lostOn,
          content: "丢弃响应体测试去了公园",
          importance: "medium",
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

    const lostBody = {
      occurredOn: lostOn,
      turns: lostTurns,
      batchId: lostId,
      payloadHash: lostHash,
    };

    const first = await postConsolidate(lostBody, {
      discardResponseBody: true,
    });
    assert.ok("discarded" in first && first.discarded);
    assert.equal(first.status, 200);

    // 明确观测：丢弃 body 前客户端已见 200；服务端事务已提交（不靠 sleep）
    const mid = countRows();
    assert.equal(mid.receipts, before.receipts + 1);
    assert.ok(mid.memories > before.memories);
    const receipt = db
      .select()
      .from(consolidationReceipts)
      .all()
      .find((row) => row.batchId === lostId);
    assert.ok(receipt);
    assert.equal(receipt.payloadHash, lostHash);
    assert.equal(receipt.occurredOn, lostOn);
    assert.equal(generateCalls, genBefore + 1);
    assert.ok(episodeApplyCalls > epBefore);

    const genAfterCommit = generateCalls;
    const epAfterCommit = episodeApplyCalls;
    const rowsAfterCommit = countRows();

    const replay = await postConsolidate(lostBody);
    assert.ok(!("discarded" in replay), "T5 replay must observe full response");
    assert.equal(replay.status, 200);
    assert.ok(replay.json && typeof replay.json === "object");
    assert.equal(generateCalls, genAfterCommit, "replay must not call LLM");
    assert.equal(
      episodeApplyCalls,
      epAfterCommit,
      "replay must not re-apply",
    );
    assert.deepEqual(countRows(), rowsAfterCommit);
    activePlanJson = planJson;
    console.log(
      "[consolidation-http-idempotency] T5 discard-body-then-replay ok",
    );
  }

  console.log("[consolidation-http-idempotency] ok");
} finally {
  await new Promise<void>((resolveClose) => {
    server.close(() => resolveClose());
  });
  cleanupOfflineDb(file);
}
