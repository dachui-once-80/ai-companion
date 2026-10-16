/**
 * mentionDue / cueDue 等待的取消辅助（可离线测试）。
 * 取消一律以 heard=false 结束，不得报告 true。
 */

export type DueWaitSlots = {
  timer: number | null;
  resolve: ((heard: boolean) => void) | null;
};

/**
 * 结束一次 due 等待：清计时器并以给定结果 resolve。
 * 可重复调用；无等待时为 no-op。
 */
export function finishDueWaitSlots(
  slots: DueWaitSlots,
  heard: boolean,
  clearTimer: (id: number) => void,
): DueWaitSlots {
  if (slots.timer !== null) {
    clearTimer(slots.timer);
  }

  const resolve = slots.resolve;
  slots.timer = null;
  slots.resolve = null;
  resolve?.(heard);

  return slots;
}

/** 连接清理 / 主动取消：一律未听到。 */
export function cancelDueWaitSlots(
  slots: DueWaitSlots,
  clearTimer: (id: number) => void,
): DueWaitSlots {
  return finishDueWaitSlots(slots, false, clearTimer);
}
