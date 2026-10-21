/**
 * 1B-3D-3-R8-α：页面刷新后 outbox 恢复（离线模拟）。
 *
 * 覆盖：同一内存 Storage 上丢弃旧 RealtimeClient、新建客户端后仍可读 pending，
 * 再经 `scheduleBoundedDrainAfterConnect()`（connect adopt 后同款 helper）+ mock fetch。
 *
 * 明确边界：
 * - 新客户端重建的离线模拟，不等于真实浏览器 F5。
 * - 不等于 Gemini Live 端到端；不调用 live.connect。
 * - 禁止默认 fetch／localhost:3000／正式库。
 */
import assert from "node:assert/strict";
import { RealtimeClient } from "../src/realtime/RealtimeClient.ts";
import {
  CONSOLIDATION_OUTBOX_STORAGE_KEY,
  ConsolidationOutbox,
  createMemoryOutboxStorage,
  type ConsolidationOutboxItem,
} from "../src/realtime/consolidationOutbox.ts";
import {
  CONSOLIDATION_DRAIN_PATH,
  type DrainFetch,
} from "../src/realtime/consolidationDrain.ts";
import { computeConsolidationPayloadHash } from "../src/realtime/consolidationPayload.ts";

type RealtimeClientHarness = {
  scheduleBoundedDrainAfterConnect: () => void;
  activeDrain: Promise<unknown> | null;
};

function rcHarness(client: RealtimeClient): RealtimeClientHarness {
  return client as unknown as RealtimeClientHarness;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

async function waitUntil(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timeout waiting for ${label} (${timeoutMs}ms)`);
    }
    await flushMicrotasks();
  }
}

const OCCURRED_ON = "2026-10-20";
const MARKER = "R8-OUTBOX-RECOVERY";
const TURNS_OK = [
  { role: "user" as const, text: `${MARKER} success path remember park visit` },
  { role: "companion" as const, text: "ok" },
];
const TURNS_FAIL = [
  { role: "user" as const, text: `${MARKER} failure path remember cafe visit` },
  { role: "companion" as const, text: "ok" },
];

const BATCH_OK = "r8ok00-0000-4000-8000-000000000001";
const BATCH_FAIL = "r8fail-0000-4000-8000-000000000002";

let clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);

function nowIso(): string {
  clockMs += 1;
  return new Date(clockMs).toISOString();
}

function successBody() {
  return {
    saved: {
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
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type CapturedCall = {
  url: string;
  body: {
    batchId: string;
    payloadHash: string;
    occurredOn: string;
    turns: typeof TURNS_OK;
  };
};

function trackFetch(
  handler: (call: CapturedCall, index: number) => Promise<Response> | Response,
): { fetchImpl: DrainFetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl: DrainFetch = async (url, init) => {
    assert.equal(
      url,
      CONSOLIDATION_DRAIN_PATH,
      "drain must use relative consolidate path",
    );
    assert.ok(
      typeof url === "string" && !url.includes("localhost:3000"),
      "must not target localhost:3000",
    );
    const raw = typeof init?.body === "string" ? init.body : "";
    const body = JSON.parse(raw) as CapturedCall["body"];
    const call = { url, body };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { fetchImpl, calls };
}

function assertEnvelopeContains(
  storage: { getItem(key: string): string | null },
  batchId: string,
): void {
  const raw = storage.getItem(CONSOLIDATION_OUTBOX_STORAGE_KEY);
  assert.ok(raw, "outbox envelope must be written to shared storage");
  assert.ok(
    raw.includes(batchId),
    `shared storage must contain ${batchId}`,
  );
  assert.ok(raw.includes(MARKER), "shared storage must contain R8 marker");
}

function assertClaimablePending(item: ConsolidationOutboxItem, now: string): void {
  assert.equal(item.status, "pending");
  const due = Date.parse(item.nextAttemptAt);
  const nowMs = Date.parse(now);
  assert.ok(Number.isFinite(due) && Number.isFinite(nowMs));
  assert.ok(
    due <= nowMs,
    `nextAttemptAt must be due (got ${item.nextAttemptAt} vs ${now})`,
  );
}

function assertPayloadMatches(
  call: CapturedCall,
  item: ConsolidationOutboxItem,
): void {
  assert.equal(call.url, CONSOLIDATION_DRAIN_PATH);
  assert.equal(call.body.batchId, item.batchId);
  assert.equal(call.body.payloadHash, item.payloadHash);
  assert.equal(call.body.occurredOn, item.occurredOn);
  assert.deepEqual(call.body.turns, item.turns);
}

async function seedPending(
  outbox: ConsolidationOutbox,
  batchId: string,
  turns: typeof TURNS_OK,
): Promise<ConsolidationOutboxItem> {
  const dueAt = nowIso();
  const payloadHash = await computeConsolidationPayloadHash(OCCURRED_ON, turns);
  const item = outbox.add({
    batchId,
    payloadHash,
    occurredOn: OCCURRED_ON,
    turns,
    status: "pending",
    nextAttemptAt: dueAt,
  });
  assertClaimablePending(item, nowIso());
  return item;
}

/** 禁止任何泄漏到真实网络的默认 fetch。 */
let defaultFetchHits = 0;
const previousFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL) => {
  defaultFetchHits += 1;
  const label =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  throw new Error(`forbidden default fetch: ${label}`);
}) as typeof fetch;

function assertNoDefaultFetch(label: string): void {
  assert.equal(
    defaultFetchHits,
    0,
    `${label}: default fetch must never be called (hits=${defaultFetchHits})`,
  );
}

try {
  // --- 成功路径：共享 Storage → 丢弃旧客户端 → 新客户端 connect-drain → 删除 ---
  {
    clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
    const storage = createMemoryOutboxStorage();
    const writer = new ConsolidationOutbox({ storage, now: nowIso });
    const seeded = await seedPending(writer, BATCH_OK, TURNS_OK);
    assertEnvelopeContains(storage, BATCH_OK);

    const staleOutbox = new ConsolidationOutbox({ storage, now: nowIso });
    const { fetchImpl: staleFetch } = trackFetch(() => {
      throw new Error("stale client must not drain");
    });
    const oldClient = new RealtimeClient({
      consolidationOutbox: staleOutbox,
      drainFetchImpl: staleFetch,
      drainNow: nowIso,
      drainLeaseOwner: "r8-old-discarded",
    });
    assert.equal(staleOutbox.get(BATCH_OK)?.batchId, BATCH_OK);
    // 丢弃旧客户端引用（模拟刷新后旧实例消失）
    void oldClient;

    const freshOutbox = new ConsolidationOutbox({ storage, now: nowIso });
    const recovered = freshOutbox.get(BATCH_OK);
    assert.ok(recovered, "new outbox on same storage must recover pending batch");
    assert.equal(recovered.payloadHash, seeded.payloadHash);
    assert.deepEqual(recovered.turns, seeded.turns);
    assertClaimablePending(recovered, nowIso());

    const { fetchImpl, calls } = trackFetch(() =>
      jsonResponse(200, successBody()),
    );
    const client = new RealtimeClient({
      consolidationOutbox: freshOutbox,
      drainFetchImpl: fetchImpl,
      drainNow: nowIso,
      drainLeaseOwner: "r8-refresh-ok",
    });
    const h = rcHarness(client);

    h.scheduleBoundedDrainAfterConnect();
    await waitUntil(
      () => freshOutbox.get(BATCH_OK) === null,
      "R8 success: outbox item removed",
    );

    assert.equal(calls.length, 1);
    assertPayloadMatches(calls[0]!, seeded);
    assert.equal(h.activeDrain, null);
    assert.equal(freshOutbox.list().length, 0);
    assertNoDefaultFetch("success path");
    console.log("[consolidation-refresh-recovery] success path ok");
  }

  // --- 失败路径：重建后 drain 遇网络错误 → 保留并进入 pending 重试 ---
  {
    clockMs = Date.UTC(2026, 9, 20, 13, 0, 0, 0);
    const storage = createMemoryOutboxStorage();
    const writer = new ConsolidationOutbox({ storage, now: nowIso });
    const seeded = await seedPending(writer, BATCH_FAIL, TURNS_FAIL);
    assertEnvelopeContains(storage, BATCH_FAIL);

    void new RealtimeClient({
      consolidationOutbox: new ConsolidationOutbox({ storage, now: nowIso }),
      drainFetchImpl: async () => {
        throw new Error("stale client must not drain");
      },
      drainNow: nowIso,
      drainLeaseOwner: "r8-old-fail-discarded",
    });

    const freshOutbox = new ConsolidationOutbox({ storage, now: nowIso });
    const recovered = freshOutbox.get(BATCH_FAIL);
    assert.ok(recovered);
    assert.equal(recovered.payloadHash, seeded.payloadHash);
    assertClaimablePending(recovered, nowIso());
    const attemptsBefore = recovered.attempts;

    const { fetchImpl, calls } = trackFetch(() => {
      throw new TypeError("R8 simulated network failure");
    });
    const client = new RealtimeClient({
      consolidationOutbox: freshOutbox,
      drainFetchImpl: fetchImpl,
      drainNow: nowIso,
      drainLeaseOwner: "r8-refresh-fail",
    });
    const h = rcHarness(client);

    h.scheduleBoundedDrainAfterConnect();
    await waitUntil(
      () => {
        const item = freshOutbox.get(BATCH_FAIL);
        return (
          item !== null &&
          item.status === "pending" &&
          item.attempts > attemptsBefore &&
          h.activeDrain === null
        );
      },
      "R8 failure: retry pending after network error",
    );

    assert.equal(calls.length, 1);
    assertPayloadMatches(calls[0]!, seeded);

    const after = freshOutbox.get(BATCH_FAIL);
    assert.ok(after, "batch must remain after network failure");
    assert.equal(after.status, "pending");
    assert.equal(after.payloadHash, seeded.payloadHash);
    assert.deepEqual(after.turns, seeded.turns);
    assert.equal(after.occurredOn, seeded.occurredOn);
    assert.ok(after.attempts > attemptsBefore);
    assert.ok(
      after.lastError && after.lastError.includes("R8 simulated network failure"),
      `lastError should record network failure, got ${after.lastError}`,
    );
    const nextMs = Date.parse(after.nextAttemptAt);
    const nowMs = Date.parse(nowIso());
    assert.ok(nextMs > nowMs, "nextAttemptAt must be scheduled in the future");
    assert.equal(after.leaseOwner, null);
    assert.equal(after.leaseExpiresAt, null);
    assertNoDefaultFetch("failure path");
    console.log("[consolidation-refresh-recovery] failure path ok");
  }

  // --- 5xx 失败：同样保留并重试（断言对齐网络失败路径） ---
  {
    clockMs = Date.UTC(2026, 9, 20, 14, 0, 0, 0);
    const batchId = "r8f5xx-0000-4000-8000-000000000003";
    const turns = [
      { role: "user" as const, text: `${MARKER} 5xx path remember library` },
      { role: "companion" as const, text: "ok" },
    ];
    const storage = createMemoryOutboxStorage();
    const writer = new ConsolidationOutbox({ storage, now: nowIso });
    const seeded = await seedPending(writer, batchId, turns);

    void new RealtimeClient({
      consolidationOutbox: new ConsolidationOutbox({ storage, now: nowIso }),
      drainFetchImpl: async () => {
        throw new Error("stale client must not drain");
      },
      drainNow: nowIso,
      drainLeaseOwner: "r8-old-5xx-discarded",
    });

    const freshOutbox = new ConsolidationOutbox({ storage, now: nowIso });
    const recovered = freshOutbox.get(batchId);
    assert.ok(recovered);
    assert.equal(recovered.payloadHash, seeded.payloadHash);
    assertClaimablePending(recovered, nowIso());
    const attemptsBefore = recovered.attempts;

    const { fetchImpl, calls } = trackFetch(() =>
      jsonResponse(502, { error: "R8 simulated upstream failure" }),
    );
    const client = new RealtimeClient({
      consolidationOutbox: freshOutbox,
      drainFetchImpl: fetchImpl,
      drainNow: nowIso,
      drainLeaseOwner: "r8-refresh-5xx",
    });
    const h = rcHarness(client);

    h.scheduleBoundedDrainAfterConnect();
    await waitUntil(
      () => {
        const item = freshOutbox.get(batchId);
        return (
          item !== null &&
          item.status === "pending" &&
          item.attempts > attemptsBefore &&
          h.activeDrain === null
        );
      },
      "R8 5xx: retry pending after 502",
    );

    assert.equal(calls.length, 1);
    assertPayloadMatches(calls[0]!, seeded);

    const after = freshOutbox.get(batchId);
    assert.ok(after, "batch must remain after 502");
    assert.equal(after.status, "pending");
    assert.equal(after.batchId, seeded.batchId);
    assert.equal(after.payloadHash, seeded.payloadHash);
    assert.deepEqual(after.turns, seeded.turns);
    assert.equal(after.occurredOn, seeded.occurredOn);
    assert.ok(after.attempts > attemptsBefore);
    // classifyConsolidationHttp → retryable message；scheduleRetry 原样写入 lastError
    assert.equal(
      after.lastError,
      "consolidation failed: 502",
      `lastError must match production 5xx format, got ${after.lastError}`,
    );
    const nextMs = Date.parse(after.nextAttemptAt);
    const nowMs = Date.parse(nowIso());
    assert.ok(nextMs > nowMs, "nextAttemptAt must be scheduled in the future");
    assert.equal(after.leaseOwner, null);
    assert.equal(after.leaseExpiresAt, null);
    assertNoDefaultFetch("5xx path");
    console.log("[consolidation-refresh-recovery] 5xx path ok");
  }

  assertNoDefaultFetch("final");
  console.log(
    "[consolidation-refresh-recovery] ok (offline client-rebuild; NOT real F5; NOT Live E2E)",
  );
} finally {
  globalThis.fetch = previousFetch;
}
