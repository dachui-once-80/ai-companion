import assert from "node:assert/strict";
import {
  classifySettleHttpResult,
  DEFERRED_BACKOFF_MS,
  markDeferredBackoff,
  MAX_SETTLE_ATTEMPTS,
  nextPendingAfterUncertain,
  planReminderBatch,
  resolveAfterMentionDue,
  resolveMentionDueThrow,
} from "../src/reminderClient.ts";

const empty = {
  spoken: new Set<string>(),
  handled: new Set<string>(),
  inFlight: new Set<string>(),
  pendingSettleIds: new Set<string>(),
};

// --- 成功交付后标 handled，不会再进入 toSpeak ---
{
  const first = planReminderBatch({
    ...empty,
    reminders: [
      {
        id: "a",
        line: "交报告的时间到了。",
        delivery: "speak",
        claimedAt: "t1",
      },
    ],
  });
  assert.deepEqual(first.toSpeak, [
    { id: "a", line: "交报告的时间到了。", claimedAt: "t1" },
  ]);
  assert.deepEqual(first.releaseDeferred, []);

  const afterOk = resolveAfterMentionDue({
    ids: ["a"],
    heard: true,
    settleSucceeded: new Set(["a"]),
  });
  assert.deepEqual(afterOk.markHandled, ["a"]);
  assert.deepEqual(afterOk.markSpoken, ["a"]);
  assert.deepEqual(afterOk.pendingSettle, []);

  const second = planReminderBatch({
    reminders: [
      { id: "a", line: "交报告的时间到了。", delivery: "speak" },
    ],
    spoken: new Set(afterOk.markSpoken),
    handled: new Set(afterOk.markHandled),
    inFlight: new Set(),
    pendingSettleIds: new Set(),
  });
  assert.deepEqual(second.toSpeak, []);
  assert.deepEqual(second.settleSpoken, ["a"]);
}

// --- heard=true 但 settle 不确定：spoken + pending，不重播 ---
{
  const uncertain = resolveAfterMentionDue({
    ids: ["b"],
    heard: true,
    settleSucceeded: new Set(),
    claimedAtById: new Map([["b", "claim-b"]]),
  });
  assert.deepEqual(uncertain.markSpoken, ["b"]);
  assert.deepEqual(uncertain.markHandled, []);
  assert.deepEqual(uncertain.pendingSettle, [
    { id: "b", heard: true, claimedAt: "claim-b" },
  ]);

  const noRespeak = planReminderBatch({
    reminders: [{ id: "b", line: "开会了。", delivery: "speak" }],
    spoken: new Set(["b"]),
    handled: new Set(),
    inFlight: new Set(),
    pendingSettleIds: new Set(["b"]),
  });
  assert.deepEqual(noRespeak.toSpeak, []);
  // pending 通道补记时，不再走 settleSpoken，避免双通道。
  assert.deepEqual(noRespeak.settleSpoken, []);
}

// --- mentionDue 抛错：必须 pendingSettle(heard=false)，立刻可释放 ---
{
  const thrown = resolveMentionDueThrow(
    ["c"],
    new Map([["c", "claim-c"]]),
  );
  assert.deepEqual(thrown.markHandled, []);
  assert.deepEqual(thrown.pendingSettle, [
    { id: "c", heard: false, claimedAt: "claim-c" },
  ]);
}

// --- stale：不挂 pending，避免旧领取者完成新租约 ---
{
  const stale = resolveAfterMentionDue({
    ids: ["d"],
    heard: true,
    settleSucceeded: new Set(),
    settleStale: new Set(["d"]),
  });
  assert.deepEqual(stale.pendingSettle, []);
  assert.deepEqual(stale.markHandled, []);
}

// --- deferred：不 handled、不 pending ---
{
  const deferred = resolveAfterMentionDue({
    ids: ["e"],
    heard: false,
    settleSucceeded: new Set(),
    settleDeferred: new Set(["e"]),
  });
  assert.deepEqual(deferred.markHandled, []);
  assert.deepEqual(deferred.pendingSettle, []);
}

// --- 并发：inFlight / pendingSettle 阻止重复插入 ---
{
  const plan = planReminderBatch({
    reminders: [
      { id: "f", line: "重复。", delivery: "speak" },
      { id: "g", line: "另一条。", delivery: "speak" },
    ],
    spoken: new Set(),
    handled: new Set(),
    inFlight: new Set(["f"]),
    pendingSettleIds: new Set(["g"]),
  });
  assert.deepEqual(plan.toSpeak, []);
}

// --- spoken + pending：不双通道 settleSpoken ---
{
  const plan = planReminderBatch({
    reminders: [{ id: "h", line: "已说待确认。", delivery: "speak" }],
    spoken: new Set(["h"]),
    handled: new Set(),
    inFlight: new Set(),
    pendingSettleIds: new Set(["h"]),
  });
  assert.deepEqual(plan.settleSpoken, []);
  assert.deepEqual(plan.toSpeak, []);
}

// --- settle 有界重试：耗尽后不再 settleSpoken，仍不重播 ---
{
  let item = { id: "i", heard: true as const, claimedAt: "c-i" };
  for (let n = 0; n < MAX_SETTLE_ATTEMPTS - 1; n += 1) {
    const next = nextPendingAfterUncertain(item);
    assert.ok(next);
    item = next;
  }
  assert.equal(nextPendingAfterUncertain(item), null);

  const plan = planReminderBatch({
    reminders: [{ id: "i", line: "放弃补记。", delivery: "speak" }],
    spoken: new Set(["i"]),
    handled: new Set(),
    inFlight: new Set(),
    pendingSettleIds: new Set(),
    settleGaveUp: new Set(["i"]),
  });
  assert.deepEqual(plan.toSpeak, []);
  assert.deepEqual(plan.settleSpoken, []);
}

// --- deferred 退避：约 5s 轮询内不进 toSpeak，只 releaseDeferred ---
{
  const until = new Map<string, number>();
  const t0 = 1_000_000;
  markDeferredBackoff(until, "j", t0, DEFERRED_BACKOFF_MS);
  assert.equal(until.get("j"), t0 + DEFERRED_BACKOFF_MS);

  const during = planReminderBatch({
    ...empty,
    reminders: [
      {
        id: "j",
        line: "退避中。",
        delivery: "speak",
        claimedAt: "claim-j",
      },
    ],
    deferredUntil: until,
    nowMs: t0 + 5_000,
  });
  assert.deepEqual(during.toSpeak, []);
  assert.deepEqual(during.releaseDeferred, [
    { id: "j", line: "退避中。", claimedAt: "claim-j" },
  ]);

  const after = planReminderBatch({
    ...empty,
    reminders: [
      {
        id: "j",
        line: "退避中。",
        delivery: "speak",
        claimedAt: "claim-j2",
      },
    ],
    deferredUntil: until,
    nowMs: t0 + DEFERRED_BACKOFF_MS,
  });
  assert.deepEqual(after.releaseDeferred, []);
  assert.deepEqual(after.toSpeak, [
    { id: "j", line: "退避中。", claimedAt: "claim-j2" },
  ]);
}

// --- classifySettleHttpResult ---
{
  assert.equal(
    classifySettleHttpResult({ ok: true, status: 200 }),
    "ok",
  );
  assert.equal(
    classifySettleHttpResult({ ok: true, status: 200, deferred: true }),
    "deferred",
  );
  assert.equal(
    classifySettleHttpResult({ ok: false, status: 409, stale: true }),
    "stale",
  );
  assert.equal(
    classifySettleHttpResult({ ok: false, status: 500 }),
    "uncertain",
  );
  assert.equal(
    classifySettleHttpResult({ ok: false, status: 0 }),
    "uncertain",
  );
}

console.log("[reminder-client] D1 settle/throw/stale/classify ok");
