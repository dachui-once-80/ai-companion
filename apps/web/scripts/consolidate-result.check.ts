import assert from "node:assert/strict";
import {
  applyConsolidationEnqueueFailure,
  classifyConsolidationHttp,
  CONSOLIDATION_SAVED_KEYS,
  ConsolidationDeferred,
  ConsolidationPermanentError,
  isConsolidationSuccessBody,
  parkPermanentConsolidationBatch,
  readRetryAfterMs,
  releasePausedConsolidationBatches,
  summarizeConsolidationSaved,
} from "../src/realtime/consolidateResult.ts";

const emptySaved = Object.fromEntries(
  CONSOLIDATION_SAVED_KEYS.map((key) => [key, 0]),
) as Record<(typeof CONSOLIDATION_SAVED_KEYS)[number], number>;

const sampleBatch = [
  { role: "user" as const, text: "我叫阿远" },
  { role: "companion" as const, text: "好的" },
];

// --- HTTP 400：永久失败 ---
{
  const outcome = classifyConsolidationHttp(400, false, {
    error: "turns are required",
  });
  assert.equal(outcome.kind, "permanent");
  assert.equal(outcome.kind === "permanent" && outcome.status, 400);
}

// --- 401 / 403：可重试（短暂鉴权）---
{
  assert.equal(classifyConsolidationHttp(401, false, undefined).kind, "retryable");
  assert.equal(classifyConsolidationHttp(403, false, undefined).kind, "retryable");
}

// --- 合法 200 全零 saved：终态成功 ---
{
  const body = { saved: emptySaved };
  assert.equal(isConsolidationSuccessBody(body), true);
  const outcome = classifyConsolidationHttp(200, true, body);
  assert.equal(outcome.kind, "success");
  if (outcome.kind === "success") {
    assert.equal(outcome.saved.total, 0);
    assert.equal(outcome.saved.open, false);
  }
}

// --- 200 + 有写入 ---
{
  const body = {
    saved: { ...emptySaved, episodes: 2, views: 1, unresolved: 1 },
  };
  const outcome = classifyConsolidationHttp(200, true, body);
  assert.equal(outcome.kind, "success");
  if (outcome.kind === "success") {
    assert.equal(outcome.saved.total, 3);
    assert.equal(outcome.saved.open, true);
  }
}

// --- 200 + retryAfterMs：deferred ---
{
  const body = { saved: emptySaved, retryAfterMs: 60_000 };
  assert.equal(readRetryAfterMs(body), 60_000);
  const outcome = classifyConsolidationHttp(200, true, body);
  assert.equal(outcome.kind, "deferred");
}

// --- 5xx / 429 / 408：可重试 ---
{
  assert.equal(classifyConsolidationHttp(502, false, { error: "x" }).kind, "retryable");
  assert.equal(classifyConsolidationHttp(429, false, undefined).kind, "retryable");
  assert.equal(classifyConsolidationHttp(408, false, undefined).kind, "retryable");
}

// --- 404 / 422 仍永久 ---
{
  assert.equal(classifyConsolidationHttp(404, false, undefined).kind, "permanent");
  assert.equal(classifyConsolidationHttp(422, false, undefined).kind, "permanent");
}

// --- 畸形成功体：不得 success ---
{
  assert.equal(isConsolidationSuccessBody({}), false);
  assert.equal(isConsolidationSuccessBody({ saved: {} }), false);
  assert.equal(summarizeConsolidationSaved({ saved: {} }), null);
  assert.equal(
    classifyConsolidationHttp(200, true, { saved: {} }).kind,
    "retryable",
  );

  const missingField = { saved: { ...emptySaved } };
  delete (missingField.saved as { episodes?: number }).episodes;
  assert.equal(isConsolidationSuccessBody(missingField), false);
  assert.equal(
    classifyConsolidationHttp(200, true, missingField).kind,
    "retryable",
  );

  const badType = {
    saved: { ...emptySaved, notes: "1" as unknown as number },
  };
  assert.equal(isConsolidationSuccessBody(badType), false);

  assert.equal(classifyConsolidationHttp(200, true, undefined).kind, "retryable");
  assert.equal(
    classifyConsolidationHttp(200, true, { saved: "nope" }).kind,
    "retryable",
  );
}

// --- 永久失败：批次进入 paused，不回塞 pending，不产生调度动作 ---
{
  const newer = [{ role: "user" as const, text: "新来的一句" }];
  const next = applyConsolidationEnqueueFailure({
    batch: sampleBatch,
    error: new ConsolidationPermanentError(400, "rejected"),
    pendingDialogue: newer,
    pausedBatches: [],
  });

  assert.equal(next.action, "park");
  assert.deepEqual(next.pendingDialogue, newer);
  assert.equal(next.pausedBatches.length, 1);
  assert.deepEqual(next.pausedBatches[0], sampleBatch);
  assert.equal(next.retryAfterMs, undefined);
}

// --- 暂停批不会被「只 flush pending」路径选中 ---
{
  const pending = [{ role: "user" as const, text: "待整理" }];
  const paused = parkPermanentConsolidationBatch([], sampleBatch);
  // 普通 flush 只 splice pending；paused 仍独立
  const flushBatch = pending.splice(0);
  assert.deepEqual(flushBatch, [{ role: "user", text: "待整理" }]);
  assert.equal(pending.length, 0);
  assert.equal(paused.length, 1);
  assert.deepEqual(paused[0], sampleBatch);
}

// --- 可重试：回塞 pending 头部，保留新到达 ---
{
  const newer = [{ role: "user" as const, text: "后来的" }];
  const next = applyConsolidationEnqueueFailure({
    batch: sampleBatch,
    error: new Error("consolidation failed: 502"),
    pendingDialogue: newer,
    pausedBatches: [],
  });
  assert.equal(next.action, "restore_backoff");
  assert.deepEqual(next.pendingDialogue, [...sampleBatch, ...newer]);
  assert.equal(next.pausedBatches.length, 0);
}

// --- deferred：回塞并带 retryAfterMs ---
{
  const next = applyConsolidationEnqueueFailure({
    batch: sampleBatch,
    error: new ConsolidationDeferred(45_000),
    pendingDialogue: [],
    pausedBatches: [],
  });
  assert.equal(next.action, "restore_deferred");
  assert.equal(next.retryAfterMs, 45_000);
  assert.deepEqual(next.pendingDialogue, sampleBatch);
}

// --- 显式 release 才把 paused 送回 pending（本阶段不自动调用）---
{
  const released = releasePausedConsolidationBatches({
    pendingDialogue: [{ role: "user", text: "新" }],
    pausedBatches: [sampleBatch],
  });
  assert.equal(released.releasedBatchCount, 1);
  assert.equal(released.pausedBatches.length, 0);
  assert.equal(released.pendingDialogue[0]?.text, "我叫阿远");
  assert.equal(released.pendingDialogue.at(-1)?.text, "新");
}

console.log("consolidate-result.check: ok");
