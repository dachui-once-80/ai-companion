/**
 * drain 任务抛错后，调用方仍看到原始异常，共享 tail 恢复为 fulfilled，
 * 后续任务仍能按入队顺序执行。
 *
 * 本文件单独由 tsx 启动，模块级 tail 从已完成状态开始。
 * 不调用 tail.catch()，也不重置 tail。隔离只靠独立进程，不用清理掩盖拒绝。
 * 不调用 RealtimeClient.connect()。内存 outbox + mock fetch。
 */
import assert from "node:assert/strict";
import { RealtimeClient } from "../src/realtime/RealtimeClient.ts";
import {
  ConsolidationOutbox,
  createMemoryOutboxStorage,
} from "../src/realtime/consolidationOutbox.ts";
import type { DrainFetch } from "../src/realtime/consolidationDrain.ts";
import { computeConsolidationPayloadHash } from "../src/realtime/consolidationPayload.ts";
import {
  currentConsolidationTail,
  enqueueSerialDrain,
} from "../src/realtime/consolidationDrainCoordinator.ts";

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

const unhandled: unknown[] = [];
process.on("unhandledRejection", (reason) => {
  unhandled.push(reason);
});

function nowIso(): string {
  return NOW;
}

async function seed(outbox: ConsolidationOutbox, batchId: string) {
  const payloadHash = await computeConsolidationPayloadHash(OCCURRED_ON, TURNS);
  return outbox.add({
    batchId,
    payloadHash,
    occurredOn: OCCURRED_ON,
    turns: TURNS,
  });
}

const outbox = new ConsolidationOutbox({
  storage: createMemoryOutboxStorage(),
  now: nowIso,
});
await seed(outbox, "tail-reject-0000-4000-8000-000000000001");

let nowInvoke = 0;
const drainNow = (): string => {
  nowInvoke += 1;
  if (nowInvoke === 2) {
    throw new Error("injected drainNow failure");
  }
  return nowIso();
};

const calls: string[] = [];
const fetchImpl: DrainFetch = async (url) => {
  calls.push(url);
  throw new Error("drain fetch must not run");
};

const client = new RealtimeClient({
  consolidationOutbox: outbox,
  drainFetchImpl: fetchImpl,
  drainNow,
  drainLeaseOwner: "tail-reject-connect",
});

const flight = client.drainConsolidationOutboxNow();
await assert.rejects(flight, /injected drainNow failure/);
await currentConsolidationTail();

assert.equal(calls.length, 0);
assert.equal(defaultFetchHits, 0);

let followed = false;
const next = enqueueSerialDrain(async () => {
  followed = true;
  return { outcomes: [], processed: 0, stoppedReason: "done" };
});
const nextResult = await next;
assert.equal(followed, true);
assert.equal(nextResult.processed, 0);
assert.equal(nextResult.stoppedReason, "done");
await currentConsolidationTail();

assert.equal(unhandled.length, 0);

console.log("[consolidation-tail-reject-connect] ok");
