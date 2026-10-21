/**
 * 1B-3D-2A／2A-T／2B-B1／2B2：RealtimeClient drain 接线离线测试。
 * - 使用真实 RealtimeClient 实例 + 注入内存 outbox／mock fetch（非浏览器 Live／E2E）。
 * - 不发真实 consolidate、不读正式库／.env／localStorage。
 * - 2B-B1：handoff 成功后自动有界 drain。
 * - 2B2／PA：生产唯一 `runPostAdoptConnectEffects`（connect adopt 后同款）；
 *   不跑 GoogleGenAI `live.connect`／真实麦克风。
 * - 经实例私有字段／方法 harness 触达 RC 排队路径。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { RealtimeClient } from "../src/realtime/RealtimeClient.ts";
import {
  ConsolidationOutbox,
  ConsolidationOutboxUnavailableError,
  createMemoryOutboxStorage,
  type AddConsolidationOutboxInput,
  type ConsolidationOutboxItem,
} from "../src/realtime/consolidationOutbox.ts";
import {
  CLEANUP_HANDOFF_WAIT_MS,
  awaitHandoffTailWithTimeout,
  flushDialogueThroughHandoff,
} from "../src/realtime/consolidationFlushHandoff.ts";
import type { DrainFetch } from "../src/realtime/consolidationDrain.ts";
import { computeConsolidationPayloadHash } from "../src/realtime/consolidationPayload.ts";
import { runPostAdoptConnectEffects } from "../src/realtime/postAdoptConnectEffects.ts";
import { currentConsolidationTail } from "../src/realtime/consolidationDrainCoordinator.ts";

/** 仅测试：触达 private enqueue／状态；仍是同一 RC 实例上的真实方法。 */
type RealtimeClientHarness = {
  enqueueHandoffFlush: (mode: "scheduled" | "hangup") => void;
  scheduleBoundedDrainAfterConnect: () => void;
  flushDialogueNow: () => void;
  pendingDialogue: Array<{
    role: "user" | "companion" | "overheard";
    text: string;
  }>;
  handoffRetryQueue: Array<{
    batchId?: string;
    frozen?: { batchId: string; payloadHash: string; occurredOn: string };
  }>;
  activeDrain: Promise<unknown> | null;
  hangupHandoffBoundary: Promise<void>;
  socketConnected: boolean;
  session: { close?: () => void } | null;
  refreshThoughtContext: (views: boolean, open: boolean) => Promise<void>;
  refreshStandingBetween: () => Promise<void>;
};

/**
 * 镜像 cleanup 对 hangup 等待目标的选择（RealtimeClient.cleanup 同序）。
 * ahead activeDrain → timeoutMs=0（不等待 drain HTTP；不宣称 persist）。
 */
function cleanupHandoffWaitFromHarness(h: RealtimeClientHarness): {
  boundary: Promise<void>;
  timeoutMs: number;
  aheadDrainSkipsWait: boolean;
} {
  const aheadDrainSkipsWait = h.activeDrain !== null;
  return {
    boundary: h.hangupHandoffBoundary,
    timeoutMs: aheadDrainSkipsWait ? 0 : CLEANUP_HANDOFF_WAIT_MS,
    aheadDrainSkipsWait,
  };
}

function rcHarness(client: RealtimeClient): RealtimeClientHarness {
  return client as unknown as RealtimeClientHarness;
}

function rcConsolidationTail(): Promise<void> {
  return currentConsolidationTail();
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** Node 下 RC `scheduleConsolidation` 需要 window.setTimeout（失败退避路径）。 */
function ensureNodeWindowTimers(): void {
  const g = globalThis as typeof globalThis & {
    window?: {
      setTimeout: (fn: () => void, ms?: number) => number;
      clearTimeout: (id: number) => void;
    };
  };
  if (g.window?.setTimeout) return;
  g.window = {
    setTimeout: (fn: () => void, ms?: number) => {
      const handle = setTimeout(fn, ms);
      // 避免 failure_backoff 定时器拖住 Node 进程不退出
      if (typeof handle === "object" && handle && "unref" in handle) {
        (handle as NodeJS.Timeout).unref();
      }
      return handle as unknown as number;
    },
    clearTimeout: (id: number) => {
      clearTimeout(id as unknown as NodeJS.Timeout);
    },
  };
}

ensureNodeWindowTimers();

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

const TODAY = "2026-10-20";

/**
 * `enqueueHandoffFlush` 用 RealtimeClient 的本地日历日冻结 occurredOn，
 * 不读注入的 drainNow。与 localDateString 同一规则。
 */
function handoffLocalDate(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
const TURNS = [
  { role: "user" as const, text: "我周末去看了展，记得一下" },
  { role: "companion" as const, text: "好，记下了" },
];
const KEEP = TURNS;

let clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);

function nowIso(): string {
  clockMs += 1;
  return new Date(clockMs).toISOString();
}

function makeOutbox() {
  return new ConsolidationOutbox({
    storage: createMemoryOutboxStorage(),
    now: nowIso,
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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
  handler: (call: Call, index: number) => Promise<Response> | Response,
): { fetchImpl: DrainFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: DrainFetch = async (url, init) => {
    const raw = typeof init?.body === "string" ? init.body : "";
    const body = JSON.parse(raw) as Call["body"];
    const call = { url, body };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { fetchImpl, calls };
}

async function seedOutboxItem(
  outbox: ConsolidationOutbox,
  batchId: string,
  occurredOn = TODAY,
  turns = TURNS,
) {
  const payloadHash = await computeConsolidationPayloadHash(occurredOn, turns);
  return outbox.add({
    batchId,
    payloadHash,
    occurredOn,
    turns,
    status: "pending",
  });
}

try {
// --- 1) 显式 drain 处理已持久化批次（RC 实例） ---
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  const item = await seedOutboxItem(
    outbox,
    "wire0010-0000-4000-8000-000000000001",
  );
  const { fetchImpl, calls } = trackFetch(() =>
    jsonResponse(200, successBody()),
  );
  const client = new RealtimeClient({
    consolidationOutbox: outbox,
    drainFetchImpl: fetchImpl,
    drainNow: nowIso,
    drainLeaseOwner: "wire-test",
  });

  const result = await client.drainConsolidationOutboxNow();
  assert.equal(result.outcomes[0]?.kind, "sent_removed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.body.batchId, item.batchId);
  assert.equal(calls[0]!.body.payloadHash, item.payloadHash);
  assert.equal(calls[0]!.body.occurredOn, item.occurredOn);
  assert.deepEqual(calls[0]!.body.turns, item.turns);
  assert.equal(outbox.get(item.batchId), null);
}

// --- 2) 并发／重复触发：单 flight，不并行 drain ---
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  await seedOutboxItem(outbox, "wire0020-0000-4000-8000-000000000002");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let inFlight = 0;
  let maxInFlight = 0;
  const { fetchImpl, calls } = trackFetch(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await gate;
    inFlight -= 1;
    return jsonResponse(200, successBody());
  });
  const client = new RealtimeClient({
    consolidationOutbox: outbox,
    drainFetchImpl: fetchImpl,
    drainNow: nowIso,
    drainLeaseOwner: "wire-test",
  });

  const first = client.drainConsolidationOutboxNow();
  const second = client.drainConsolidationOutboxNow();
  assert.equal(first, second, "duplicate trigger must share the same Promise");
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b);
  assert.equal(calls.length, 1);
  assert.equal(maxInFlight, 1);
  assert.equal(outbox.list().length, 0);
}

// --- 3) handoff 持久化后 drain：不丢批、身份来自 outbox ---
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  const handoff = await flushDialogueThroughHandoff({
    mode: "hangup",
    outbox,
    pendingDialogue: KEEP,
    handoffRetryQueue: [],
    todayLocal: TODAY,
  });
  assert.equal(handoff.diagnostics.attempts[0]?.resultKind, "persisted");
  assert.equal(outbox.list().length, 1);
  const persisted = outbox.list()[0]!;

  const { fetchImpl, calls } = trackFetch(() =>
    jsonResponse(200, successBody()),
  );
  const client = new RealtimeClient({
    consolidationOutbox: outbox,
    drainFetchImpl: fetchImpl,
    drainNow: nowIso,
    drainLeaseOwner: "wire-test",
  });
  const result = await client.drainConsolidationOutboxNow();
  assert.equal(result.outcomes[0]?.kind, "sent_removed");
  assert.equal(calls[0]!.body.batchId, persisted.batchId);
  assert.equal(calls[0]!.body.payloadHash, persisted.payloadHash);
  assert.equal(calls[0]!.body.occurredOn, TODAY);
  assert.equal(outbox.list().length, 0);
}

// --- 3b) drain 进行中交错 handoff：已 claim 批不被改写；新批保留 ---
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  const claimed = await seedOutboxItem(
    outbox,
    "wire003b-0000-4000-8000-00000000003b",
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fetchStarted!: () => void;
  const fetchStartedP = new Promise<void>((resolve) => {
    fetchStarted = resolve;
  });
  const { fetchImpl, calls } = trackFetch(async () => {
    fetchStarted();
    await gate;
    return jsonResponse(200, successBody());
  });
  const client = new RealtimeClient({
    consolidationOutbox: outbox,
    drainFetchImpl: fetchImpl,
    drainNow: nowIso,
    drainLeaseOwner: "wire-test",
  });

  const drainP = client.drainConsolidationOutboxNow();
  await fetchStartedP;
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.body.batchId, claimed.batchId);
  assert.equal(calls[0]!.body.payloadHash, claimed.payloadHash);

  const handoff = await flushDialogueThroughHandoff({
    mode: "hangup",
    outbox,
    pendingDialogue: [
      { role: "user", text: "另外一件事" },
      { role: "companion", text: "好" },
    ],
    handoffRetryQueue: [],
    todayLocal: TODAY,
  });
  assert.equal(handoff.diagnostics.attempts[0]?.resultKind, "persisted");
  const mid = outbox.get(claimed.batchId);
  assert.ok(mid, "claimed batch must remain until drain remove");
  assert.equal(mid!.payloadHash, claimed.payloadHash);
  assert.equal(mid!.occurredOn, claimed.occurredOn);
  assert.deepEqual(mid!.turns, claimed.turns);

  release();
  const drainResult = await drainP;
  assert.equal(drainResult.outcomes[0]?.kind, "sent_removed");
  assert.equal(outbox.get(claimed.batchId), null);
  assert.equal(outbox.list().length, 1, "handoff batch must survive");
  const survivor = outbox.list()[0]!;
  assert.notEqual(survivor.batchId, claimed.batchId);
  assert.equal(survivor.occurredOn, TODAY);
  assert.equal(calls.length, 1, "interleaved handoff must not trigger extra drain HTTP");
}

// --- 4) 「服务端已处理／客户端丢响应」后重试：身份不变 ---
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  const item = await seedOutboxItem(
    outbox,
    "wire0040-0000-4000-8000-000000000004",
  );
  let mode: "drop" | "ok" = "drop";
  const { fetchImpl, calls } = trackFetch(() => {
    if (mode === "drop") throw new TypeError("Failed to fetch");
    return jsonResponse(200, successBody());
  });
  const client = new RealtimeClient({
    consolidationOutbox: outbox,
    drainFetchImpl: fetchImpl,
    drainNow: nowIso,
    drainLeaseOwner: "wire-test",
  });

  const first = await client.drainConsolidationOutboxNow();
  assert.equal(first.outcomes[0]?.kind, "retry_scheduled");
  assert.ok(outbox.get(item.batchId));
  assert.equal(outbox.get(item.batchId)!.payloadHash, item.payloadHash);

  // 到期后显式再 drain（仍同冻结身份）
  outbox.update(item.batchId, { nextAttemptAt: nowIso() });
  mode = "ok";
  const second = await client.drainConsolidationOutboxNow();
  assert.equal(second.outcomes[0]?.kind, "sent_removed");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.body.batchId, calls[1]!.body.batchId);
  assert.equal(calls[0]!.body.payloadHash, calls[1]!.body.payloadHash);
  assert.equal(calls[0]!.body.occurredOn, calls[1]!.body.occurredOn);
  assert.deepEqual(calls[0]!.body.turns, calls[1]!.body.turns);
}

// --- 5) remove 失败不得报告客户端完成 ---
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  const item = await seedOutboxItem(
    outbox,
    "wire0050-0000-4000-8000-000000000005",
  );
  outbox.remove = () => false;
  const { fetchImpl, calls } = trackFetch(() =>
    jsonResponse(200, successBody()),
  );
  const client = new RealtimeClient({
    consolidationOutbox: outbox,
    drainFetchImpl: fetchImpl,
    drainNow: nowIso,
    drainLeaseOwner: "wire-test",
  });
  const result = await client.drainConsolidationOutboxNow();
  assert.equal(calls.length, 1);
  assert.equal(result.outcomes[0]?.kind, "failed");
  assert.match(result.outcomes[0]?.detail ?? "", /remove returned false/);
  assert.notEqual(
    result.outcomes[0]?.kind,
    "sent_removed",
    "must not treat client as complete",
  );
  assert.ok(outbox.get(item.batchId), "batch must remain after remove failure");
}

{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  const item = await seedOutboxItem(
    outbox,
    "wire0051-0000-4000-8000-000000000051",
  );
  outbox.remove = () => {
    throw new ConsolidationOutboxUnavailableError("remove blocked");
  };
  const { fetchImpl } = trackFetch(() => jsonResponse(200, successBody()));
  const client = new RealtimeClient({
    consolidationOutbox: outbox,
    drainFetchImpl: fetchImpl,
    drainNow: nowIso,
    drainLeaseOwner: "wire-test",
  });
  const result = await client.drainConsolidationOutboxNow();
  assert.equal(result.outcomes[0]?.kind, "failed");
  assert.ok(outbox.get(item.batchId));
}

// --- 6) drain 不发送内存未持久化批次（outbox 空 → 零请求） ---
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  const { fetchImpl, calls } = trackFetch(() =>
    jsonResponse(200, successBody()),
  );
  const client = new RealtimeClient({
    consolidationOutbox: outbox,
    drainFetchImpl: fetchImpl,
    drainNow: nowIso,
    drainLeaseOwner: "wire-test",
  });
  // 实例存在 pendingDialogue 字段但 outbox 为空：drain 不得 HTTP
  const result = await client.drainConsolidationOutboxNow();
  assert.equal(calls.length, 0);
  assert.equal(result.processed, 0);
  assert.equal(outbox.list().length, 0);
}

// --- 7) 慢 drain 进行中再次触发仍单 flight；fetch 仅一次 ---
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  await seedOutboxItem(outbox, "wire0070-0000-4000-8000-000000000007");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fetchStarted!: () => void;
  const fetchStartedP = new Promise<void>((resolve) => {
    fetchStarted = resolve;
  });
  const order: string[] = [];
  const { fetchImpl, calls } = trackFetch(async () => {
    order.push("fetch");
    fetchStarted();
    await gate;
    return jsonResponse(200, successBody());
  });
  const client = new RealtimeClient({
    consolidationOutbox: outbox,
    drainFetchImpl: fetchImpl,
    drainNow: nowIso,
    drainLeaseOwner: "wire-test",
  });

  const a = client.drainConsolidationOutboxNow();
  const b = client.drainConsolidationOutboxNow();
  assert.equal(a, b);
  await fetchStartedP;
  assert.equal(calls.length, 1);
  const c = client.drainConsolidationOutboxNow();
  assert.equal(c, a, "mid-flight third trigger still same Promise");
  release();
  await a;
  assert.deepEqual(order, ["fetch"]);
  assert.equal(outbox.list().length, 0);
}

// =============================================================================
// 1B-3D-2A-T
// =============================================================================

/**
 * 测试 1a：handoff 占着 RC consolidationTail 时，drain 不得抢先 claim／fetch。
 *
 * 暂停点：生产 handoff 在 `outbox.add`（同步）之前唯一 await 是
 * `computeConsolidationPayloadHash` → `crypto.subtle.digest`。
 * 不改生产代码时无法让同步 `add` 让出事件循环；因此在 digest 处可控暂停，
 * 并在 resume 后用 add 包装确认 enqueue 仍落在 drain 之前。
 * harness：`enqueueHandoffFlush`（RC 真实排队路径，非直接 flushDialogueThroughHandoff）。
 */
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  const seeded = await seedOutboxItem(
    outbox,
    "wire-t1a-0000-4000-8000-0000000001a",
  );

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
  let digestGateArmed = false;
  const digestSpy: typeof subtle.digest = async (algorithm, data) => {
    if (digestGateArmed) {
      order.push("handoff_digest_pause");
      digestPaused();
      await digestGate;
      digestGateArmed = false;
    }
    return originalDigest(algorithm, data);
  };
  Object.defineProperty(subtle, "digest", {
    configurable: true,
    value: digestSpy,
  });

  const originalAdd = outbox.add.bind(outbox);
  outbox.add = (input: AddConsolidationOutboxInput): ConsolidationOutboxItem => {
    order.push("handoff_add");
    return originalAdd(input);
  };

  let claimCount = 0;
  const originalUpdate = outbox.update.bind(outbox);
  outbox.update = (batchId, patch) => {
    if (patch.status === "in_flight") {
      claimCount += 1;
      order.push("drain_claim");
    }
    return originalUpdate(batchId, patch);
  };

  const { fetchImpl, calls } = trackFetch(() => {
    order.push("drain_fetch");
    return jsonResponse(200, successBody());
  });

  const client = new RealtimeClient({
    consolidationOutbox: outbox,
    drainFetchImpl: fetchImpl,
    drainNow: nowIso,
    drainLeaseOwner: "wire-test-t1a",
  });
  const h = rcHarness(client);
  h.pendingDialogue = [...KEEP];
  h.handoffRetryQueue = [];

  try {
    digestGateArmed = true;
    h.enqueueHandoffFlush("hangup");
    await digestPausedP;
    assert.deepEqual(order, ["handoff_digest_pause"]);
    assert.equal(calls.length, 0);
    assert.equal(claimCount, 0);
    assert.equal(outbox.get(seeded.batchId)?.status, "pending");

    const drainP = client.drainConsolidationOutboxNow();
    await flushMicrotasks();
    await flushMicrotasks();
    assert.equal(calls.length, 0, "drain must not fetch while handoff holds tail");
    assert.equal(claimCount, 0, "drain must not claim while handoff holds tail");
    assert.equal(outbox.get(seeded.batchId)?.status, "pending");
    assert.ok(!order.includes("handoff_add"));

    releaseDigest();
    await drainP;

    assert.ok(order.indexOf("handoff_add") < order.indexOf("drain_claim"));
    assert.ok(order.indexOf("handoff_add") < order.indexOf("drain_fetch"));
    assert.ok(order.includes("drain_fetch"));
    assert.equal(outbox.get(seeded.batchId), null);
  } finally {
    Object.defineProperty(subtle, "digest", {
      configurable: true,
      value: originalDigest,
    });
  }
}

/**
 * 测试 1b：drain 先占用队列时，后续 RC handoff 不得提前写 outbox。
 * harness：enqueueHandoffFlush；mock fetch 门闸。
 */
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  await seedOutboxItem(outbox, "wire-t1b-0000-4000-8000-0000000001b");

  const order: string[] = [];
  let addCount = 0;
  const originalAdd = outbox.add.bind(outbox);
  outbox.add = (input: AddConsolidationOutboxInput): ConsolidationOutboxItem => {
    addCount += 1;
    order.push("handoff_add");
    return originalAdd(input);
  };

  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  let fetchStarted!: () => void;
  const fetchStartedP = new Promise<void>((resolve) => {
    fetchStarted = resolve;
  });
  const { fetchImpl, calls } = trackFetch(async () => {
    order.push("drain_fetch");
    fetchStarted();
    await fetchGate;
    return jsonResponse(200, successBody());
  });

  const client = new RealtimeClient({
    consolidationOutbox: outbox,
    drainFetchImpl: fetchImpl,
    drainNow: nowIso,
    drainLeaseOwner: "wire-test-t1b",
  });
  const h = rcHarness(client);

  const drainP = client.drainConsolidationOutboxNow();
  await fetchStartedP;
  assert.equal(calls.length, 1);
  assert.equal(addCount, 0);

  h.pendingDialogue = [
    { role: "user", text: "尾部串行另一批对话内容" },
    { role: "companion", text: "记下了" },
  ];
  h.handoffRetryQueue = [];
  h.enqueueHandoffFlush("hangup");
  await flushMicrotasks();
  await flushMicrotasks();
  assert.equal(addCount, 0, "handoff must not write outbox while drain holds tail");
  assert.ok(!order.includes("handoff_add"));

  releaseFetch();
  await drainP;
  await waitUntil(() => addCount >= 1, "handoff add after first drain");
  assert.equal(addCount, 1, "handoff writes only after drain finishes");
  assert.ok(order.indexOf("drain_fetch") < order.indexOf("handoff_add"));
  // 2B-B1：handoff persisted 后会再排一次有界 drain
  await waitUntil(() => calls.length >= 2, "auto drain after handoff");
  assert.equal(calls.length, 2);
  await waitUntil(() => outbox.list().length === 0, "auto drain removes handoff batch");
}

/**
 * 测试 2：drain 执行路径抛错后 activeDrain 清空、可再入，且 tail reject 后仍可继续。
 * 注入：drainNow 在第二拍抛错（list 之后、claim 之前），使 drainConsolidationOutbox 向外抛出。
 */
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  const item = await seedOutboxItem(
    outbox,
    "wire-t2-0000-4000-8000-00000000002",
  );

  let nowInvoke = 0;
  let throwOnInvoke = 2;
  const drainNow = (): string => {
    nowInvoke += 1;
    if (nowInvoke === throwOnInvoke) {
      throw new Error("injected drainNow failure");
    }
    return nowIso();
  };

  const { fetchImpl, calls } = trackFetch(() =>
    jsonResponse(200, successBody()),
  );
  const client = new RealtimeClient({
    consolidationOutbox: outbox,
    drainFetchImpl: fetchImpl,
    drainNow,
    drainLeaseOwner: "wire-test-t2",
  });
  const h = rcHarness(client);

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);

  const first = client.drainConsolidationOutboxNow();
  await assert.rejects(first, /injected drainNow failure/);
  assert.equal(h.activeDrain, null, "activeDrain must clear after reject");
  assert.equal(calls.length, 0);
  assert.equal(outbox.get(item.batchId)?.status, "pending");

  // 吸收静态 consolidationTail 的 reject（生产同样 .catch 恢复；避免污染后续用例）
  void rcConsolidationTail().catch(() => undefined);
  await flushMicrotasks();

  // 前序 tail reject 之后：RC handoff 仍可写入；2B-B1 会自动 drain
  nowInvoke = 0;
  throwOnInvoke = -1;
  h.pendingDialogue = [
    { role: "user", text: "异常恢复后的新对话批次内容" },
    { role: "companion", text: "好" },
  ];
  h.handoffRetryQueue = [];
  const beforeHandoff = outbox.list().length;
  h.enqueueHandoffFlush("hangup");
  await waitUntil(
    () => outbox.list().length === 0 && calls.length >= 1,
    "handoff persist then auto-drain clears outbox",
  );
  assert.ok(
    beforeHandoff >= 1,
    "seeded batch existed before recovery handoff",
  );
  assert.equal(h.activeDrain, null);
  // 显式再入：空 outbox 仍可完成且不复用 rejected first
  const second = client.drainConsolidationOutboxNow();
  assert.notEqual(second, first, "must not permanently return the rejected Promise");
  const secondResult = await second;
  assert.equal(secondResult.processed, 0);
  assert.equal(h.activeDrain, null);
  assert.ok(calls.length >= 1);

  process.off("unhandledRejection", onUnhandled);
  // first 的 tracked 已被 assert.rejects 处理；tail 已 catch。不应残留未处理 reject。
  await flushMicrotasks();
  const injectedUnhandled = unhandled.filter(
    (reason) =>
      reason instanceof Error && /injected drainNow failure/.test(reason.message),
  );
  assert.equal(
    injectedUnhandled.length,
    0,
    "injected failure must not remain as unhandled rejection after harness catch",
  );
}

/**
 * 测试 3：sent_removed + socketConnected 触发刷新；刷新 reject 不得未处理；
 * 刷新不重入 drain、不增加 consolidate POST、不改已完成 outbox。
 * harness：socketConnected 替身 + 刷新方法替身（不建 Live、不发真实 HTTP）。
 */
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  const item = await seedOutboxItem(
    outbox,
    "wire-t3-0000-4000-8000-00000000003",
  );

  const { fetchImpl, calls } = trackFetch(() =>
    jsonResponse(200, successBody()),
  );
  const client = new RealtimeClient({
    consolidationOutbox: outbox,
    drainFetchImpl: fetchImpl,
    drainNow: nowIso,
    drainLeaseOwner: "wire-test-t3",
  });
  const h = rcHarness(client);
  h.socketConnected = true;

  let thoughtCalls = 0;
  let betweenCalls = 0;
  let nestedDrainCalls = 0;
  const originalDrain = client.drainConsolidationOutboxNow.bind(client);
  client.drainConsolidationOutboxNow = ((options) => {
    nestedDrainCalls += 1;
    return originalDrain(options);
  }) as typeof client.drainConsolidationOutboxNow;

  h.refreshThoughtContext = async () => {
    thoughtCalls += 1;
    throw new Error("thought refresh rejected");
  };
  h.refreshStandingBetween = async () => {
    betweenCalls += 1;
    throw new Error("between refresh rejected");
  };

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);

  const result = await client.drainConsolidationOutboxNow();
  assert.equal(result.outcomes[0]?.kind, "sent_removed");
  assert.equal(nestedDrainCalls, 1, "outer drain only");
  assert.equal(calls.length, 1, "single consolidate POST from drain");
  assert.equal(outbox.get(item.batchId), null);

  await flushMicrotasks();
  await flushMicrotasks();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

  assert.equal(thoughtCalls, 1, "refreshThoughtContext must run");
  assert.equal(betweenCalls, 1, "refreshStandingBetween must run");
  assert.equal(nestedDrainCalls, 1, "refresh must not re-enter drain");
  assert.equal(calls.length, 1, "refresh must not POST consolidate again");
  assert.equal(outbox.list().length, 0, "refresh must not revive removed batch");

  const refreshUnhandled = unhandled.filter(
    (reason) =>
      reason instanceof Error &&
      /refresh rejected/.test(reason.message),
  );
  assert.equal(
    refreshUnhandled.length,
    0,
    "refresh rejection must be swallowed by wiring .catch",
  );

  process.off("unhandledRejection", onUnhandled);
}

// =============================================================================
// 1B-3D-2B-B1
// =============================================================================

/**
 * B1-T1：RC enqueueHandoffFlush 成功 persisted 后，handoff 队列任务结束后才 drain。
 * 真实 RealtimeClient + enqueueHandoffFlush；mock fetch。
 */
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  const order: string[] = [];

  const originalAdd = outbox.add.bind(outbox);
  outbox.add = (input: AddConsolidationOutboxInput): ConsolidationOutboxItem => {
    order.push("handoff_add");
    return originalAdd(input);
  };

  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  let fetchStarted!: () => void;
  const fetchStartedP = new Promise<void>((resolve) => {
    fetchStarted = resolve;
  });
  const { fetchImpl, calls } = trackFetch(async () => {
    order.push("drain_fetch");
    fetchStarted();
    await fetchGate;
    return jsonResponse(200, successBody());
  });

  const client = new RealtimeClient({
    consolidationOutbox: outbox,
    drainFetchImpl: fetchImpl,
    drainNow: nowIso,
    drainLeaseOwner: "wire-b1-t1",
  });
  const h = rcHarness(client);
  h.pendingDialogue = [...KEEP];
  h.handoffRetryQueue = [];
  h.enqueueHandoffFlush("hangup");

  await fetchStartedP;
  assert.ok(
    order.indexOf("handoff_add") < order.indexOf("drain_fetch"),
    "drain fetch must start only after handoff enqueue",
  );
  assert.equal(calls.length, 1);
  assert.equal(outbox.list().length, 1, "batch remains until drain remove");
  const frozen = outbox.list()[0]!;
  assert.equal(calls[0]!.body.batchId, frozen.batchId);
  assert.equal(calls[0]!.body.payloadHash, frozen.payloadHash);
  assert.equal(calls[0]!.body.occurredOn, frozen.occurredOn);

  releaseFetch();
  await waitUntil(() => outbox.list().length === 0, "B1-T1 outbox cleared");
  assert.equal(h.activeDrain, null);
}

/**
 * B1-T2：handoff 失败不得触发 drain POST。
 * 真实 RC enqueueHandoffFlush；outbox.add 抛 unavailable。
 */
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  outbox.add = () => {
    throw new ConsolidationOutboxUnavailableError("handoff write blocked");
  };
  const { fetchImpl, calls } = trackFetch(() =>
    jsonResponse(200, successBody()),
  );
  const client = new RealtimeClient({
    consolidationOutbox: outbox,
    drainFetchImpl: fetchImpl,
    drainNow: nowIso,
    drainLeaseOwner: "wire-b1-t2",
  });
  const h = rcHarness(client);
  h.pendingDialogue = [...KEEP];
  h.handoffRetryQueue = [];
  h.enqueueHandoffFlush("hangup");

  await waitUntil(
    () => h.handoffRetryQueue.length > 0 || h.pendingDialogue.length > 0,
    "B1-T2 handoff failure retains batch in RAM",
  );
  await flushMicrotasks();
  await flushMicrotasks();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 20);
  });
  assert.equal(calls.length, 0, "failed handoff must not auto-drain");
  assert.equal(outbox.list().length, 0);
  assert.equal(h.activeDrain, null);
}

/**
 * B1-T3：handoff 队列任务不得 await 排在自身之后的 drain（有限超时）。
 * 若误写成 handoff then 内 await drain，fetch 门闸会导致超时失败。
 * 主路径胜出时必须 clearTimeout，避免 race 落败支路事后 unhandledRejection。
 */
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>((resolve) => {
    let settled = false;
    releaseFetch = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
  });
  let fetchStarted!: () => void;
  const fetchStartedP = new Promise<void>((resolve) => {
    fetchStarted = resolve;
  });
  let inFlight = 0;
  let maxInFlight = 0;
  const { fetchImpl, calls } = trackFetch(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    fetchStarted();
    await fetchGate;
    inFlight -= 1;
    return jsonResponse(200, successBody());
  });
  const client = new RealtimeClient({
    consolidationOutbox: outbox,
    drainFetchImpl: fetchImpl,
    drainNow: nowIso,
    drainLeaseOwner: "wire-b1-t3",
  });
  const h = rcHarness(client);
  h.pendingDialogue = [...KEEP];
  h.handoffRetryQueue = [];

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const clearDeadlockTimeout = () => {
    if (timeoutId === null) return;
    clearTimeout(timeoutId);
    timeoutId = null;
  };

  try {
    h.enqueueHandoffFlush("hangup");

    // 超时必须失败：死锁时 fetch 永不开始；胜出后取消定时器。
    await Promise.race([
      fetchStartedP.then(() => {
        clearDeadlockTimeout();
      }),
      new Promise<void>((_, reject) => {
        timeoutId = setTimeout(() => {
          timeoutId = null;
          reject(
            new Error(
              "B1-T3 timeout: drain fetch never started (possible self-deadlock)",
            ),
          );
        }, 2_000);
      }),
    ]);

    assert.equal(calls.length, 1);
    assert.equal(maxInFlight, 1);
    // handoff 已结束才能走到 fetch；此时 outbox 已有批且 activeDrain 非空
    assert.ok(outbox.list().length >= 1);
    assert.ok(h.activeDrain);

    releaseFetch();
    await waitUntil(() => outbox.list().length === 0, "B1-T3 drain complete");
    assert.equal(h.activeDrain, null);
  } finally {
    clearDeadlockTimeout();
    // 超时／断言失败时也放开门闸，避免 in-flight drain 卡住后续用例的 consolidationTail
    releaseFetch();
  }
}

/**
 * B1-T4：已有 drain 时 handoff 成功再触发，遵守 activeDrain 单飞。
 */
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  await seedOutboxItem(outbox, "wire-b1-t4-0000-4000-8000-0000000004");

  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  let inFlight = 0;
  let maxInFlight = 0;
  const { fetchImpl, calls } = trackFetch(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await fetchGate;
    inFlight -= 1;
    return jsonResponse(200, successBody());
  });
  const client = new RealtimeClient({
    consolidationOutbox: outbox,
    drainFetchImpl: fetchImpl,
    drainNow: nowIso,
    drainLeaseOwner: "wire-b1-t4",
  });
  const h = rcHarness(client);

  const first = client.drainConsolidationOutboxNow();
  await waitUntil(() => calls.length >= 1, "B1-T4 first fetch");
  const firstActive = h.activeDrain;
  assert.ok(firstActive);

  h.pendingDialogue = [
    { role: "user", text: "单飞期间另一批要持久化的对话" },
    { role: "companion", text: "好" },
  ];
  h.handoffRetryQueue = [];
  h.enqueueHandoffFlush("hangup");

  // handoff 仍堵在 first drain 之后；即使 trailing 调度，也应复用 activeDrain
  await flushMicrotasks();
  await flushMicrotasks();
  assert.equal(h.activeDrain, firstActive);
  assert.equal(maxInFlight, 1);

  releaseFetch();
  await first;
  // handoff + 可能的二次 drain（若 first 结束后 trailing 再入队）
  await waitUntil(() => maxInFlight <= 1, "B1-T4 never parallel");
  await waitUntil(
    () => h.activeDrain === null && outbox.list().length === 0,
    "B1-T4 eventually drained",
  );
  assert.equal(maxInFlight, 1, "never two concurrent drain fetches");
  assert.ok(calls.length >= 1);
}

/**
 * B1-T5：drain 网络失败不破坏已 handoff 的 outbox；无未处理 rejection。
 */
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  const { fetchImpl, calls } = trackFetch(() => {
    throw new TypeError("Failed to fetch");
  });
  const client = new RealtimeClient({
    consolidationOutbox: outbox,
    drainFetchImpl: fetchImpl,
    drainNow: nowIso,
    drainLeaseOwner: "wire-b1-t5",
  });
  const h = rcHarness(client);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);

  h.pendingDialogue = [...KEEP];
  h.handoffRetryQueue = [];
  const handoffDay = handoffLocalDate();
  h.enqueueHandoffFlush("hangup");

  await waitUntil(() => calls.length >= 1, "B1-T5 drain attempted");
  await waitUntil(() => h.activeDrain === null, "B1-T5 drain settled");
  await flushMicrotasks();
  await flushMicrotasks();

  assert.equal(outbox.list().length, 1, "batch retained after network failure");
  const retained = outbox.list()[0]!;
  assert.equal(retained.status, "pending");
  assert.ok(retained.payloadHash.length > 0);
  assert.equal(retained.occurredOn, handoffDay);
  assert.equal(calls[0]!.body.batchId, retained.batchId);
  assert.equal(calls[0]!.body.payloadHash, retained.payloadHash);
  assert.equal(calls[0]!.body.occurredOn, retained.occurredOn);
  assert.deepEqual(calls[0]!.body.turns, retained.turns);
  assert.deepEqual(retained.turns, KEEP);

  const fetchUnhandled = unhandled.filter(
    (reason) =>
      reason instanceof Error && /Failed to fetch/.test(reason.message),
  );
  assert.equal(fetchUnhandled.length, 0, "no unhandled drain rejection");
  process.off("unhandledRejection", onUnhandled);
}

// =============================================================================
// 1B-3D-2B2／PA：生产唯一 runPostAdoptConnectEffects
// =============================================================================

/**
 * PA-T4 静态：RealtimeClient.connect 调用生产 helper；无内联 adopt 双轨。
 */
{
  const rcPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../src/realtime/RealtimeClient.ts",
  );
  const src = readFileSync(rcPath, "utf8");
  const helperPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../src/realtime/postAdoptConnectEffects.ts",
  );
  const helperSrc = readFileSync(helperPath, "utf8");
  assert.ok(
    helperSrc.includes("export async function runPostAdoptConnectEffects"),
    "helper must export runPostAdoptConnectEffects",
  );
  assert.ok(
    src.includes('from "./postAdoptConnectEffects"'),
    "RealtimeClient must import postAdoptConnectEffects",
  );
  const adoptCallIdx = src.indexOf("const adopted = adoptOrReleaseLiveSession({");
  const runIdx = src.indexOf("await runPostAdoptConnectEffects({");
  const onopenIdx = src.indexOf("onopen:");
  assert.ok(adoptCallIdx > 0, "adoptOrReleaseLiveSession call present");
  assert.ok(runIdx > adoptCallIdx, "runPostAdoptConnectEffects after adopt");
  assert.ok(
    onopenIdx > 0 && adoptCallIdx > onopenIdx,
    "adopt/helper after live.connect returns (not inside onopen)",
  );
  assert.equal(
    src.includes("if (!adopted) {\n        // 迟到的 connect 结果已在 adoptOrRelease 中 close"),
    false,
    "must not keep inline !adopted early-return twin of helper",
  );
  // connect 体内不得再 await startMicrophone（已迁入 helper 回调）
  const connectStart = src.indexOf("async connect(): Promise<void>");
  const connectEnd = src.indexOf("\n  disconnect(): void");
  assert.ok(connectStart > 0 && connectEnd > connectStart);
  const connectBody = src.slice(connectStart, connectEnd);
  assert.equal(
    connectBody.includes("await this.startMicrophone(generation)"),
    false,
    "connect must not inline await startMicrophone; use helper callback",
  );
  assert.ok(
    connectBody.includes("runPostAdoptConnectEffects"),
    "connect body must call runPostAdoptConnectEffects",
  );
}

/**
 * PA-T1：adopted=false → 所有回调均未调用；无 drain POST。
 */
{
  const order: string[] = [];
  let scheduleCalls = 0;
  let cueCalls = 0;
  let micCalls = 0;
  let afterCalls = 0;

  await runPostAdoptConnectEffects({
    adopted: false,
    scheduleBoundedDrainAfterConnect: () => {
      scheduleCalls += 1;
      order.push("schedule");
    },
    cueReunion: () => {
      cueCalls += 1;
      order.push("cue");
    },
    startMicrophone: async () => {
      micCalls += 1;
      order.push("mic");
    },
    afterMicrophone: () => {
      afterCalls += 1;
      order.push("after");
    },
  });

  assert.equal(scheduleCalls, 0);
  assert.equal(cueCalls, 0);
  assert.equal(micCalls, 0);
  assert.equal(afterCalls, 0);
  assert.deepEqual(order, []);
  assertNoDefaultFetch("PA-T1");
}

/**
 * PA-T2：adopted=true + deferred drain → mic／after 在 drain 完成前已继续（非阻塞）。
 * 使用生产 helper；schedule 绑定真实 RC scheduleBoundedDrainAfterConnect。
 */
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  await seedOutboxItem(outbox, "wire-pa-t2-0000-4000-8000-0000000002");
  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>((resolve) => {
    let settled = false;
    releaseFetch = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
  });
  let fetchStarted!: () => void;
  const fetchStartedP = new Promise<void>((resolve) => {
    fetchStarted = resolve;
  });
  const { fetchImpl, calls } = trackFetch(async () => {
    fetchStarted();
    await fetchGate;
    return jsonResponse(200, successBody());
  });
  const client = new RealtimeClient({
    consolidationOutbox: outbox,
    drainFetchImpl: fetchImpl,
    drainNow: nowIso,
    drainLeaseOwner: "wire-pa-t2",
  });
  const h = rcHarness(client);
  // 保持 socketConnected=false，避免 sent_removed 后 refresh* 走默认 fetch。

  const order: string[] = [];
  const effectsDone = runPostAdoptConnectEffects({
    adopted: true,
    scheduleBoundedDrainAfterConnect: () => {
      order.push("schedule");
      h.scheduleBoundedDrainAfterConnect();
    },
    cueReunion: () => {
      order.push("cue");
    },
    startMicrophone: async () => {
      order.push("mic");
    },
    afterMicrophone: () => {
      order.push("after");
    },
  });

  // helper 不 await drain：effects 应在 gate 仍锁住时完成
  await effectsDone;
  assert.deepEqual(order, ["schedule", "cue", "mic", "after"]);
  assert.ok(h.activeDrain, "drain flight still in progress after mic path");
  assert.equal(outbox.list().length, 1, "drain not finished; mic path already done");

  await fetchStartedP;
  order.push("fetch_started");
  assert.equal(calls.length, 1);
  assert.deepEqual(order, [
    "schedule",
    "cue",
    "mic",
    "after",
    "fetch_started",
  ]);

  releaseFetch();
  await waitUntil(
    () => outbox.list().length === 0 && h.activeDrain === null,
    "PA-T2 drain finishes after mic path",
  );
  assertNoDefaultFetch("PA-T2");
}

/**
 * PA-T3：adopted=true → 真实 RC connect-drain helper 清空内存 outbox（mock fetch）。
 */
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  const item = await seedOutboxItem(
    outbox,
    "wire-pa-t3-0000-4000-8000-0000000003",
  );
  const { fetchImpl, calls } = trackFetch(() =>
    jsonResponse(200, successBody()),
  );
  const client = new RealtimeClient({
    consolidationOutbox: outbox,
    drainFetchImpl: fetchImpl,
    drainNow: nowIso,
    drainLeaseOwner: "wire-pa-t3",
  });
  const h = rcHarness(client);
  // 保持 socketConnected=false，避免 sent_removed 后 refresh* 走默认 fetch。

  let micRan = false;
  await runPostAdoptConnectEffects({
    adopted: true,
    scheduleBoundedDrainAfterConnect: () => {
      h.scheduleBoundedDrainAfterConnect();
    },
    cueReunion: () => {},
    startMicrophone: async () => {
      micRan = true;
    },
    afterMicrophone: () => {},
  });

  assert.equal(micRan, true);
  await waitUntil(() => outbox.list().length === 0, "PA-T3 outbox cleared");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.body.batchId, item.batchId);
  assert.equal(calls[0]!.body.payloadHash, item.payloadHash);
  assert.equal(calls[0]!.body.occurredOn, item.occurredOn);
  assert.deepEqual(calls[0]!.body.turns, item.turns);
  assert.equal(h.activeDrain, null);
  assertNoDefaultFetch("PA-T3");
}

/**
 * PA-T1b：adopted=false 时即使 RC 有 pending，也不经 helper 触发 drain。
 */
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  await seedOutboxItem(outbox, "wire-pa-t1b-0000-4000-8000-000000001b");
  const { fetchImpl, calls } = trackFetch(() =>
    jsonResponse(200, successBody()),
  );
  const client = new RealtimeClient({
    consolidationOutbox: outbox,
    drainFetchImpl: fetchImpl,
    drainNow: nowIso,
    drainLeaseOwner: "wire-pa-t1b",
  });
  const h = rcHarness(client);

  await runPostAdoptConnectEffects({
    adopted: false,
    scheduleBoundedDrainAfterConnect: () => {
      h.scheduleBoundedDrainAfterConnect();
    },
    cueReunion: () => {},
    startMicrophone: async () => {},
    afterMicrophone: () => {},
  });

  await flushMicrotasks();
  await flushMicrotasks();
  assert.equal(calls.length, 0, "adopted=false must not POST");
  assert.equal(outbox.list().length, 1);
  assert.equal(h.activeDrain, null);
  assertNoDefaultFetch("PA-T1b");
}

/**
 * PA-T7：adopted=true 且 schedule 同步抛错 → helper Promise 拒绝；
 * cue／startMicrophone／afterMicrophone 均不执行（当前生产契约，非吞错）。
 * 不调用真实 fetch。
 */
{
  const order: string[] = [];
  const syncError = new Error("pA-T7 schedule sync failure");
  let rejected: unknown = null;

  try {
    await runPostAdoptConnectEffects({
      adopted: true,
      scheduleBoundedDrainAfterConnect: () => {
        order.push("schedule");
        throw syncError;
      },
      cueReunion: () => {
        order.push("cue");
      },
      startMicrophone: async () => {
        order.push("mic");
      },
      afterMicrophone: () => {
        order.push("after");
      },
    });
  } catch (error) {
    rejected = error;
  }

  assert.equal(rejected, syncError, "helper must reject with the sync schedule error");
  assert.deepEqual(order, ["schedule"], "cue/mic/after must not run after schedule throw");
  assertNoDefaultFetch("PA-T7");
}

/**
 * B2-T4：进行中的 handoff 与 connect drain 串行；冻字段不变。
 */
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
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
  let digestGateArmed = false;
  const digestSpy: typeof subtle.digest = async (algorithm, data) => {
    if (digestGateArmed) {
      order.push("handoff_digest");
      digestPaused();
      await digestGate;
      digestGateArmed = false;
    }
    return originalDigest(algorithm, data);
  };
  Object.defineProperty(subtle, "digest", {
    configurable: true,
    value: digestSpy,
  });

  const originalAdd = outbox.add.bind(outbox);
  outbox.add = (input: AddConsolidationOutboxInput): ConsolidationOutboxItem => {
    order.push("handoff_add");
    return originalAdd(input);
  };

  const { fetchImpl, calls } = trackFetch(() => {
    order.push("drain_fetch");
    return jsonResponse(200, successBody());
  });
  const client = new RealtimeClient({
    consolidationOutbox: outbox,
    drainFetchImpl: fetchImpl,
    drainNow: nowIso,
    drainLeaseOwner: "wire-b2-t4",
  });
  const h = rcHarness(client);
  // socketConnected 保持 false，避免成功 drain 触发 refresh 默认 fetch。
  h.pendingDialogue = [...KEEP];
  h.handoffRetryQueue = [];

  try {
    digestGateArmed = true;
    h.enqueueHandoffFlush("hangup");
    await digestPausedP;
    assert.equal(calls.length, 0);

    h.scheduleBoundedDrainAfterConnect();
    await flushMicrotasks();
    await flushMicrotasks();
    assert.equal(calls.length, 0, "connect drain must wait for handoff on tail");
    assert.ok(!order.includes("handoff_add"));

    releaseDigest();
    await waitUntil(() => calls.length >= 1, "B2-T4 drain after handoff");
    assert.ok(order.indexOf("handoff_add") < order.indexOf("drain_fetch"));
    assert.equal(calls[0]!.body.occurredOn, handoffLocalDate());
    assert.deepEqual(calls[0]!.body.turns, KEEP);
    assert.ok(typeof calls[0]!.body.batchId === "string");
    assert.ok(calls[0]!.body.payloadHash.length === 64);
    await waitUntil(() => outbox.list().length === 0, "B2-T4 cleared");
  } finally {
    Object.defineProperty(subtle, "digest", {
      configurable: true,
      value: originalDigest,
    });
  }
}

/**
 * B2-T5：cleanup 等待 hangupHandoffBoundary，不等待 B1 后置 drain 的 HTTP。
 * 边界：不调用完整 RealtimeClient.cleanup（依赖 AudioContext／session）。
 */
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>((resolve) => {
    let settled = false;
    releaseFetch = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
  });
  let fetchStarted!: () => void;
  const fetchStartedP = new Promise<void>((resolve) => {
    fetchStarted = resolve;
  });
  const { fetchImpl, calls } = trackFetch(async () => {
    fetchStarted();
    await fetchGate;
    return jsonResponse(200, successBody());
  });
  const client = new RealtimeClient({
    consolidationOutbox: outbox,
    drainFetchImpl: fetchImpl,
    drainNow: nowIso,
    drainLeaseOwner: "wire-b2-t5",
  });
  const h = rcHarness(client);
  h.pendingDialogue = [...KEEP];
  h.handoffRetryQueue = [];

  try {
    h.enqueueHandoffFlush("hangup");
    const { boundary, timeoutMs, aheadDrainSkipsWait } =
      cleanupHandoffWaitFromHarness(h);
    assert.equal(aheadDrainSkipsWait, false, "B1 path: no ahead drain at capture");
    const waitStatus = await awaitHandoffTailWithTimeout(boundary, timeoutMs);
    assert.equal(waitStatus, "completed", "hangupHandoffBoundary settles after handoff+post");

    await fetchStartedP;
    assert.equal(calls.length, 1);
    assert.equal(
      outbox.list().length,
      1,
      "B1 drain HTTP still gated after hangupHandoffBoundary completed",
    );
  } finally {
    releaseFetch();
    await waitUntil(
      () => rcHarness(client).activeDrain === null,
      "B2-T5 drain settles after gate release",
    );
  }
}

/**
 * connect-drain-ahead-of-cleanup（1B-3D-2B2-FIX）：
 * connect drain fetch gated 时，cleanup 等待按修复语义结束（不等待 drain HTTP）；
 * hangup 仍可能排在 drain 之后，不得宣称已持久化。
 */
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  await seedOutboxItem(outbox, "wire-fix-ahead-0000-4000-8000-00000001");
  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>((resolve) => {
    let settled = false;
    releaseFetch = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
  });
  let fetchStarted!: () => void;
  const fetchStartedP = new Promise<void>((resolve) => {
    fetchStarted = resolve;
  });
  const { fetchImpl, calls } = trackFetch(async () => {
    fetchStarted();
    await fetchGate;
    return jsonResponse(200, successBody());
  });
  const client = new RealtimeClient({
    consolidationOutbox: outbox,
    drainFetchImpl: fetchImpl,
    drainNow: nowIso,
    drainLeaseOwner: "wire-fix-ahead",
  });
  const h = rcHarness(client);
  // socketConnected 保持 false，避免成功 drain 触发 refresh 默认 fetch。

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);

  try {
    h.scheduleBoundedDrainAfterConnect();
    await fetchStartedP;
    assert.ok(h.activeDrain, "connect drain in flight");
    assert.equal(calls.length, 1);

    // 真实 hangup／cleanup 入队序：flushDialogueNow → enqueue hangup
    h.pendingDialogue = [...KEEP];
    h.handoffRetryQueue = [];
    h.enqueueHandoffFlush("hangup");

    const { boundary, timeoutMs, aheadDrainSkipsWait } =
      cleanupHandoffWaitFromHarness(h);
    assert.equal(aheadDrainSkipsWait, true, "activeDrain forces skip wait");
    assert.equal(timeoutMs, 0);

    const waitStatus = await awaitHandoffTailWithTimeout(boundary, timeoutMs);
    assert.equal(
      waitStatus,
      "timeout",
      "cleanup wait ends without drain HTTP; not persist-guaranteed",
    );

    // hangup 仍卡在共享 tail 上（drain 之后）——尚未领取 pending／写 outbox
    assert.deepEqual(h.pendingDialogue, KEEP, "hangup body not run yet");
    assert.equal(h.handoffRetryQueue.length, 0, "no false sticky from skipped wait");
    assert.equal(calls.length, 1, "no extra consolidate POST");
    assert.equal(outbox.list().length, 1, "seed still gated in outbox");
  } finally {
    releaseFetch();
    await waitUntil(
      () => rcHarness(client).activeDrain === null,
      "connect-drain-ahead: drain settles after gate release",
    );
    process.off("unhandledRejection", onUnhandled);
    assert.equal(unhandled.length, 0, "no unhandled rejection");
  }
}

/**
 * hangupHandoffBoundary：正常完成时 settle；失败时仍 settle 且 sticky 保留。
 */
{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const outbox = makeOutbox();
  const { fetchImpl } = trackFetch(() => jsonResponse(200, successBody()));
  const client = new RealtimeClient({
    consolidationOutbox: outbox,
    drainFetchImpl: fetchImpl,
    drainNow: nowIso,
    drainLeaseOwner: "wire-boundary-ok",
  });
  const h = rcHarness(client);
  h.pendingDialogue = [...KEEP];
  h.handoffRetryQueue = [];
  h.enqueueHandoffFlush("hangup");
  const waitStatus = await awaitHandoffTailWithTimeout(
    h.hangupHandoffBoundary,
    CLEANUP_HANDOFF_WAIT_MS,
  );
  assert.equal(waitStatus, "completed");
  assert.equal(outbox.list().length, 1);
  assert.equal(h.handoffRetryQueue.length, 0);
}

{
  clockMs = Date.UTC(2026, 9, 20, 12, 0, 0, 0);
  const storage = createMemoryOutboxStorage();
  const failing = new ConsolidationOutbox({
    storage: {
      getItem: (key: string) => storage.getItem(key),
      removeItem: (key: string) => storage.removeItem(key),
      setItem() {
        throw new ConsolidationOutboxUnavailableError("full");
      },
    },
    now: nowIso,
  });
  const { fetchImpl } = trackFetch(() => jsonResponse(200, successBody()));
  const client = new RealtimeClient({
    consolidationOutbox: failing,
    drainFetchImpl: fetchImpl,
    drainNow: nowIso,
    drainLeaseOwner: "wire-boundary-fail",
  });
  const h = rcHarness(client);
  h.pendingDialogue = [...KEEP];
  h.handoffRetryQueue = [];
  h.enqueueHandoffFlush("hangup");
  const waitStatus = await awaitHandoffTailWithTimeout(
    h.hangupHandoffBoundary,
    CLEANUP_HANDOFF_WAIT_MS,
  );
  assert.equal(waitStatus, "completed", "boundary settles on handoff failure");
  assert.equal(h.handoffRetryQueue.length, 1, "sticky retained");
  assert.ok(h.handoffRetryQueue[0]!.frozen, "frozen payload retained");
  assert.equal(failing.list().length, 0, "failed write did not persist");
}

assertNoDefaultFetch("final");
console.log("[consolidation-drain-wire] ok");
console.log(
  "[consolidation-drain-wire] coverage: RealtimeClient instance + runPostAdoptConnectEffects + injected memory outbox/mock fetch + private harness; not Live connect/E2E",
);
} finally {
  globalThis.fetch = previousFetch;
}
