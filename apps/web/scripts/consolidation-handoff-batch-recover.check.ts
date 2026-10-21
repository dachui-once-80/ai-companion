/**
 * 批次级 handoff 异常边界。
 * 内存 outbox + mock fetch。不调用 connect()，不读默认 localStorage。
 */
import assert from "node:assert/strict";
import { RealtimeClient } from "../src/realtime/RealtimeClient.ts";
import {
  CONSOLIDATION_OUTBOX_STORAGE_KEY,
  ConsolidationOutbox,
  createMemoryOutboxStorage,
  type AddConsolidationOutboxInput,
  type ConsolidationOutboxItem,
} from "../src/realtime/consolidationOutbox.ts";
import type { DrainFetch } from "../src/realtime/consolidationDrain.ts";
import { computeConsolidationPayloadHash } from "../src/realtime/consolidationPayload.ts";
import { flushDialogueThroughHandoff } from "../src/realtime/consolidationFlushHandoff.ts";
import type { StickyHandoffBatch } from "../src/realtime/consolidationFlushHandoff.ts";
import { currentConsolidationTail } from "../src/realtime/consolidationDrainCoordinator.ts";

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
const PENDING_TEXT = "领取前还没交出去的话要留住";
const ARRIVED = "恢复期间刚到的一句";
const FIRST_ID = "batch-recover-0000-4000-8000-000000000001";
const SECOND_ID = "batch-recover-0000-4000-8000-000000000002";

globalThis.fetch = (() => {
  throw new Error("forbidden default fetch");
}) as typeof fetch;

const unhandled: unknown[] = [];
process.on("unhandledRejection", (reason) => {
  unhandled.push(reason);
});

(globalThis as { window?: Window }).window = {
  setTimeout() {
    return 1;
  },
  clearTimeout() {},
} as unknown as Window;

type Harness = {
  pendingDialogue: Array<{ role: "user" | "companion"; text: string }>;
  handoffRetryQueue: StickyHandoffBatch[];
  hangupHandoffBoundary: Promise<void>;
  enqueueHandoffFlush: (mode: "scheduled" | "hangup") => void;
};

function harness(client: RealtimeClient): Harness {
  return client as unknown as Harness;
}

function makeOutbox(): ConsolidationOutbox {
  return new ConsolidationOutbox({
    storage: createMemoryOutboxStorage(),
    now: () => NOW,
  });
}

function makeClient(
  outbox: ConsolidationOutbox,
  owner: string,
  flushDialogue?: typeof flushDialogueThroughHandoff,
): Harness {
  return harness(
    new RealtimeClient({
      consolidationOutbox: outbox,
      drainFetchImpl: (async () => {
        throw new Error("drain fetch blocked");
      }) as DrainFetch,
      drainNow: () => NOW,
      drainLeaseOwner: owner,
      flushDialogue,
    }),
  );
}

function sticky(
  batchId: string,
  hash: string,
  turns: Array<{ role: "user" | "companion"; text: string }>,
): StickyHandoffBatch {
  return {
    batchId,
    occurredOnRaw: OCCURRED_ON,
    turns: turns.map((turn) => ({ ...turn })),
    frozen: {
      batchId,
      occurredOn: OCCURRED_ON,
      payloadHash: hash,
      turns: turns.map((turn) => ({ ...turn })),
    },
  };
}

async function settle(client: Harness): Promise<void> {
  await client.hangupHandoffBoundary;
  await currentConsolidationTail();
  await new Promise((resolve) => setImmediate(resolve));
}

const keptHash = await computeConsolidationPayloadHash(OCCURRED_ON, KEPT);
const secondHash = await computeConsolidationPayloadHash(OCCURRED_ON, SECOND);

// 1. add 已写入，返回前抛错。读回同一 hash 后视为已持久化，不再进 pending／retry。
{
  const outbox = makeOutbox();
  const originalAdd = outbox.add.bind(outbox);
  outbox.add = (input: AddConsolidationOutboxInput): ConsolidationOutboxItem => {
    originalAdd(input);
    throw new Error("persisted then threw before return");
  };
  const client = makeClient(outbox, "batch-recover-1");
  client.pendingDialogue = KEPT.map((turn) => ({ ...turn }));
  client.enqueueHandoffFlush("hangup");
  await settle(client);

  const stored = outbox.list();
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.payloadHash, keptHash);
  assert.deepEqual(stored[0]?.turns, KEPT);
  assert.equal(stored[0]?.occurredOn, OCCURRED_ON);
  assert.deepEqual(
    client.handoffRetryQueue.map((entry) => entry.batchId),
    [],
  );
  assert.deepEqual(
    client.pendingDialogue.map((turn) => turn.text),
    [],
  );
  assert.equal(client.handoffRetryQueue.some((entry) => entry.batchId === stored[0]?.batchId), false);
}

// 2. 第一条 retry 已摘掉并写入后，下一条在写入前抛错。
{
  const outbox = makeOutbox();
  const client = makeClient(outbox, "batch-recover-2");
  client.pendingDialogue = [{ role: "user", text: PENDING_TEXT }];
  client.handoffRetryQueue = [
    sticky(FIRST_ID, keptHash, KEPT),
    {
      ...sticky(SECOND_ID, secondHash, SECOND),
      turns: [
        {
          role: "user",
          get text(): string {
            throw new Error("next retry threw before outbox");
          },
        },
        SECOND[1]!,
      ],
    },
  ];
  client.enqueueHandoffFlush("hangup");
  await settle(client);

  assert.deepEqual(
    outbox.list().map((item) => item.batchId),
    [FIRST_ID],
  );
  assert.equal(outbox.list()[0]?.payloadHash, keptHash);
  assert.deepEqual(
    client.handoffRetryQueue.map((entry) => entry.batchId),
    [SECOND_ID],
  );
  assert.equal(client.handoffRetryQueue[0]?.frozen?.batchId, SECOND_ID);
  assert.equal(client.handoffRetryQueue[0]?.frozen?.payloadHash, secondHash);
  assert.equal(client.handoffRetryQueue[0]?.frozen?.occurredOn, OCCURRED_ON);
  assert.deepEqual(client.handoffRetryQueue[0]?.frozen?.turns, SECOND);
  assert.deepEqual(
    client.pendingDialogue.map((turn) => turn.text),
    [PENDING_TEXT],
  );
}

// 3. 已写入的 retry 之后，pending 恢复函数抛错。已写入身份不回队列；未写入的 pending 仍在。
{
  const outbox = makeOutbox();
  let restoreThrows = 0;
  const output = await flushDialogueThroughHandoff({
    mode: "hangup",
    outbox,
    todayLocal: OCCURRED_ON,
    pendingDialogue: [
      {
        role: "user",
        get text(): string {
          throw new Error("pending read failed before outbox");
        },
      },
      { role: "companion", text: "好，记下了" },
    ],
    handoffRetryQueue: [sticky(FIRST_ID, keptHash, KEPT)],
    restoreDetached() {
      restoreThrows += 1;
      throw new Error("restore itself failed");
    },
  });

  assert.equal(restoreThrows > 0, true);
  assert.deepEqual(
    outbox.list().map((item) => item.batchId),
    [FIRST_ID],
  );
  assert.equal(outbox.list()[0]?.payloadHash, keptHash);
  assert.deepEqual(outbox.list()[0]?.turns, KEPT);
  assert.deepEqual(
    output.handoffRetryQueue.map((entry) => entry.batchId),
    [],
  );
  assert.equal(output.pendingDialogue.length, 2);
  assert.equal(output.pendingDialogue[0]?.role, "user");
  assert.equal(output.pendingDialogue[1]?.text, "好，记下了");
}

// 4. flush 在写入一条 retry 后拒绝返回。新对话保留，已持久化身份不回 pending。
{
  const outbox = makeOutbox();
  let pushed = false;
  const client = makeClient(outbox, "batch-recover-4", async (input) => {
    void input.pendingDialogue[0]?.text;
    const retry = input.ledger?.records.find((record) => record.source === "retry");
    const frozen = retry?.sticky?.frozen;
    if (!retry || !frozen) throw new Error("ledger missing frozen retry");
    input.outbox.add({
      batchId: frozen.batchId,
      payloadHash: frozen.payloadHash,
      occurredOn: frozen.occurredOn,
      turns: frozen.turns,
      status: "pending",
    });
    retry.phase = "persisted";
    retry.batchId = frozen.batchId;
    throw new Error("flush aborted after persist");
  });
  client.handoffRetryQueue = [sticky(FIRST_ID, keptHash, KEPT)];
  client.pendingDialogue = [
    {
      role: "user",
      get text(): string {
        if (!pushed) {
          pushed = true;
          client.pendingDialogue.push({ role: "companion", text: ARRIVED });
        }
        return PENDING_TEXT;
      },
    },
  ];
  client.enqueueHandoffFlush("hangup");
  await settle(client);

  assert.equal(pushed, true);
  assert.deepEqual(
    outbox.list().map((item) => item.batchId),
    [FIRST_ID],
  );
  assert.equal(outbox.list()[0]?.payloadHash, keptHash);
  assert.deepEqual(
    client.handoffRetryQueue.map((entry) => entry.batchId),
    [],
  );
  assert.deepEqual(
    client.pendingDialogue.map((turn) => turn.text),
    [PENDING_TEXT, ARRIVED],
  );
}

// 5. add 已写入但读回失败：保留原 frozen，不生成新 batchId。
{
  const outbox = makeOutbox();
  const originalAdd = outbox.add.bind(outbox);
  const originalGet = outbox.get.bind(outbox);
  let reads = 0;
  outbox.get = (batchId: string): ConsolidationOutboxItem | null => {
    reads += 1;
    if (reads === 1) return originalGet(batchId);
    throw new Error("outbox readback failed");
  };
  outbox.add = (input: AddConsolidationOutboxInput): ConsolidationOutboxItem => {
    originalAdd(input);
    throw new Error("persisted then threw and readback failed");
  };
  const client = makeClient(outbox, "batch-recover-5");
  client.handoffRetryQueue = [sticky(FIRST_ID, keptHash, KEPT)];
  client.enqueueHandoffFlush("hangup");
  await settle(client);

  assert.deepEqual(
    outbox.list().map((item) => item.batchId),
    [FIRST_ID],
  );
  assert.equal(outbox.list()[0]?.payloadHash, keptHash);
  assert.deepEqual(
    client.handoffRetryQueue.map((entry) => entry.batchId),
    [FIRST_ID],
  );
  assert.equal(client.handoffRetryQueue.length, 1);
  assert.equal(client.handoffRetryQueue[0]?.frozen?.batchId, FIRST_ID);
  assert.equal(client.handoffRetryQueue[0]?.frozen?.payloadHash, keptHash);
  assert.equal(client.handoffRetryQueue[0]?.frozen?.occurredOn, OCCURRED_ON);
  assert.deepEqual(client.handoffRetryQueue[0]?.frozen?.turns, KEPT);
  assert.deepEqual(
    client.pendingDialogue.map((turn) => turn.text),
    [],
  );
}

// 6. 播种在第二条 retry 展开时抛错。未登记的 retry 和 pending 仍在，新对话接在后面。
{
  const outbox = makeOutbox();
  const client = makeClient(outbox, "batch-recover-seed");
  let pushed = false;
  const secondTurns = [
    { role: "user" as const, text: SECOND[0]!.text },
    SECOND[1]!,
  ];
  Object.defineProperty(secondTurns, Symbol.iterator, {
    value() {
      if (!pushed) {
        pushed = true;
        client.pendingDialogue.push({ role: "companion", text: ARRIVED });
      }
      throw new Error("seed copy failed");
    },
  });
  client.handoffRetryQueue = [
    sticky(FIRST_ID, keptHash, KEPT),
    {
      ...sticky(SECOND_ID, secondHash, SECOND),
      turns: secondTurns,
    },
  ];
  client.pendingDialogue = [{ role: "user", text: PENDING_TEXT }];
  client.enqueueHandoffFlush("hangup");
  await settle(client);

  assert.equal(pushed, true);
  assert.deepEqual(
    outbox.list().map((item) => item.batchId),
    [],
  );
  assert.deepEqual(
    client.handoffRetryQueue.map((entry) => entry.batchId),
    [FIRST_ID, SECOND_ID],
  );
  assert.equal(client.handoffRetryQueue[0]?.frozen?.batchId, FIRST_ID);
  assert.equal(client.handoffRetryQueue[0]?.frozen?.payloadHash, keptHash);
  assert.equal(client.handoffRetryQueue[1]?.frozen?.batchId, SECOND_ID);
  assert.equal(client.handoffRetryQueue[1]?.frozen?.payloadHash, secondHash);
  assert.equal(client.handoffRetryQueue[1]?.frozen?.occurredOn, OCCURRED_ON);
  assert.deepEqual(client.handoffRetryQueue[1]?.frozen?.turns, SECOND);
  assert.deepEqual(
    client.pendingDialogue.map((turn) => turn.text),
    [PENDING_TEXT, ARRIVED],
  );
}

// 7. add() 调用前读取抛错：不是 uncertain，原 frozen 仍在 retry。
{
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((part) => String(part)).join(" "));
    originalWarn(...args);
  };

  try {
    const outbox = makeOutbox();
    const client = makeClient(outbox, "batch-recover-before-add");
    client.pendingDialogue = [{ role: "user", text: PENDING_TEXT }];
    client.handoffRetryQueue = [
      {
        ...sticky(FIRST_ID, keptHash, KEPT),
        turns: [
          {
            role: "user",
            get text(): string {
              throw new Error("read before add");
            },
          },
          KEPT[1]!,
        ],
      },
    ];
    client.enqueueHandoffFlush("hangup");
    await settle(client);

    assert.deepEqual(
      outbox.list().map((item) => item.batchId),
      [],
    );
    assert.deepEqual(
      client.handoffRetryQueue.map((entry) => entry.batchId),
      [FIRST_ID],
    );
    assert.equal(client.handoffRetryQueue.length, 1);
    assert.equal(client.handoffRetryQueue[0]?.frozen?.batchId, FIRST_ID);
    assert.equal(client.handoffRetryQueue[0]?.frozen?.occurredOn, OCCURRED_ON);
    assert.equal(client.handoffRetryQueue[0]?.frozen?.payloadHash, keptHash);
    assert.deepEqual(client.handoffRetryQueue[0]?.frozen?.turns, KEPT);
    assert.deepEqual(
      client.pendingDialogue.map((turn) => turn.text),
      [PENDING_TEXT],
    );
    assert.equal(
      warnings.some((line) => line.includes("uncertain")),
      false,
    );
    assert.equal(
      warnings.some((line) =>
        line.includes("consolidation handoff failed; batch retained for retry"),
      ),
      true,
    );
  } finally {
    console.warn = originalWarn;
  }
}

// 8. add 已写入后，按原 batchId 读回的 hash 不同：明确失败，不盖掉那份内容。
{
  const OTHER_HASH = "b".repeat(64);
  const OTHER_TURNS = [{ role: "user" as const, text: "这是另一份不能被盖掉的内容" }];
  const storage = createMemoryOutboxStorage();
  const outbox = new ConsolidationOutbox({
    storage,
    now: () => NOW,
  });
  const originalAdd = outbox.add.bind(outbox);
  outbox.add = (input: AddConsolidationOutboxInput): ConsolidationOutboxItem => {
    originalAdd(input);
    const raw = storage.store.get(CONSOLIDATION_OUTBOX_STORAGE_KEY);
    const envelope = JSON.parse(raw ?? "{}") as {
      items?: Array<{ payloadHash?: string; turns?: unknown }>;
    };
    const storedItem = envelope.items?.[0];
    if (!storedItem) throw new Error("add did not persist");
    storedItem.payloadHash = OTHER_HASH;
    storedItem.turns = OTHER_TURNS.map((turn) => ({ ...turn }));
    storage.store.set(CONSOLIDATION_OUTBOX_STORAGE_KEY, JSON.stringify(envelope));
    throw new Error("readback hash diverged after persist");
  };
  const output = await flushDialogueThroughHandoff({
    mode: "hangup",
    outbox,
    todayLocal: OCCURRED_ON,
    pendingDialogue: [{ role: "user", text: PENDING_TEXT }],
    handoffRetryQueue: [sticky(FIRST_ID, keptHash, KEPT)],
  });

  assert.equal(output.diagnostics.attempts[0]?.resultKind, "failed");
  assert.notEqual(output.diagnostics.attempts[0]?.resultKind, "persisted");
  assert.equal(output.diagnostics.attempts[0]?.batchId, FIRST_ID);
  assert.deepEqual(
    output.handoffRetryQueue.map((entry) => entry.batchId),
    [FIRST_ID],
  );
  assert.equal(output.handoffRetryQueue.length, 1);
  assert.equal(output.handoffRetryQueue[0]?.frozen?.batchId, FIRST_ID);
  assert.equal(output.handoffRetryQueue[0]?.frozen?.occurredOn, OCCURRED_ON);
  assert.equal(output.handoffRetryQueue[0]?.frozen?.payloadHash, keptHash);
  assert.deepEqual(output.handoffRetryQueue[0]?.frozen?.turns, KEPT);
  assert.deepEqual(
    output.pendingDialogue.map((turn) => turn.text),
    [PENDING_TEXT],
  );
  const stored = outbox.list();
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.batchId, FIRST_ID);
  assert.equal(stored[0]?.payloadHash, OTHER_HASH);
  assert.deepEqual(stored[0]?.turns, OTHER_TURNS);
  assert.equal(
    output.handoffRetryQueue.some((entry) => entry.batchId !== FIRST_ID),
    false,
  );
}

// 9. 恢复先放回第一句，后续步骤再抛错。已放回的内容不重复，后一句不丢。
{
  const outbox = makeOutbox();
  const output = await flushDialogueThroughHandoff({
    mode: "scheduled",
    outbox,
    todayLocal: OCCURRED_ON,
    pendingDialogue: [
      { role: "user", text: "嗯" },
      { role: "companion", text: "后一句还没放回去" },
    ],
    handoffRetryQueue: [sticky(SECOND_ID, secondHash, SECOND)],
    restoreDetached(pending, detached) {
      if (pending.length === 0 && detached[0]) {
        pending.push(detached[0]);
      }
      throw new Error("restore later step failed");
    },
  });

  assert.deepEqual(
    outbox.list().map((item) => item.batchId),
    [SECOND_ID],
  );
  assert.equal(outbox.list()[0]?.payloadHash, secondHash);
  assert.deepEqual(outbox.list()[0]?.turns, SECOND);
  assert.deepEqual(
    output.handoffRetryQueue.map((entry) => entry.batchId),
    [],
  );
  assert.deepEqual(
    output.pendingDialogue.map((turn) => turn.text),
    ["嗯", "后一句还没放回去"],
  );
}

assert.equal(unhandled.length, 0);
console.log("[consolidation-handoff-batch-recover] ok");
