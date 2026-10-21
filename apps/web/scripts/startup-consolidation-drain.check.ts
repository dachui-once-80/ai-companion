/**
 * 页面启动 outbox 恢复：内存 outbox + mock fetch。
 * 不读默认 localStorage、不调用 globalThis.fetch、不连接 Live、不开麦。
 */
import assert from "node:assert/strict";
import { RealtimeClient } from "../src/realtime/RealtimeClient.ts";
import {
  CONSOLIDATION_OUTBOX_STORAGE_KEY,
  ConsolidationOutbox,
  createMemoryOutboxStorage,
} from "../src/realtime/consolidationOutbox.ts";
import type { DrainFetch } from "../src/realtime/consolidationDrain.ts";
import { computeConsolidationPayloadHash } from "../src/realtime/consolidationPayload.ts";
import { consolidationDrainInFlight } from "../src/realtime/consolidationDrainCoordinator.ts";
import {
  resetStartupConsolidationDrainForTests,
  scheduleStartupConsolidationDrain,
} from "../src/realtime/startupConsolidationDrain.ts";

const NOW = "2026-10-20T12:00:00.000Z";
const OCCURRED_ON = "2026-10-20";
const TURNS = [
  { role: "user" as const, text: "我周末去看了展，记得一下" },
  { role: "companion" as const, text: "好，记下了" },
];

let defaultFetchHits = 0;
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
  assert.equal(defaultFetchHits, 0, `${label}: default fetch hits=${defaultFetchHits}`);
}

function now(): string {
  return NOW;
}

function makeOutbox(): ConsolidationOutbox {
  return new ConsolidationOutbox({
    storage: createMemoryOutboxStorage(),
    now,
  });
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

type Call = {
  url: string;
  body: {
    batchId: string;
    payloadHash: string;
    occurredOn: string;
    turns: typeof TURNS;
  };
};

function trackFetch(
  handler: () => Promise<Response> | Response,
): { fetchImpl: DrainFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: DrainFetch = async (url, init) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    calls.push({ url, body: JSON.parse(raw) as Call["body"] });
    return handler();
  };
  return { fetchImpl, calls };
}

async function seed(
  outbox: ConsolidationOutbox,
  batchId: string,
  extra?: {
    status?: "pending" | "in_flight" | "dead_letter";
    nextAttemptAt?: string;
    leaseExpiresAt?: string | null;
    leaseOwner?: string | null;
  },
) {
  const payloadHash = await computeConsolidationPayloadHash(OCCURRED_ON, TURNS);
  return outbox.add({
    batchId,
    payloadHash,
    occurredOn: OCCURRED_ON,
    turns: TURNS,
    status: extra?.status,
    nextAttemptAt: extra?.nextAttemptAt,
    leaseExpiresAt: extra?.leaseExpiresAt,
    leaseOwner: extra?.leaseOwner,
  });
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 2_000) throw new Error(`timeout: ${label}`);
    await flushMicrotasks();
  }
}

function ensureNodeWindowTimers(): void {
  const g = globalThis as typeof globalThis & {
    window?: {
      setTimeout: (fn: () => void, ms?: number) => number;
      clearTimeout: (id: number) => void;
    };
  };
  if (g.window?.setTimeout) return;
  g.window = {
    setTimeout: (fn, ms) => {
      const handle = setTimeout(fn, ms);
      if (typeof handle === "object" && handle && "unref" in handle) {
        (handle as NodeJS.Timeout).unref();
      }
      return handle as unknown as number;
    },
    clearTimeout: (id) => {
      clearTimeout(id as unknown as NodeJS.Timeout);
    },
  };
}

ensureNodeWindowTimers();

type Harness = {
  enqueueHandoffFlush: (mode: "scheduled" | "hangup") => void;
  scheduleBoundedDrainAfterConnect: () => void;
  pendingDialogue: Array<{ role: "user" | "companion" | "overheard"; text: string }>;
  handoffRetryQueue: unknown[];
  activeDrain: Promise<unknown> | null;
};

function harness(client: RealtimeClient): Harness {
  return client as unknown as Harness;
}

resetStartupConsolidationDrainForTests();

// 1) 到期 pending：mock fetch 一次，成功后删除
{
  const outbox = makeOutbox();
  const item = await seed(outbox, "boot-due-0000-4000-8000-000000000001");
  const { fetchImpl, calls } = trackFetch(() =>
    new Response(JSON.stringify(successBody()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  await scheduleStartupConsolidationDrain({
    outbox,
    fetchImpl,
    now,
    leaseOwner: "boot-test-1",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "/api/memory/consolidate");
  assert.equal(calls[0]!.body.batchId, item.batchId);
  assert.equal(calls[0]!.body.payloadHash, item.payloadHash);
  assert.equal(calls[0]!.body.occurredOn, item.occurredOn);
  assert.deepEqual(calls[0]!.body.turns, item.turns);
  assert.equal(outbox.list().length, 0);
  assertNoDefaultFetch("due pending");
  resetStartupConsolidationDrainForTests();
}

// 2) 没有到期批次：不发请求
{
  const outbox = makeOutbox();
  await seed(outbox, "boot-future-0000-4000-8000-000000000002", {
    nextAttemptAt: "2099-01-01T00:00:00.000Z",
  });
  const { fetchImpl, calls } = trackFetch(() => {
    throw new Error("fetch must not run");
  });
  await scheduleStartupConsolidationDrain({
    outbox,
    fetchImpl,
    now,
    leaseOwner: "boot-test-2",
  });
  assert.equal(calls.length, 0);
  assert.equal(outbox.list().length, 1);
  assertNoDefaultFetch("not due");
  resetStartupConsolidationDrainForTests();
}

// 3) 损坏 JSON 与 getItem 抛错：调用方不崩溃，不写盘
{
  const storage = createMemoryOutboxStorage();
  storage.setItem(CONSOLIDATION_OUTBOX_STORAGE_KEY, "{");
  let writes = 0;
  const originalSet = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    writes += 1;
    originalSet(key, value);
  };
  const outbox = new ConsolidationOutbox({ storage, now });
  const { fetchImpl, calls } = trackFetch(() => {
    throw new Error("fetch must not run");
  });
  await scheduleStartupConsolidationDrain({
    outbox,
    fetchImpl,
    now,
    leaseOwner: "boot-test-3a",
  });
  assert.equal(calls.length, 0);
  assert.equal(writes, 0);
  assert.equal(storage.getItem(CONSOLIDATION_OUTBOX_STORAGE_KEY), "{");
  resetStartupConsolidationDrainForTests();

  const throwing = {
    getItem(): string | null {
      throw new Error("storage blocked");
    },
    setItem(): void {
      throw new Error("must not write");
    },
    removeItem(): void {
      throw new Error("must not remove");
    },
  };
  const blocked = new ConsolidationOutbox({ storage: throwing, now });
  await scheduleStartupConsolidationDrain({
    outbox: blocked,
    fetchImpl,
    now,
    leaseOwner: "boot-test-3b",
  });
  resetStartupConsolidationDrainForTests();
  await scheduleStartupConsolidationDrain({
    fetchImpl,
    now,
    openOutbox: () => {
      throw new Error("localStorage unavailable");
    },
  });
  assert.equal(calls.length, 0);
  assertNoDefaultFetch("corrupt storage");
  resetStartupConsolidationDrainForTests();
}

// 4) 重复启动只一轮
{
  const outbox = makeOutbox();
  await seed(outbox, "boot-once-0000-4000-8000-000000000004");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const startedP = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { fetchImpl, calls } = trackFetch(async () => {
    started();
    await gate;
    return new Response(JSON.stringify(successBody()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const first = scheduleStartupConsolidationDrain({
    outbox,
    fetchImpl,
    now,
    leaseOwner: "boot-test-4",
  });
  const second = scheduleStartupConsolidationDrain({
    outbox,
    fetchImpl: () => {
      throw new Error("second startup must not fetch");
    },
    now,
    leaseOwner: "boot-test-4b",
  });
  assert.equal(first, second);
  await startedP;
  assert.equal(calls.length, 1);
  release();
  await first;
  assert.equal(calls.length, 1);
  assert.equal(outbox.list().length, 0);
  assertNoDefaultFetch("strict once");
  resetStartupConsolidationDrainForTests();
}

// 5) 启动 drain 与 connect drain 单飞
{
  const outbox = makeOutbox();
  await seed(outbox, "boot-join-0000-4000-8000-000000000005");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const startedP = new Promise<void>((resolve) => {
    started = resolve;
  });
  let inFlight = 0;
  let maxInFlight = 0;
  const { fetchImpl, calls } = trackFetch(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    started();
    await gate;
    inFlight -= 1;
    return new Response(JSON.stringify(successBody()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const startup = scheduleStartupConsolidationDrain({
    outbox,
    fetchImpl,
    now,
    leaseOwner: "boot-test-5",
  });
  await startedP;
  const client = new RealtimeClient({
    consolidationOutbox: outbox,
    drainFetchImpl: fetchImpl,
    drainNow: now,
    drainLeaseOwner: "rc-join",
  });
  harness(client).scheduleBoundedDrainAfterConnect();
  await flushMicrotasks();
  assert.equal(calls.length, 1);
  assert.equal(maxInFlight, 1);
  release();
  await startup;
  await flushMicrotasks();
  assert.equal(calls.length, 1);
  assert.equal(outbox.list().length, 0);
  assertNoDefaultFetch("startup join connect");
  resetStartupConsolidationDrainForTests();
}

// 6) 启动 drain 排在 handoff 之后，只发一次
{
  const outbox = makeOutbox();
  const order: string[] = [];
  let releaseDigest!: () => void;
  const digestGate = new Promise<void>((resolve) => {
    releaseDigest = resolve;
  });
  let digestPaused!: () => void;
  const digestPausedP = new Promise<void>((resolve) => {
    digestPaused = resolve;
  });
  const subtle = globalThis.crypto.subtle;
  const originalDigest = subtle.digest.bind(subtle);
  let armed = false;
  Object.defineProperty(subtle, "digest", {
    configurable: true,
    value: (async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
      if (armed) {
        order.push("handoff_digest");
        digestPaused();
        await digestGate;
        armed = false;
      }
      return originalDigest(algorithm, data);
    }) as typeof subtle.digest,
  });
  const originalAdd = outbox.add.bind(outbox);
  outbox.add = (input) => {
    order.push("handoff_add");
    return originalAdd(input);
  };
  const { fetchImpl, calls } = trackFetch(() => {
    order.push("drain_fetch");
    return new Response(JSON.stringify(successBody()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const client = new RealtimeClient({
    consolidationOutbox: outbox,
    drainFetchImpl: fetchImpl,
    drainNow: now,
    drainLeaseOwner: "rc-handoff",
  });
  const h = harness(client);
  h.pendingDialogue = [...TURNS];
  h.handoffRetryQueue = [];
  try {
    armed = true;
    h.enqueueHandoffFlush("hangup");
    await digestPausedP;
    const startup = scheduleStartupConsolidationDrain({
      outbox,
      fetchImpl,
      now,
      leaseOwner: "boot-test-6",
    });
    await flushMicrotasks();
    await flushMicrotasks();
    assert.equal(calls.length, 0, "startup drain waits for handoff");
    assert.ok(!order.includes("handoff_add"));
    releaseDigest();
    await startup;
    assert.ok(order.indexOf("handoff_add") < order.indexOf("drain_fetch"));
    assert.equal(calls.length, 1);
    assert.equal(outbox.list().length, 0);
  } finally {
    Object.defineProperty(subtle, "digest", {
      configurable: true,
      value: originalDigest,
    });
  }
  assertNoDefaultFetch("handoff serial");
  resetStartupConsolidationDrainForTests();
}

// 6b) drain 先占队列时，handoff 不得提前写 outbox
{
  const outbox = makeOutbox();
  await seed(outbox, "boot-hold-0000-4000-8000-00000000006b");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const startedP = new Promise<void>((resolve) => {
    started = resolve;
  });
  let adds = 0;
  const originalAdd = outbox.add.bind(outbox);
  outbox.add = (input) => {
    adds += 1;
    return originalAdd(input);
  };
  const { fetchImpl, calls } = trackFetch(async () => {
    started();
    await gate;
    return new Response(JSON.stringify(successBody()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const startup = scheduleStartupConsolidationDrain({
    outbox,
    fetchImpl,
    now,
    leaseOwner: "boot-test-6b",
  });
  await startedP;
  const client = new RealtimeClient({
    consolidationOutbox: outbox,
    drainFetchImpl: fetchImpl,
    drainNow: now,
    drainLeaseOwner: "rc-hold",
  });
  const h = harness(client);
  h.pendingDialogue = [...TURNS];
  h.handoffRetryQueue = [];
  h.enqueueHandoffFlush("hangup");
  await flushMicrotasks();
  await flushMicrotasks();
  assert.equal(adds, 0, "handoff waits while startup drain holds the queue");
  assert.equal(calls.length, 1);
  release();
  await startup;
  await waitUntil(() => adds === 1, "handoff add after startup drain");
  await waitUntil(
    () => harness(client).activeDrain === null && !consolidationDrainInFlight(),
    "queue idle after handoff",
  );
  assertNoDefaultFetch("drain holds handoff");
  resetStartupConsolidationDrainForTests();
}

// 7) 网络失败：冻结身份不变
{
  const outbox = makeOutbox();
  const item = await seed(outbox, "boot-fail-0000-4000-8000-000000000007");
  const { fetchImpl, calls } = trackFetch(() => {
    throw new TypeError("Failed to fetch");
  });
  await scheduleStartupConsolidationDrain({
    outbox,
    fetchImpl,
    now,
    leaseOwner: "boot-test-7",
  });
  assert.equal(calls.length, 1);
  const retained = outbox.get(item.batchId);
  assert.ok(retained);
  assert.equal(retained!.status, "pending");
  assert.equal(retained!.batchId, item.batchId);
  assert.equal(retained!.payloadHash, item.payloadHash);
  assert.equal(retained!.occurredOn, item.occurredOn);
  assert.deepEqual(retained!.turns, item.turns);
  assertNoDefaultFetch("network failure");
  resetStartupConsolidationDrainForTests();
}

// 8) dead_letter 与 ambiguous_lease 不发送
{
  const outbox = makeOutbox();
  const dead = await seed(outbox, "boot-dead-0000-4000-8000-000000000008", {
    status: "dead_letter",
    leaseExpiresAt: null,
    leaseOwner: null,
  });
  const ambiguous = await seed(outbox, "boot-amb-0000-4000-8000-000000000009", {
    status: "in_flight",
    leaseExpiresAt: null,
    leaseOwner: "old",
  });
  const { fetchImpl, calls } = trackFetch(() => {
    throw new Error("fetch must not run");
  });
  await scheduleStartupConsolidationDrain({
    outbox,
    fetchImpl,
    now,
    leaseOwner: "boot-test-8",
  });
  assert.equal(calls.length, 0);
  assert.equal(outbox.get(dead.batchId)?.status, "dead_letter");
  assert.equal(outbox.get(ambiguous.batchId)?.status, "in_flight");
  assert.equal(outbox.get(ambiguous.batchId)?.leaseExpiresAt, null);
  assertNoDefaultFetch("skip terminal");
  resetStartupConsolidationDrainForTests();
}

assert.equal(defaultFetchHits, 0);
console.log("[startup-consolidation-drain] ok");
