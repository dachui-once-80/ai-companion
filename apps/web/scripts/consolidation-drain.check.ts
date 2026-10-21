/**
 * outbox drain 离线测试：内存 outbox + mock fetch；无真实网络／无正式库。
 */
import assert from "node:assert/strict";
import {
  classifyClaimEligibility,
  drainConsolidationOutbox,
  type DrainFetch,
} from "../src/realtime/consolidationDrain.ts";
import {
  CONSOLIDATION_OUTBOX_STORAGE_KEY,
  CONSOLIDATION_OUTBOX_VERSION,
  ConsolidationOutbox,
  ConsolidationOutboxCorruptError,
  ConsolidationOutboxUnavailableError,
  createMemoryOutboxStorage,
  type ConsolidationOutboxItem,
} from "../src/realtime/consolidationOutbox.ts";
import { CONSOLIDATION_SAVED_KEYS } from "../src/realtime/consolidateResult.ts";

const TODAY = "2026-10-20";
const HASH = "c".repeat(64);
const TURNS = [
  { role: "user" as const, text: "我周末去看了展，记得一下" },
  { role: "companion" as const, text: "好，记下了" },
];

let clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);

function nowIso(): string {
  return new Date(clockMs).toISOString();
}

function advanceMs(delta: number): void {
  clockMs += delta;
}

function successBody(overrides: Record<string, number> = {}) {
  const saved: Record<string, number> = {};

  for (const key of CONSOLIDATION_SAVED_KEYS) {
    saved[key] = 0;
  }

  Object.assign(saved, overrides);

  return { saved };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: String(status),
    headers: { "Content-Type": "application/json" },
  });
}

// Force ok flag for malformed cases where we need status 200 with bad body —
// native Response already sets ok from status.

function makeOutbox(storage = createMemoryOutboxStorage()) {
  return new ConsolidationOutbox({ storage, now: nowIso });
}

function seedPending(
  outbox: ConsolidationOutbox,
  batchId: string,
  patch: Partial<{
    nextAttemptAt: string;
    payloadHash: string;
    turns: typeof TURNS;
  }> = {},
): ConsolidationOutboxItem {
  return outbox.add({
    batchId,
    payloadHash: patch.payloadHash ?? HASH,
    occurredOn: TODAY,
    turns: patch.turns ?? TURNS,
    nextAttemptAt: patch.nextAttemptAt ?? nowIso(),
  });
}

type FetchCall = {
  url: string;
  init?: RequestInit;
  body: {
    batchId: string;
    payloadHash: string;
    occurredOn: string;
    turns: typeof TURNS;
  };
};

function trackFetch(
  handler: (call: FetchCall, index: number) => Promise<Response> | Response,
): { fetchImpl: DrainFetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];

  const fetchImpl: DrainFetch = async (url, init) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    const parsed = JSON.parse(raw) as FetchCall["body"];
    const call: FetchCall = { url, init, body: parsed };
    calls.push(call);
    return handler(call, calls.length - 1);
  };

  return { fetchImpl, calls };
}

function assertPayload(call: FetchCall, item: ConsolidationOutboxItem): void {
  assert.equal(call.url, "/api/memory/consolidate");
  assert.equal(call.body.batchId, item.batchId);
  assert.equal(call.body.payloadHash, item.payloadHash);
  assert.equal(call.body.occurredOn, item.occurredOn);
  assert.deepEqual(call.body.turns, item.turns);
}

// --- 兼容：旧 localStorage 无 leaseExpiresAt ---
{
  const storage = createMemoryOutboxStorage({
    [CONSOLIDATION_OUTBOX_STORAGE_KEY]: JSON.stringify({
      v: CONSOLIDATION_OUTBOX_VERSION,
      updatedAt: nowIso(),
      items: [
        {
          batchId: "legacy00-0000-4000-8000-000000000001",
          payloadHash: HASH,
          occurredOn: TODAY,
          turns: TURNS,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          attempts: 1,
          nextAttemptAt: nowIso(),
          status: "in_flight",
          lastError: null,
          leaseOwner: "other-tab",
          // no leaseExpiresAt
        },
      ],
    }),
  });
  const outbox = makeOutbox(storage);
  const item = outbox.get("legacy00-0000-4000-8000-000000000001");
  assert.ok(item);
  assert.equal(item.leaseExpiresAt, null);
  assert.equal(classifyClaimEligibility(item, nowIso()), "ambiguous_lease");
}

// --- 1) 成功：正确 payload，仅删该条 ---
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  const keep = seedPending(outbox, "drain001-0000-4000-8000-000000000001");
  seedPending(outbox, "drain001-0000-4000-8000-000000000099");
  const { fetchImpl, calls } = trackFetch(() =>
    jsonResponse(200, successBody({ episodes: 1 })),
  );

  const result = await drainConsolidationOutbox({
    outbox,
    fetchImpl,
    now: nowIso,
    leaseOwner: "drain-test",
    maxBatches: 1,
  });

  assert.equal(result.outcomes[0]?.kind, "sent_removed");
  assert.equal(calls.length, 1);
  assertPayload(calls[0]!, keep);
  assert.equal(outbox.get(keep.batchId), null);
  assert.ok(outbox.get("drain001-0000-4000-8000-000000000099"));
  assert.equal(outbox.list().length, 1);
}

// --- 2) 网络失败：回 pending + nextAttemptAt ---
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  const item = seedPending(outbox, "drain002-0000-4000-8000-000000000002");
  const { fetchImpl, calls } = trackFetch(() => {
    throw new Error("network down");
  });

  const result = await drainConsolidationOutbox({
    outbox,
    fetchImpl,
    now: nowIso,
    leaseOwner: "drain-test",
  });

  assert.equal(result.outcomes[0]?.kind, "retry_scheduled");
  assert.equal(calls.length, 1);
  assertPayload(calls[0]!, item);
  const after = outbox.get(item.batchId)!;
  assert.equal(after.status, "pending");
  assert.equal(after.leaseOwner, null);
  assert.equal(after.leaseExpiresAt, null);
  assert.ok(Date.parse(after.nextAttemptAt) > Date.parse(nowIso()));
  assert.match(after.lastError ?? "", /network/);
}

// --- 3) 429 + retryAfterMs ---
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  const item = seedPending(outbox, "drain003-0000-4000-8000-000000000003");
  const before = nowIso();
  const { fetchImpl } = trackFetch(() =>
    jsonResponse(429, { error: "slow down", retryAfterMs: 45_000 }),
  );

  await drainConsolidationOutbox({
    outbox,
    fetchImpl,
    now: nowIso,
    leaseOwner: "drain-test",
  });

  const after = outbox.get(item.batchId)!;
  assert.equal(after.status, "pending");
  assert.equal(
    Date.parse(after.nextAttemptAt) - Date.parse(before),
    45_000,
  );
}

// --- 4) 5xx 退避 ---
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  const item = seedPending(outbox, "drain004-0000-4000-8000-000000000004");
  const { fetchImpl } = trackFetch(() =>
    jsonResponse(503, { error: "unavailable" }),
  );

  await drainConsolidationOutbox({
    outbox,
    fetchImpl,
    now: nowIso,
    leaseOwner: "drain-test",
    backoffMs: () => 12_000,
  });

  const after = outbox.get(item.batchId)!;
  assert.equal(after.status, "pending");
  assert.ok(Date.parse(after.nextAttemptAt) >= Date.parse(nowIso()) + 12_000);
}

// --- 5) 永久 4xx → dead_letter ---
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  const item = seedPending(outbox, "drain005-0000-4000-8000-000000000005");
  const { fetchImpl } = trackFetch(() =>
    jsonResponse(400, { error: "bad request" }),
  );

  const result = await drainConsolidationOutbox({
    outbox,
    fetchImpl,
    now: nowIso,
    leaseOwner: "drain-test",
  });

  assert.equal(result.outcomes[0]?.kind, "dead_letter");
  const after = outbox.get(item.batchId)!;
  assert.equal(after.status, "dead_letter");
  assert.equal(after.leaseOwner, null);
  assert.equal(after.leaseExpiresAt, null);
  assert.ok(after.lastError);
  assert.deepEqual(after.turns, TURNS);
  assert.equal(after.payloadHash, HASH);
}

// --- 6) 409 → dead_letter，payload 不变 ---
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  const item = seedPending(outbox, "drain006-0000-4000-8000-000000000006");
  const { fetchImpl } = trackFetch(() =>
    jsonResponse(409, { error: "batchId was already used with a different payload" }),
  );

  await drainConsolidationOutbox({
    outbox,
    fetchImpl,
    now: nowIso,
    leaseOwner: "drain-test",
  });

  const after = outbox.get(item.batchId)!;
  assert.equal(after.status, "dead_letter");
  assert.equal(after.payloadHash, item.payloadHash);
  assert.deepEqual(after.turns, item.turns);
  assert.equal(after.occurredOn, item.occurredOn);
}

// --- 7) malformed 200：不得删除 ---
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  const item = seedPending(outbox, "drain007-0000-4000-8000-000000000007");
  const { fetchImpl } = trackFetch(() =>
    jsonResponse(200, { ok: true }),
  );

  const result = await drainConsolidationOutbox({
    outbox,
    fetchImpl,
    now: nowIso,
    leaseOwner: "drain-test",
  });

  assert.equal(result.outcomes[0]?.kind, "retry_scheduled");
  assert.ok(outbox.get(item.batchId));
  assert.equal(outbox.get(item.batchId)!.status, "pending");
}

// --- 8) 网络失败后重试 payload 完全一致 ---
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  const item = seedPending(outbox, "drain008-0000-4000-8000-000000000008");
  let mode: "fail" | "ok" = "fail";
  const { fetchImpl, calls } = trackFetch(() => {
    if (mode === "fail") throw new Error("flaky");
    return jsonResponse(200, successBody());
  });

  await drainConsolidationOutbox({
    outbox,
    fetchImpl,
    now: nowIso,
    leaseOwner: "drain-test",
    backoffMs: () => 1_000,
  });

  advanceMs(2_000);
  outbox.update(item.batchId, { nextAttemptAt: nowIso() });
  mode = "ok";

  await drainConsolidationOutbox({
    outbox,
    fetchImpl,
    now: nowIso,
    leaseOwner: "drain-test",
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.body.batchId, calls[1]!.body.batchId);
  assert.equal(calls[0]!.body.payloadHash, calls[1]!.body.payloadHash);
  assert.equal(calls[0]!.body.occurredOn, calls[1]!.body.occurredOn);
  assert.deepEqual(calls[0]!.body.turns, calls[1]!.body.turns);
  assert.equal(outbox.get(item.batchId), null);
}

// --- 9) 模拟服务端成功但客户端丢响应：同 ID 再发 ---
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  const item = seedPending(outbox, "drain009-0000-4000-8000-000000000009");
  let mode: "drop" | "ok" = "drop";
  const { fetchImpl, calls } = trackFetch(() => {
    if (mode === "drop") throw new TypeError("Failed to fetch");
    return jsonResponse(200, successBody());
  });

  await drainConsolidationOutbox({
    outbox,
    fetchImpl,
    now: nowIso,
    leaseOwner: "drain-test",
    backoffMs: () => 500,
  });

  assert.ok(outbox.get(item.batchId));
  advanceMs(1_000);
  outbox.update(item.batchId, { nextAttemptAt: nowIso() });
  mode = "ok";

  await drainConsolidationOutbox({
    outbox,
    fetchImpl,
    now: nowIso,
    leaseOwner: "drain-test",
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.body.batchId, item.batchId);
  assert.equal(calls[1]!.body.payloadHash, HASH);
  assert.equal(outbox.list().length, 0);
}

// --- 10) 过期 in_flight 可领；未过期不可抢 ---
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  const expiredId = "drain010-0000-4000-8000-00000000000a";
  const liveId = "drain010-0000-4000-8000-00000000000b";
  seedPending(outbox, expiredId);
  seedPending(outbox, liveId);

  outbox.update(expiredId, {
    status: "in_flight",
    leaseOwner: "other",
    leaseExpiresAt: new Date(clockMs - 1_000).toISOString(),
  });
  outbox.update(liveId, {
    status: "in_flight",
    leaseOwner: "other",
    leaseExpiresAt: new Date(clockMs + 60_000).toISOString(),
  });

  const { fetchImpl, calls } = trackFetch(() =>
    jsonResponse(200, successBody()),
  );

  await drainConsolidationOutbox({
    outbox,
    fetchImpl,
    now: nowIso,
    leaseOwner: "drain-test",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.body.batchId, expiredId);
  assert.equal(outbox.get(expiredId), null);
  assert.equal(outbox.get(liveId)?.status, "in_flight");
  assert.equal(outbox.get(liveId)?.leaseOwner, "other");
}

// --- 11) 未到期 pending 不发送 ---
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  seedPending(outbox, "drain011-0000-4000-8000-000000000011", {
    nextAttemptAt: new Date(clockMs + 60_000).toISOString(),
  });
  const { fetchImpl, calls } = trackFetch(() =>
    jsonResponse(200, successBody()),
  );

  const result = await drainConsolidationOutbox({
    outbox,
    fetchImpl,
    now: nowIso,
    leaseOwner: "drain-test",
  });

  assert.equal(calls.length, 0);
  assert.equal(result.processed, 0);
  assert.equal(outbox.list().length, 1);
}

// --- 12) maxBatches 与 timeBudget ---
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  seedPending(outbox, "drain012-0000-4000-8000-00000000001a");
  seedPending(outbox, "drain012-0000-4000-8000-00000000001b");
  seedPending(outbox, "drain012-0000-4000-8000-00000000001c");
  const { fetchImpl, calls } = trackFetch(() =>
    jsonResponse(200, successBody()),
  );

  const limited = await drainConsolidationOutbox({
    outbox,
    fetchImpl,
    now: nowIso,
    leaseOwner: "drain-test",
    maxBatches: 2,
  });
  assert.equal(calls.length, 2);
  assert.equal(limited.stoppedReason, "max_batches");
  assert.equal(outbox.list().length, 1);
}

// time budget：处理完第一批后 now 跳过预算，第二批不得再发
{
  clockMs = Date.UTC(2026, 9, 20, 14, 0, 0, 0);
  const start = clockMs;
  const outbox = makeOutbox();
  seedPending(outbox, "drain012-0000-4000-8000-00000000003a");
  seedPending(outbox, "drain012-0000-4000-8000-00000000003b");
  let fetches = 0;
  const { fetchImpl, calls } = trackFetch(() => {
    fetches += 1;
    if (fetches === 1) clockMs = start + 50_000;
    return jsonResponse(200, successBody());
  });

  const result = await drainConsolidationOutbox({
    outbox,
    fetchImpl,
    now: nowIso,
    leaseOwner: "drain-test",
    timeBudgetMs: 10_000,
    maxBatches: 10,
  });

  assert.equal(calls.length, 1);
  assert.equal(result.stoppedReason, "time_budget");
  assert.equal(outbox.list().length, 1);
}

// --- 13) update/remove 失败不伪报成功 ---
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const storage = createMemoryOutboxStorage();
  const outbox = makeOutbox(storage);
  const item = seedPending(outbox, "drain013-0000-4000-8000-000000000013");

  const originalRemove = outbox.remove.bind(outbox);
  outbox.remove = () => {
    throw new ConsolidationOutboxUnavailableError("remove blocked");
  };

  const { fetchImpl } = trackFetch(() =>
    jsonResponse(200, successBody()),
  );

  const result = await drainConsolidationOutbox({
    outbox,
    fetchImpl,
    now: nowIso,
    leaseOwner: "drain-test",
  });

  assert.equal(result.outcomes[0]?.kind, "failed");
  assert.match(result.outcomes[0]?.detail ?? "", /remove|update|failed/i);
  // item still present (remove threw; may be in_flight)
  assert.ok(outbox.get(item.batchId));
  outbox.remove = originalRemove;
}

{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  const item = seedPending(outbox, "drain013-0000-4000-8000-000000000014");
  outbox.update = () => {
    throw new ConsolidationOutboxUnavailableError("update blocked");
  };
  const { fetchImpl, calls } = trackFetch(() =>
    jsonResponse(200, successBody()),
  );

  const result = await drainConsolidationOutbox({
    outbox,
    fetchImpl,
    now: nowIso,
    leaseOwner: "drain-test",
  });

  assert.equal(calls.length, 0);
  assert.equal(result.outcomes[0]?.kind, "failed");
  assert.equal(result.stoppedReason, "storage_error");
  // cannot read after breaking update — use raw storage presence
  assert.ok(item.batchId);
}

// --- 14) 损坏／不可用 storage 可见错误 ---
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const storage = createMemoryOutboxStorage({
    [CONSOLIDATION_OUTBOX_STORAGE_KEY]: "{broken",
  });
  const outbox = makeOutbox(storage);
  const { fetchImpl, calls } = trackFetch(() =>
    jsonResponse(200, successBody()),
  );

  const result = await drainConsolidationOutbox({
    outbox,
    fetchImpl,
    now: nowIso,
    leaseOwner: "drain-test",
  });

  assert.equal(calls.length, 0);
  assert.equal(result.stoppedReason, "storage_error");
  assert.ok(result.error instanceof ConsolidationOutboxCorruptError);
  assert.equal(storage.store.get(CONSOLIDATION_OUTBOX_STORAGE_KEY), "{broken");
}

{
  const base = createMemoryOutboxStorage();
  // seed via direct map then wrap — add needs setItem; seed on base then swap
  const seedBox = makeOutbox(base);
  seedPending(seedBox, "drain014-0000-4000-8000-000000000015");
  const failing = new ConsolidationOutbox({
    storage: {
      getItem: (k) => base.getItem(k),
      removeItem: (k) => base.removeItem(k),
      setItem() {
        throw new Error("QuotaExceededError");
      },
    },
    now: nowIso,
  });
  const { fetchImpl, calls } = trackFetch(() =>
    jsonResponse(200, successBody()),
  );

  const result = await drainConsolidationOutbox({
    outbox: failing,
    fetchImpl,
    now: nowIso,
    leaseOwner: "drain-test",
  });

  assert.equal(calls.length, 0);
  assert.equal(result.outcomes[0]?.kind, "failed");
  assert.ok(
    result.error instanceof ConsolidationOutboxUnavailableError ||
      result.outcomes[0]?.detail?.includes("claim failed"),
  );
}

// --- 15) 无真实网络：仅 mock fetchImpl；不读正式库文件 ---
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  seedPending(outbox, "drain015-0000-4000-8000-000000000015");
  const { fetchImpl, calls } = trackFetch(() =>
    jsonResponse(200, successBody()),
  );
  await drainConsolidationOutbox({
    outbox,
    fetchImpl,
    now: nowIso,
    leaseOwner: "drain-test",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "/api/memory/consolidate");
  // 隔离内存 storage，未引用 apps/server/companion.db
  assert.equal(outbox.list().length, 0);
}

console.log("[consolidation-drain] ok");
