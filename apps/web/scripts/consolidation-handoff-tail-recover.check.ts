/**
 * handoff 回调抛错后，共享 tail 恢复为 fulfilled，已领取但未持久化的对话还在。
 *
 * 本文件单独由 tsx 启动，模块级 tail 从已完成状态开始。
 * 不调用 tail.catch()，也不重置 tail。不调用 RealtimeClient.connect()。
 * 内存 outbox + mock fetch。不读默认 localStorage。
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

const NOW = "2026-10-21T03:00:00.000Z";
const OCCURRED_ON = "2026-10-21";
const KEPT = [
  { role: "user" as const, text: "我周末去看了展，记得一下" },
  { role: "companion" as const, text: "好，记下了" },
];
const SECOND = [
  { role: "user" as const, text: "第二条还冻着的批次也要留住" },
  { role: "companion" as const, text: "记下了" },
];
const PENDING_BEFORE = "领取前还没交出去的话要留住";
const ARRIVED_DURING = "异常期间刚到的一句";

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

const warnings: string[] = [];
const originalWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  warnings.push(args.map((part) => String(part)).join(" "));
  originalWarn(...args);
};

(globalThis as { window?: Window }).window = {
  setTimeout(fn: () => void, ms: number) {
    void fn;
    void ms;
    return 1;
  },
  clearTimeout() {},
} as unknown as Window;

type Harness = {
  pendingDialogue: Array<{ role: "user" | "companion"; text: string }>;
  handoffRetryQueue: Array<{
    batchId: string;
    turns: Array<{ role: "user" | "companion"; text: string }>;
    occurredOnRaw?: string;
    frozen?: {
      batchId: string;
      occurredOn: string;
      payloadHash: string;
      turns: Array<{ role: "user" | "companion"; text: string }>;
    };
  }>;
  hangupHandoffBoundary: Promise<void>;
  enqueueHandoffFlush: (mode: "scheduled" | "hangup") => void;
};

function harness(client: RealtimeClient): Harness {
  return client as unknown as Harness;
}

function makeClient(outbox: ConsolidationOutbox, owner: string): Harness {
  return harness(
    new RealtimeClient({
      consolidationOutbox: outbox,
      drainFetchImpl: (async () => {
        defaultFetchHits += 1;
        throw new Error("drain fetch blocked");
      }) as DrainFetch,
      drainNow: () => NOW,
      drainLeaseOwner: owner,
    }),
  );
}

const firstHash = await computeConsolidationPayloadHash(OCCURRED_ON, KEPT);
const secondHash = await computeConsolidationPayloadHash(OCCURRED_ON, SECOND);
const firstId = "handoff-throw-0000-4000-8000-000000000001";
const secondId = "handoff-throw-0000-4000-8000-000000000002";

const throwOutbox = new ConsolidationOutbox({
  storage: createMemoryOutboxStorage(),
  now: () => NOW,
});
const throwingClient = makeClient(throwOutbox, "handoff-tail-throw");

let thrown = false;
throwingClient.pendingDialogue = [
  { role: "user", text: PENDING_BEFORE },
];
throwingClient.handoffRetryQueue = [
  {
    batchId: firstId,
    occurredOnRaw: OCCURRED_ON,
    turns: [
      {
        role: "user",
        get text(): string {
          if (!thrown) {
            thrown = true;
            throwingClient.pendingDialogue.push({
              role: "companion",
              text: ARRIVED_DURING,
            });
            throw new Error("injected handoff task failure");
          }
          return KEPT[0]!.text;
        },
      },
      KEPT[1]!,
    ],
    frozen: {
      batchId: firstId,
      occurredOn: OCCURRED_ON,
      payloadHash: firstHash,
      turns: KEPT.map((turn) => ({ ...turn })),
    },
  },
  {
    batchId: secondId,
    occurredOnRaw: OCCURRED_ON,
    turns: SECOND.map((turn) => ({ ...turn })),
    frozen: {
      batchId: secondId,
      occurredOn: OCCURRED_ON,
      payloadHash: secondHash,
      turns: SECOND.map((turn) => ({ ...turn })),
    },
  },
];

const boundaryBefore = throwingClient.hangupHandoffBoundary;
throwingClient.enqueueHandoffFlush("hangup");
const boundary = throwingClient.hangupHandoffBoundary;
assert.notEqual(boundary, boundaryBefore);
await boundary;
await currentConsolidationTail();
await new Promise((resolve) => setImmediate(resolve));

assert.equal(thrown, true);
assert.equal(throwOutbox.list().length, 0);
assert.deepEqual(
  throwingClient.pendingDialogue.map((turn) => turn.text),
  [PENDING_BEFORE, ARRIVED_DURING],
);
assert.equal(throwingClient.handoffRetryQueue.length, 2);
assert.equal(throwingClient.handoffRetryQueue[0]?.batchId, firstId);
assert.equal(throwingClient.handoffRetryQueue[1]?.batchId, secondId);
assert.equal(throwingClient.handoffRetryQueue[0]?.frozen?.batchId, firstId);
assert.equal(throwingClient.handoffRetryQueue[0]?.frozen?.occurredOn, OCCURRED_ON);
assert.equal(throwingClient.handoffRetryQueue[0]?.frozen?.payloadHash, firstHash);
assert.deepEqual(throwingClient.handoffRetryQueue[0]?.frozen?.turns, KEPT);
assert.equal(throwingClient.handoffRetryQueue[1]?.frozen?.payloadHash, secondHash);
assert.deepEqual(throwingClient.handoffRetryQueue[1]?.frozen?.turns, SECOND);
assert.ok(
  warnings.some((line) =>
    line.includes("consolidation handoff failed; batch retained for retry"),
  ),
);
assert.equal(
  warnings.some((line) => line.includes("uncertain")),
  false,
);
assert.equal(
  warnings.some((line) => line.includes("consolidation handoff tail recovered")),
  false,
);
assert.equal(unhandled.length, 0);

let followed = false;
const next = enqueueSerialDrain(async () => {
  followed = true;
  return { outcomes: [], processed: 0, stoppedReason: "done" };
});
const nextResult = await next;
assert.equal(followed, true);
assert.equal(nextResult.processed, 0);
await currentConsolidationTail();

warnings.length = 0;
const retryOutbox = new ConsolidationOutbox({
  storage: createMemoryOutboxStorage(),
  now: () => NOW,
});
retryOutbox.add = () => {
  throw new Error("injected outbox add failure");
};
const retryClient = makeClient(retryOutbox, "handoff-tail-retry");
retryClient.pendingDialogue = KEPT.map((turn) => ({ ...turn }));
retryClient.enqueueHandoffFlush("hangup");
await retryClient.hangupHandoffBoundary;
await currentConsolidationTail();
await new Promise((resolve) => setImmediate(resolve));

assert.equal(retryOutbox.list().length, 0);
assert.equal(retryClient.pendingDialogue.length, 0);
assert.equal(retryClient.handoffRetryQueue.length, 1);
const sticky = retryClient.handoffRetryQueue[0]!;
assert.equal(sticky.frozen?.occurredOn, OCCURRED_ON);
assert.equal(sticky.frozen?.payloadHash.length, 64);
assert.equal(sticky.batchId, sticky.frozen?.batchId);
assert.deepEqual(sticky.frozen?.turns, KEPT);
assert.deepEqual(sticky.turns, KEPT);
assert.ok(
  warnings.some((line) =>
    line.includes("consolidation handoff failed; batch retained for retry"),
  ),
);
assert.equal(
  warnings.some((line) =>
    line.includes("restoring unpersisted dialogue") ||
    line.includes("consolidation handoff task failed") ||
    line.includes("consolidation handoff tail recovered") ||
    line.includes("consolidation handoff restore failed"),
  ),
  false,
);
assert.equal(defaultFetchHits, 0);
assert.equal(unhandled.length, 0);

console.log("[consolidation-handoff-tail-recover] ok");
