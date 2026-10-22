/**
 * 本次 P1-C 批次的写入与按 id 删除。只移除本次 batchId。
 */

import {
  CONSOLIDATION_OUTBOX_STORAGE_KEY,
  ConsolidationOutbox,
  createMemoryOutboxStorage,
  type ConsolidationOutboxItem,
} from "../../src/realtime/consolidationOutbox.ts";
import {
  computeConsolidationPayloadHash,
  type ConsolidationPayloadTurn,
} from "../../src/realtime/consolidationPayload.ts";

export type P1cBatchKind = "ok" | "net";

export type P1cSeed = {
  batchId: string;
  payloadHash: string;
  occurredOn: string;
  turns: ConsolidationPayloadTurn[];
  raw: string;
};

type PageStorage = {
  evaluate<T, A>(pageFunction: (arg: A) => T, arg: A): Promise<T>;
};

export function p1cBatchPrefix(kind: P1cBatchKind): "p1c-ok-" | "p1c-net-" {
  return kind === "ok" ? "p1c-ok-" : "p1c-net-";
}

export function assertP1cBatchId(batchId: string): void {
  if (!batchId.startsWith("p1c-ok-") && !batchId.startsWith("p1c-net-")) {
    throw new Error(`refusing to clean a batch outside this run: ${batchId}`);
  }
}

export async function seedP1cBatch(input: {
  kind: P1cBatchKind;
  stamp: string;
  nowIso: string;
}): Promise<P1cSeed> {
  const occurredOn = "2026-10-21";
  const turns: ConsolidationPayloadTurn[] = [
    { role: "user", text: `p1c ${input.kind} startup drain probe` },
    { role: "companion", text: "p1c isolated profile only" },
  ];
  const batchId = `${p1cBatchPrefix(input.kind)}${input.stamp}-0001`;
  const payloadHash = await computeConsolidationPayloadHash(occurredOn, turns);
  const storage = createMemoryOutboxStorage();
  const outbox = new ConsolidationOutbox({
    storage,
    now: () => input.nowIso,
  });

  outbox.add({
    batchId,
    payloadHash,
    occurredOn,
    turns,
    status: "pending",
    nextAttemptAt: input.nowIso,
  });

  const raw = storage.getItem(CONSOLIDATION_OUTBOX_STORAGE_KEY);

  if (!raw) throw new Error("P1-C seed did not persist");

  return { batchId, payloadHash, occurredOn, turns, raw };
}

export async function seedP1cSuccessPair(input: {
  stamp: string;
  nowIso: string;
}): Promise<{ target: P1cSeed; sentinel: P1cSeed; raw: string }> {
  const occurredOn = "2026-10-21";
  const targetTurns: ConsolidationPayloadTurn[] = [
    { role: "user", text: "p1c ok startup drain probe" },
    { role: "companion", text: "p1c isolated profile only" },
  ];
  const sentinelTurns: ConsolidationPayloadTurn[] = [
    { role: "user", text: "p1c ok sentinel" },
    { role: "companion", text: "p1c held batch" },
  ];
  const targetId = `p1c-ok-${input.stamp}-0001`;
  const sentinelId = `p1c-ok-${input.stamp}-0002`;
  const targetHash = await computeConsolidationPayloadHash(occurredOn, targetTurns);
  const sentinelHash = await computeConsolidationPayloadHash(occurredOn, sentinelTurns);
  const storage = createMemoryOutboxStorage();
  const outbox = new ConsolidationOutbox({
    storage,
    now: () => input.nowIso,
  });

  outbox.add({
    batchId: targetId,
    payloadHash: targetHash,
    occurredOn,
    turns: targetTurns,
    status: "pending",
    nextAttemptAt: input.nowIso,
  });
  outbox.add({
    batchId: sentinelId,
    payloadHash: sentinelHash,
    occurredOn,
    turns: sentinelTurns,
    status: "pending",
    nextAttemptAt: "2099-01-01T00:00:00.000Z",
  });

  const raw = storage.getItem(CONSOLIDATION_OUTBOX_STORAGE_KEY);

  if (!raw) throw new Error("P1-C seed did not persist");

  return {
    target: {
      batchId: targetId,
      payloadHash: targetHash,
      occurredOn,
      turns: targetTurns,
      raw,
    },
    sentinel: {
      batchId: sentinelId,
      payloadHash: sentinelHash,
      occurredOn,
      turns: sentinelTurns,
      raw,
    },
    raw,
  };
}

export type P1cCleanupPlan =
  | { action: "unchanged" }
  | { action: "remove-key" }
  | { action: "write"; raw: string };

export function planP1cBatchCleanup(raw: string | null, batchId: string, nowIso: string): P1cCleanupPlan {
  assertP1cBatchId(batchId);

  if (!raw) return { action: "unchanged" };

  const storage = createMemoryOutboxStorage({
    [CONSOLIDATION_OUTBOX_STORAGE_KEY]: raw,
  });
  const outbox = new ConsolidationOutbox({
    storage,
    now: () => nowIso,
  });
  const current = outbox.get(batchId);

  if (!current) return { action: "unchanged" };

  outbox.remove(batchId);

  if (outbox.list().length === 0) return { action: "remove-key" };

  const next = storage.getItem(CONSOLIDATION_OUTBOX_STORAGE_KEY);

  if (!next) return { action: "remove-key" };

  return { action: "write", raw: next };
}

export async function cleanupP1cBatchOnPage(
  page: PageStorage,
  batchId: string,
): Promise<void> {
  assertP1cBatchId(batchId);

  const raw = await page.evaluate(
    (key: string) => localStorage.getItem(key),
    CONSOLIDATION_OUTBOX_STORAGE_KEY,
  );
  const plan = planP1cBatchCleanup(raw, batchId, new Date().toISOString());

  if (plan.action === "unchanged") return;

  await page.evaluate(
    (arg: { key: string; removeKey: boolean; raw: string | null }) => {
      if (arg.removeKey) localStorage.removeItem(arg.key);
      else if (arg.raw !== null) localStorage.setItem(arg.key, arg.raw);
    },
    {
      key: CONSOLIDATION_OUTBOX_STORAGE_KEY,
      removeKey: plan.action === "remove-key",
      raw: plan.action === "write" ? plan.raw : null,
    },
  );
}

export function readP1cBatch(raw: string | null, batchId: string): ConsolidationOutboxItem | null {
  if (!raw) return null;

  const outbox = new ConsolidationOutbox({
    storage: createMemoryOutboxStorage({
      [CONSOLIDATION_OUTBOX_STORAGE_KEY]: raw,
    }),
    now: () => new Date().toISOString(),
  });

  return outbox.get(batchId);
}

export { CONSOLIDATION_OUTBOX_STORAGE_KEY };
