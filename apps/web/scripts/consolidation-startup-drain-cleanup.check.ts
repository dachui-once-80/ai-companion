/**
 * 启动恢复 drain 占着共享队列、当前 RealtimeClient.activeDrain 仍为空时，
 * 直接调用真实 cleanup()。
 *
 * 不调用 connect()，不创建 Live session，不开麦。
 * 内存 outbox + mock fetch。本进程单独启动，不重置共享 tail。
 */
import assert from "node:assert/strict";
import { RealtimeClient } from "../src/realtime/RealtimeClient.ts";
import {
  ConsolidationOutbox,
  createMemoryOutboxStorage,
} from "../src/realtime/consolidationOutbox.ts";
import type { DrainFetch } from "../src/realtime/consolidationDrain.ts";
import { computeConsolidationPayloadHash } from "../src/realtime/consolidationPayload.ts";
import { consolidationDrainInFlight } from "../src/realtime/consolidationDrainCoordinator.ts";
import { scheduleStartupConsolidationDrain } from "../src/realtime/startupConsolidationDrain.ts";

const NOW = "2026-10-20T12:00:00.000Z";
const OCCURRED_ON = "2026-10-20";
const TURNS = [
  { role: "user" as const, text: "我周末去看了展，记得一下" },
  { role: "companion" as const, text: "好，记下了" },
];

type Harness = {
  cleanup: () => Promise<void>;
  activeDrain: Promise<unknown> | null;
  pendingDialogue: Array<{ role: "user" | "companion"; text: string }>;
  handoffRetryQueue: unknown[];
  hangupHandoffBoundary: Promise<void>;
};

function harness(client: RealtimeClient): Harness {
  return client as unknown as Harness;
}

function now(): string {
  return NOW;
}

function ensureNodeWindowTimers(): void {
  const g = globalThis as typeof globalThis & {
    window?: Window & typeof globalThis;
  };
  if (g.window?.setTimeout && g.window.clearTimeout && g.window.clearInterval) {
    return;
  }
  const fake = {
    setTimeout: (fn: () => void, ms?: number) => {
      const handle = setTimeout(fn, ms);
      if (typeof handle === "object" && handle && "unref" in handle) {
        handle.unref();
      }
      return handle as unknown as number;
    },
    clearTimeout: (id: number) => {
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
    },
    clearInterval: (id: number) => {
      clearInterval(id as unknown as ReturnType<typeof setInterval>);
    },
  };
  g.window = fake as unknown as Window & typeof globalThis;
}

ensureNodeWindowTimers();

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

const unhandled: unknown[] = [];
process.on("unhandledRejection", (reason) => {
  unhandled.push(reason);
});

const outbox = new ConsolidationOutbox({
  storage: createMemoryOutboxStorage(),
  now,
});
const payloadHash = await computeConsolidationPayloadHash(OCCURRED_ON, TURNS);
await outbox.add({
  batchId: "startup-cleanup-0000-4000-8000-000000000001",
  payloadHash,
  occurredOn: OCCURRED_ON,
  turns: TURNS,
});

let releaseFetch!: () => void;
const fetchGate = new Promise<void>((resolve) => {
  releaseFetch = resolve;
});
let fetchStarted!: () => void;
const fetchStartedP = new Promise<void>((resolve) => {
  fetchStarted = resolve;
});
let fetchCalls = 0;
const fetchImpl: DrainFetch = async () => {
  fetchCalls += 1;
  if (fetchCalls === 1) {
    fetchStarted();
    await fetchGate;
  }
  return new Response(
    JSON.stringify({
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
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};

const client = new RealtimeClient({
  consolidationOutbox: outbox,
  drainFetchImpl: fetchImpl,
  drainNow: now,
  drainLeaseOwner: "startup-cleanup-client",
});
const h = harness(client);
h.pendingDialogue = [...TURNS];
h.handoffRetryQueue = [];

const startup = scheduleStartupConsolidationDrain({
  outbox,
  fetchImpl,
  now,
  leaseOwner: "startup-cleanup-boot",
});
await fetchStartedP;

assert.equal(consolidationDrainInFlight(), true);
assert.equal(h.activeDrain, null);
assert.equal(fetchCalls, 1);

const warns: string[] = [];
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  warns.push(args.map((arg) => String(arg)).join(" "));
};

let cleanupReturned = false;
try {
  const cleanupP = h.cleanup();
  const gate = await Promise.race([
    cleanupP.then(() => "returned" as const),
    new Promise<"blocked">((resolve) => {
      const handle = setTimeout(() => resolve("blocked"), 1_000);
      handle.unref();
    }),
  ]);
  assert.equal(
    gate,
    "returned",
    "cleanup waited while the startup drain fetch was still pending",
  );
  cleanupReturned = true;
  await cleanupP;

  assert.equal(h.activeDrain, null);
  assert.equal(consolidationDrainInFlight(), true);
  assert.equal(fetchCalls, 1);
  assert.equal(h.pendingDialogue.length, TURNS.length);
  assert.ok(
    warns.some((line) =>
      line.includes("cleanup skipped handoff wait (drain in flight)"),
    ),
    `missing skip warning: ${warns.join(" | ")}`,
  );
  assert.equal(defaultFetchHits, 0);
} finally {
  console.warn = originalWarn;
  releaseFetch();
}

assert.equal(cleanupReturned, true);
await startup;
await h.hangupHandoffBoundary;
const settleDeadline = Date.now() + 2_000;
while (consolidationDrainInFlight()) {
  if (Date.now() > settleDeadline) {
    throw new Error("shared drain still in flight after fetch release");
  }
  await new Promise((resolve) => setImmediate(resolve));
}

assert.equal(unhandled.length, 0);
assert.equal(defaultFetchHits, 0);
console.log("[consolidation-startup-drain-cleanup] ok");
