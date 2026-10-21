/**
 * 同一页面内 handoff 与 drain 共用的串行队列。
 * 不创建 RealtimeClient，不读取 localStorage。
 * 跨标签页没有原子 CAS；各标签各自一条队列。
 *
 * 单飞仍在各 RealtimeClient 实例上：同一实例的重复 drain 返回同一 Promise。
 * 不同入口（启动恢复、handoff 后、Live 接管后）各自把 drain 接到这条 tail 后面，
 * 因此不会并行改 outbox，也不会丢掉后写入的批次。
 */

import type { DrainConsolidationResult } from "./consolidationDrain.ts";

let tail: Promise<void> = Promise.resolve();
let drainDepth = 0;

export function currentConsolidationTail(): Promise<void> {
  return tail;
}

/** 是否已有 drain 排在共享队列上或正在执行。 */
export function consolidationDrainInFlight(): boolean {
  return drainDepth > 0;
}

/**
 * 把任务接到共享队列末尾。调用方不得在任务内部 await 本函数返回的 drain。
 */
export function chainConsolidationTail(
  build: (current: Promise<void>) => Promise<void>,
): void {
  tail = build(tail);
}

/**
 * 把一次有界 drain 追加到共享 tail 之后。
 * 不合并进行中的 flight：调用方用自己的 activeDrain 保证同一实例不重复入队。
 * 返回的 Promise 就是 drain 结果本身，不再包 finally，以免多一个未处理的拒绝。
 */
export function enqueueSerialDrain(
  run: () => Promise<DrainConsolidationResult>,
): Promise<DrainConsolidationResult> {
  drainDepth += 1;

  let resolveFlight: (result: DrainConsolidationResult) => void = () => undefined;
  let rejectFlight: (error: unknown) => void = () => undefined;
  const flight = new Promise<DrainConsolidationResult>((resolve, reject) => {
    resolveFlight = resolve;
    rejectFlight = reject;
  });

  chainConsolidationTail((current) =>
    current
      .catch(() => undefined)
      .then(async () => {
        try {
          resolveFlight(await run());
        } catch (error) {
          rejectFlight(error);
          throw error;
        }
      })
      .then(() => undefined)
      .finally(() => {
        drainDepth -= 1;
      })
      // flight 已经把原始异常交给调用方。共享 tail 在计数恢复后消化这次拒绝，
      // 否则 currentConsolidationTail() 会一直 rejected。
      .catch(() => undefined),
  );

  return flight;
}
