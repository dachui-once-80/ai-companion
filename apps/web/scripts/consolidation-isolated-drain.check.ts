/**
 * 1B-3D-3-R8-B2-ISOLATED-VERIFY：
 * 内存 ConsolidationOutbox + 生产 drainConsolidationOutbox + mock fetch。
 * 不触碰默认 localStorage key、正式库、真实网络；不 connect／Live。
 */
import assert from "node:assert/strict";
import {
  CONSOLIDATION_DRAIN_PATH,
  drainConsolidationOutbox,
  type DrainFetch,
} from "../src/realtime/consolidationDrain.ts";
import {
  CONSOLIDATION_OUTBOX_STORAGE_KEY,
  ConsolidationOutbox,
  createMemoryOutboxStorage,
  type ConsolidationOutboxItem,
} from "../src/realtime/consolidationOutbox.ts";
import { CONSOLIDATION_SAVED_KEYS } from "../src/realtime/consolidateResult.ts";
import { computeConsolidationPayloadHash } from "../src/realtime/consolidationPayload.ts";

const OCCURRED_ON = "2026-10-20";
const BATCH_OK = "r8iso1-0000-4000-8000-000000000001";
const BATCH_FAIL = "r8iso2-0000-4000-8000-000000000002";

const FORBIDDEN_IDS = new Set([
  "r8b1f5-0000-4000-8000-000000000001",
  "r8b2fl-0000-4000-8000-000000000001",
  "r8b2ok-0000-4000-8000-000000000001",
]);

assert.ok(!FORBIDDEN_IDS.has(BATCH_OK));
assert.ok(!FORBIDDEN_IDS.has(BATCH_FAIL));

let clockMs = Date.UTC(2026, 9, 20, 15, 0, 0, 0);

function nowIso(): string {
  clockMs += 1;
  return new Date(clockMs).toISOString();
}

function successBody() {
  const saved: Record<string, number> = {};
  for (const key of CONSOLIDATION_SAVED_KEYS) {
    saved[key] = 0;
  }
  saved.episodes = 1;
  return { saved };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Captured = {
  url: string;
  body: {
    batchId: string;
    payloadHash: string;
    occurredOn: string;
    turns: Array<{ role: string; text: string }>;
  };
};

function trackFetch(
  handler: (call: Captured) => Promise<Response> | Response,
): { fetchImpl: DrainFetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl: DrainFetch = async (url, init) => {
    assert.equal(url, CONSOLIDATION_DRAIN_PATH);
    const raw = typeof init?.body === "string" ? init.body : "";
    const body = JSON.parse(raw) as Captured["body"];
    const call = { url, body };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
}

function assertFrozen(call: Captured, item: ConsolidationOutboxItem): void {
  assert.equal(call.body.batchId, item.batchId);
  assert.equal(call.body.payloadHash, item.payloadHash);
  assert.equal(call.body.occurredOn, item.occurredOn);
  assert.deepEqual(call.body.turns, item.turns);
}

function assertMemoryOnly(
  storage: ReturnType<typeof createMemoryOutboxStorage>,
  label: string,
): void {
  assert.equal(
    typeof (globalThis as { localStorage?: unknown }).localStorage,
    "undefined",
    `${label}: Node harness must not expose localStorage`,
  );
  for (const key of storage.store.keys()) {
    assert.equal(
      key,
      CONSOLIDATION_OUTBOX_STORAGE_KEY,
      `${label}: unexpected storage key ${key}`,
    );
  }
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
    `${label}: default fetch hits=${defaultFetchHits}`,
  );
}

try {
  // --- T1：成功路径 ---
  {
    clockMs = Date.UTC(2026, 9, 20, 15, 0, 0, 0);
    const storage = createMemoryOutboxStorage();
    const outbox = new ConsolidationOutbox({ storage, now: nowIso });
    assertMemoryOnly(storage, "T1 pre");

    const turns = [
      { role: "user" as const, text: "R8-ISO-OK remember isolated success" },
      { role: "companion" as const, text: "ok" },
    ];
    const payloadHash = await computeConsolidationPayloadHash(
      OCCURRED_ON,
      turns,
    );
    const seeded = outbox.add({
      batchId: BATCH_OK,
      payloadHash,
      occurredOn: OCCURRED_ON,
      turns,
      status: "pending",
      nextAttemptAt: nowIso(),
    });
    assert.equal(outbox.list().length, 1);
    assert.equal(seeded.status, "pending");

    const { fetchImpl, calls } = trackFetch(() =>
      jsonResponse(200, successBody()),
    );
    assert.equal(calls.length, 0);

    const result = await drainConsolidationOutbox({
      outbox,
      fetchImpl,
      now: nowIso,
      leaseOwner: "r8-iso-ok",
      maxBatches: 1,
    });

    assert.equal(result.outcomes.length, 1);
    assert.equal(result.outcomes[0]?.kind, "sent_removed");
    assert.equal(calls.length, 1);
    assertFrozen(calls[0]!, seeded);
    assert.equal(outbox.get(BATCH_OK), null);
    assert.equal(outbox.list().length, 0);
    assertMemoryOnly(storage, "T1 post");
    assertNoDefaultFetch("T1");
    console.log("[consolidation-isolated-drain] T1 success ok");
  }

  // --- T2：502 失败重试 ---
  {
    clockMs = Date.UTC(2026, 9, 20, 16, 0, 0, 0);
    const storage = createMemoryOutboxStorage();
    const outbox = new ConsolidationOutbox({ storage, now: nowIso });
    assertMemoryOnly(storage, "T2 pre");

    const turns = [
      { role: "user" as const, text: "R8-ISO-FAIL remember isolated failure" },
      { role: "companion" as const, text: "ok" },
    ];
    const payloadHash = await computeConsolidationPayloadHash(
      OCCURRED_ON,
      turns,
    );
    const seeded = outbox.add({
      batchId: BATCH_FAIL,
      payloadHash,
      occurredOn: OCCURRED_ON,
      turns,
      status: "pending",
      nextAttemptAt: nowIso(),
    });
    const attemptsBefore = seeded.attempts;
    const nextBefore = seeded.nextAttemptAt;

    const { fetchImpl, calls } = trackFetch(() =>
      jsonResponse(502, { error: "R8-ISO simulated upstream failure" }),
    );

    const result = await drainConsolidationOutbox({
      outbox,
      fetchImpl,
      now: nowIso,
      leaseOwner: "r8-iso-fail",
      maxBatches: 1,
    });

    assert.equal(result.outcomes[0]?.kind, "retry_scheduled");
    assert.equal(calls.length, 1);
    assertFrozen(calls[0]!, seeded);

    const after = outbox.get(BATCH_FAIL);
    assert.ok(after, "T2 item must remain");
    assert.equal(after.status, "pending");
    assert.ok(after.attempts > attemptsBefore);
    assert.equal(after.lastError, "consolidation failed: 502");
    assert.ok(Date.parse(after.nextAttemptAt) > Date.parse(nextBefore));
    assert.equal(after.leaseOwner, null);
    assert.equal(after.leaseExpiresAt, null);
    assert.equal(after.batchId, seeded.batchId);
    assert.equal(after.payloadHash, seeded.payloadHash);
    assert.equal(after.occurredOn, seeded.occurredOn);
    assert.deepEqual(after.turns, seeded.turns);
    assert.equal(outbox.list().length, 1);
    assertMemoryOnly(storage, "T2 post");
    assertNoDefaultFetch("T2");
    console.log("[consolidation-isolated-drain] T2 fail-retry ok");
  }

  assertNoDefaultFetch("final");
  console.log(
    "[consolidation-isolated-drain] ok (memory outbox + mock; NOT default localStorage; NOT Live)",
  );
} finally {
  globalThis.fetch = previousFetch;
}
