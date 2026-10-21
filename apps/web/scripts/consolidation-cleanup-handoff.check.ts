/**
 * 1B-3D-0B／0C：cleanup 有界等待、hangup 重试、超时后成功写回、timer 替换。
 * 无 RealtimeClient 网络／无正式库／无真实请求。
 *
 * 覆盖层级说明：
 * - helper／编排：flushDialogueThroughHandoff、gateCleanupOnHandoffTail、scheduleExclusiveTimeout
 * - RealtimeClient 镜像 harness：claim→flush→merge→assign（与 enqueueHandoffFlush 同序）
 * - 非 RealtimeClient 类实例：未构造 RC（依赖 window／Audio）；不得当作实例级覆盖
 */
import assert from "node:assert/strict";
import {
  CLEANUP_HANDOFF_WAIT_MS,
  awaitHandoffTailWithTimeout,
  decideShortDialogueAction,
  flushDialogueThroughHandoff,
  followUpAfterHandoffFailure,
  gateCleanupOnHandoffTail,
  mergePendingAfterFlush,
  scheduleExclusiveTimeout,
  type StickyHandoffBatch,
} from "../src/realtime/consolidationFlushHandoff.ts";
import { handOffDialogueBatchToOutbox } from "../src/realtime/consolidationHandoff.ts";
import {
  ConsolidationOutbox,
  ConsolidationOutboxUnavailableError,
  createMemoryOutboxStorage,
} from "../src/realtime/consolidationOutbox.ts";
import type { DialogueBatchTurn } from "../src/realtime/dialogueBatchPolicy.ts";

const TODAY = "2026-10-20";
const KEEP = [
  { role: "user" as const, text: "我周末去看了展，记得一下" },
  { role: "companion" as const, text: "好，记下了" },
];
const SHORT = [{ role: "user" as const, text: "天气怎么样" }];
const NEWER = [
  { role: "user" as const, text: "这是后来才说的话要记住" },
  { role: "companion" as const, text: "好" },
];

let clock = 0;

function nowIso(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 9, 20, 12, 0, 0, clock)).toISOString();
}

function makeOutbox(storage = createMemoryOutboxStorage()) {
  return new ConsolidationOutbox({ storage, now: nowIso });
}

function failingOutbox() {
  const base = createMemoryOutboxStorage();
  return makeOutbox({
    getItem: (key: string) => base.getItem(key),
    removeItem: (key: string) => base.removeItem(key),
    setItem() {
      throw new ConsolidationOutboxUnavailableError("full");
    },
  });
}

/** 可控假时钟：立即触发或挂起 timeout。 */
function createFakeTimers() {
  const pending: Array<{ ms: number; fn: () => void }> = [];
  return {
    pending,
    setTimeout(fn: () => void, ms: number) {
      const entry = { ms, fn };
      pending.push(entry);
      return entry as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(id: ReturnType<typeof setTimeout>) {
      const idx = pending.indexOf(id as unknown as { ms: number; fn: () => void });
      if (idx >= 0) pending.splice(idx, 1);
    },
    flushAll() {
      const copy = pending.splice(0);
      for (const entry of copy) entry.fn();
    },
  };
}

// --- 短对话策略无回归 ---
{
  assert.equal(decideShortDialogueAction("scheduled", SHORT), "restore");
  assert.equal(decideShortDialogueAction("hangup", SHORT), "drop");
}

// --- P4：hangup／scheduled 失败均 failure_backoff ---
{
  assert.equal(followUpAfterHandoffFailure("hangup"), "failure_backoff");
  assert.equal(followUpAfterHandoffFailure("scheduled"), "failure_backoff");

  const hangupFail = await flushDialogueThroughHandoff({
    mode: "hangup",
    outbox: failingOutbox(),
    pendingDialogue: KEEP,
    handoffRetryQueue: [],
    todayLocal: TODAY,
  });
  assert.equal(hangupFail.diagnostics.followUp, "failure_backoff");
  assert.equal(hangupFail.handoffRetryQueue.length, 1);
  assert.ok(hangupFail.handoffRetryQueue[0]!.frozen);
  const frozen = hangupFail.handoffRetryQueue[0]!.frozen!;

  // 重试身份不变（P4.3）
  const again = await flushDialogueThroughHandoff({
    mode: "scheduled",
    outbox: failingOutbox(),
    pendingDialogue: [],
    handoffRetryQueue: hangupFail.handoffRetryQueue,
    todayLocal: "2026-10-23",
  });
  assert.equal(again.diagnostics.followUp, "failure_backoff");
  assert.equal(again.handoffRetryQueue[0]!.frozen!.batchId, frozen.batchId);
  assert.equal(again.handoffRetryQueue[0]!.frozen!.payloadHash, frozen.payloadHash);
  assert.equal(again.handoffRetryQueue[0]!.frozen!.occurredOn, frozen.occurredOn);
}

// --- P3：cleanup 等待 handoff 成功 ---
{
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let flushed = 0;
  let tail: Promise<void> = Promise.resolve();

  const outbox = makeOutbox();
  const resultPromise = gateCleanupOnHandoffTail({
    flush: () => {
      flushed += 1;
      tail = (async () => {
        await gate;
        await flushDialogueThroughHandoff({
          mode: "hangup",
          outbox,
          pendingDialogue: KEEP,
          handoffRetryQueue: [],
          todayLocal: TODAY,
        });
      })();
    },
    tail: () => tail,
    timeoutMs: 5_000,
  });

  release();
  const result = await resultPromise;
  assert.equal(flushed, 1);
  assert.equal(result.waitStatus, "completed");
  assert.equal(result.handoffGuaranteed, true);
  assert.equal(outbox.list().length, 1);
}

// --- P3：等待超时 ≠ 成功；失败批次仍可诊断保留 ---
{
  const timers = createFakeTimers();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let stickyFrozenHash: string | undefined;
  let tail: Promise<void> = Promise.resolve();

  const resultPromise = gateCleanupOnHandoffTail({
    flush: () => {
      tail = (async () => {
        await gate;
        const output = await flushDialogueThroughHandoff({
          mode: "hangup",
          outbox: failingOutbox(),
          pendingDialogue: KEEP,
          handoffRetryQueue: [],
          todayLocal: TODAY,
        });
        stickyFrozenHash = output.handoffRetryQueue[0]?.frozen?.payloadHash;
        assert.equal(output.diagnostics.followUp, "failure_backoff");
      })();
    },
    tail: () => tail,
    timeoutMs: 50,
    timers,
  });

  // 在 handoff 完成前触发超时
  assert.equal(timers.pending.length, 1);
  timers.flushAll();
  const result = await resultPromise;
  assert.equal(result.waitStatus, "timeout");
  assert.equal(result.handoffGuaranteed, false);

  // 在飞 handoff 仍完成并保留 sticky（超时未取消）
  release();
  await tail;
  assert.ok(stickyFrozenHash, "failed batch must remain diagnosable after timeout");
}

// --- 重复 cleanup：同一 exclusive gate 只 flush 一次 ---
{
  let cleanupPromise: Promise<{
    waitStatus: "completed" | "timeout";
    handoffGuaranteed: boolean;
  }> | null = null;
  let flushCount = 0;
  let tail: Promise<void> = Promise.resolve();
  const outbox = makeOutbox();

  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = gateCleanupOnHandoffTail({
      flush: () => {
        flushCount += 1;
        tail = flushDialogueThroughHandoff({
          mode: "hangup",
          outbox,
          pendingDialogue: KEEP,
          handoffRetryQueue: [],
          todayLocal: TODAY,
        }).then(() => undefined);
      },
      tail: () => tail,
      timeoutMs: CLEANUP_HANDOFF_WAIT_MS,
    }).finally(() => {
      cleanupPromise = null;
    });
    return cleanupPromise;
  };

  const [a, b] = await Promise.all([cleanup(), cleanup()]);
  assert.equal(flushCount, 1);
  assert.equal(a.waitStatus, "completed");
  assert.equal(b.waitStatus, "completed");
  assert.equal(outbox.list().length, 1);
}

// --- 失败旧批 + 期间新对话：顺序稳定（merge） ---
{
  const failedSticky = (
    await flushDialogueThroughHandoff({
      mode: "hangup",
      outbox: failingOutbox(),
      pendingDialogue: KEEP,
      handoffRetryQueue: [],
      todayLocal: TODAY,
    })
  ).handoffRetryQueue;

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const arrivedDuring: typeof NEWER = [];
  const flushPromise = (async () => {
    const output = await flushDialogueThroughHandoff({
      mode: "scheduled",
      outbox: failingOutbox(),
      pendingDialogue: [],
      handoffRetryQueue: failedSticky,
      todayLocal: TODAY,
      handOff: async (input) => {
        await gate;
        return handOffDialogueBatchToOutbox(input);
      },
    });
    return mergePendingAfterFlush(output.pendingDialogue, arrivedDuring);
  })();

  arrivedDuring.push(...NEWER);
  release();
  const merged = await flushPromise;
  assert.deepEqual(merged, NEWER);

  const retry = await flushDialogueThroughHandoff({
    mode: "scheduled",
    outbox: failingOutbox(),
    pendingDialogue: merged,
    handoffRetryQueue: failedSticky,
    todayLocal: TODAY,
  });
  // 失败停后续：sticky 仍在前，NEWER 留在 pending
  assert.equal(retry.handoffRetryQueue[0]!.frozen!.batchId, failedSticky[0]!.frozen!.batchId);
  assert.deepEqual(retry.pendingDialogue, NEWER);
  assert.equal(retry.diagnostics.followUp, "failure_backoff");
}

// --- awaitHandoffTailWithTimeout 单元：完成／超时 ---
{
  assert.equal(
    await awaitHandoffTailWithTimeout(Promise.resolve(), 1_000),
    "completed",
  );

  const timers = createFakeTimers();
  const slow = new Promise<void>(() => undefined);
  const pending = awaitHandoffTailWithTimeout(slow, 10, timers);
  timers.flushAll();
  assert.equal(await pending, "timeout");
}

// =============================================================================
// 1B-3D-0C
// =============================================================================

/**
 * 镜像 RealtimeClient.enqueueHandoffFlush 的队列领取与写回（非 RC 实例）。
 */
async function runMirroredEnqueueHandoffFlush(input: {
  holder: {
    pendingDialogue: DialogueBatchTurn[];
    handoffRetryQueue: StickyHandoffBatch[];
  };
  mode: "scheduled" | "hangup";
  outbox: ConsolidationOutbox;
  todayLocal: string;
  handOff?: typeof handOffDialogueBatchToOutbox;
}): Promise<Awaited<ReturnType<typeof flushDialogueThroughHandoff>>> {
  const claimedPending = input.holder.pendingDialogue;
  input.holder.pendingDialogue = [];
  const claimedRetry = input.holder.handoffRetryQueue;
  input.holder.handoffRetryQueue = [];

  const output = await flushDialogueThroughHandoff({
    mode: input.mode,
    outbox: input.outbox,
    pendingDialogue: claimedPending,
    handoffRetryQueue: claimedRetry,
    todayLocal: input.todayLocal,
    handOff: input.handOff,
  });

  input.holder.pendingDialogue = mergePendingAfterFlush(
    output.pendingDialogue,
    input.holder.pendingDialogue,
  );
  input.holder.handoffRetryQueue = output.handoffRetryQueue;
  return output;
}

// --- 0C-1：cleanup 超时后 handoff 最终成功，outbox 持久化原批次（helper／gate 层） ---
{
  const timers = createFakeTimers();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const outbox = makeOutbox();
  let tail: Promise<void> = Promise.resolve();

  const resultPromise = gateCleanupOnHandoffTail({
    flush: () => {
      tail = (async () => {
        await gate;
        await flushDialogueThroughHandoff({
          mode: "hangup",
          outbox,
          pendingDialogue: KEEP,
          handoffRetryQueue: [],
          todayLocal: TODAY,
        });
      })();
    },
    tail: () => tail,
    timeoutMs: 50,
    timers,
  });

  timers.flushAll();
  const result = await resultPromise;
  assert.equal(result.waitStatus, "timeout");
  assert.equal(result.handoffGuaranteed, false);
  assert.equal(outbox.list().length, 0, "must not treat timeout as persist success");

  release();
  await tail;
  assert.equal(outbox.list().length, 1);
  assert.deepEqual(outbox.list()[0]!.turns.map((t) => t.text), [
    KEEP[0]!.text,
    KEEP[1]!.text,
  ]);
  assert.equal(outbox.list()[0]!.occurredOn, TODAY);
}

// --- 0C-2：超时后写回 holder（镜像 enqueueHandoffFlush；非 RC 实例） ---
{
  const timers = createFakeTimers();
  const outbox = makeOutbox();
  const holder = {
    pendingDialogue: [...KEEP] as DialogueBatchTurn[],
    handoffRetryQueue: [] as StickyHandoffBatch[],
  };

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  let tail: Promise<void> = Promise.resolve();
  const gateResultPromise = gateCleanupOnHandoffTail({
    flush: () => {
      tail = (async () => {
        await runMirroredEnqueueHandoffFlush({
          holder,
          mode: "hangup",
          outbox,
          todayLocal: TODAY,
          handOff: async (input) => {
            await gate;
            return handOffDialogueBatchToOutbox(input);
          },
        });
      })();
    },
    tail: () => tail,
    timeoutMs: 50,
    timers,
  });

  // 超时瞬间：已 claim，holder 队列应为空（与 RC 在飞窗口一致）
  timers.flushAll();
  const gateResult = await gateResultPromise;
  assert.equal(gateResult.waitStatus, "timeout");
  assert.equal(gateResult.handoffGuaranteed, false);
  assert.deepEqual(holder.pendingDialogue, []);
  assert.deepEqual(holder.handoffRetryQueue, []);
  assert.equal(outbox.list().length, 0);

  release();
  await tail;

  // handoff 完成后写回：成功 → sticky 空、pending 空、outbox 有原批
  assert.equal(holder.handoffRetryQueue.length, 0);
  assert.deepEqual(holder.pendingDialogue, []);
  assert.equal(outbox.list().length, 1);
  assert.equal(outbox.list()[0]!.occurredOn, TODAY);
  assert.equal(outbox.list()[0]!.turns[0]!.text, KEEP[0]!.text);
}

// --- 0C-2b：超时后失败写回 sticky（镜像 harness；非 RC 实例） ---
{
  const timers = createFakeTimers();
  const outbox = failingOutbox();
  const holder = {
    pendingDialogue: [...KEEP] as DialogueBatchTurn[],
    handoffRetryQueue: [] as StickyHandoffBatch[],
  };

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let tail: Promise<void> = Promise.resolve();

  const gateResultPromise = gateCleanupOnHandoffTail({
    flush: () => {
      tail = (async () => {
        await runMirroredEnqueueHandoffFlush({
          holder,
          mode: "hangup",
          outbox,
          todayLocal: TODAY,
          handOff: async (input) => {
            await gate;
            return handOffDialogueBatchToOutbox(input);
          },
        });
      })();
    },
    tail: () => tail,
    timeoutMs: 50,
    timers,
  });

  timers.flushAll();
  await gateResultPromise;
  assert.deepEqual(holder.handoffRetryQueue, []);

  release();
  await tail;

  assert.equal(holder.handoffRetryQueue.length, 1);
  assert.ok(holder.handoffRetryQueue[0]!.frozen);
  assert.equal(holder.handoffRetryQueue[0]!.frozen!.occurredOn, TODAY);
  assert.deepEqual(holder.pendingDialogue, []);
}

// --- 0C-3：scheduleExclusiveTimeout 后一次替换前一次（假时钟；RC.scheduleConsolidation seam） ---
{
  const timers = createFakeTimers();
  // 适配 scheduleExclusiveTimeout 的 number id 接口
  let nextId = 1;
  const idToEntry = new Map<number, { ms: number; fn: () => void }>();
  const exclusiveTimers = {
    setTimeout(fn: () => void, ms: number) {
      const id = nextId++;
      const entry = { ms, fn };
      idToEntry.set(id, entry);
      timers.pending.push(entry);
      return id;
    },
    clearTimeout(id: number) {
      const entry = idToEntry.get(id);
      if (!entry) return;
      idToEntry.delete(id);
      const idx = timers.pending.indexOf(entry);
      if (idx >= 0) timers.pending.splice(idx, 1);
    },
  };

  const state = { timerId: null as number | null };
  const fires: number[] = [];

  scheduleExclusiveTimeout(state, 30_000, () => fires.push(1), exclusiveTimers);
  const firstId = state.timerId;
  assert.ok(firstId !== null);
  assert.equal(timers.pending.length, 1);

  scheduleExclusiveTimeout(state, 1_000, () => fires.push(2), exclusiveTimers);
  assert.notEqual(state.timerId, firstId);
  assert.equal(timers.pending.length, 1, "replaced timer must leave exactly one pending");

  // 只触发当前 pending（第二次）
  timers.flushAll();
  assert.deepEqual(fires, [2]);
  assert.equal(state.timerId, null);
}

console.log("[consolidation-cleanup-handoff] ok");
