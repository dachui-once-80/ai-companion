import assert from "node:assert/strict";
import {
  cancelDueWaitSlots,
  finishDueWaitSlots,
} from "../src/realtime/dueWait.ts";

// --- 正常结束 heard=true ---
{
  const cleared: number[] = [];
  let result: boolean | null = null;
  const slots = {
    timer: 7,
    resolve: (heard: boolean) => {
      result = heard;
    },
  };

  finishDueWaitSlots(slots, true, (id) => {
    cleared.push(id);
  });

  assert.deepEqual(cleared, [7]);
  assert.equal(result, true);
  assert.equal(slots.timer, null);
  assert.equal(slots.resolve, null);
}

// --- 取消：一律 heard=false，清计时器 ---
{
  const cleared: number[] = [];
  let result: boolean | null = null;
  const slots = {
    timer: 9,
    resolve: (heard: boolean) => {
      result = heard;
    },
  };

  cancelDueWaitSlots(slots, (id) => {
    cleared.push(id);
  });

  assert.deepEqual(cleared, [9]);
  assert.equal(result, false);
  assert.equal(slots.timer, null);
  assert.equal(slots.resolve, null);
}

// --- 重复 cancel / finish 不抛错、不二次 resolve ---
{
  let calls = 0;
  const slots = {
    timer: null as number | null,
    resolve: ((heard: boolean) => {
      calls += 1;
      assert.equal(heard, false);
    }) as ((heard: boolean) => void) | null,
  };

  cancelDueWaitSlots(slots, () => undefined);
  assert.equal(calls, 1);

  cancelDueWaitSlots(slots, () => undefined);
  finishDueWaitSlots(slots, true, () => undefined);
  assert.equal(calls, 1);
}

// --- 取消不得变成 heard=true（即使误传 finish true 在 cancel 路径不会发生）---
{
  let result = true;
  const slots = {
    timer: 1,
    resolve: (heard: boolean) => {
      result = heard;
    },
  };
  cancelDueWaitSlots(slots, () => undefined);
  assert.equal(result, false);
}

console.log("[due-wait] cancel ends wait without heard=true ok");
