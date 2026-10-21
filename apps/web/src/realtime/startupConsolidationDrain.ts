/**
 * 页面启动后的一次有界 outbox 恢复。
 * 不创建 RealtimeClient，不连接 Live，不请求麦克风，不读取 handoff 前的 RAM。
 */

import {
  drainConsolidationOutbox,
  type DrainFetch,
} from "./consolidationDrain.ts";
import { enqueueSerialDrain } from "./consolidationDrainCoordinator.ts";
import { ConsolidationOutbox } from "./consolidationOutbox.ts";

export type StartupConsolidationDrainDeps = {
  /** 测试必须注入。缺省才使用 globalThis.fetch。 */
  fetchImpl?: DrainFetch;
  outbox?: ConsolidationOutbox;
  /** 构造 outbox 失败路径的测试注入。缺省为生产默认 key。 */
  openOutbox?: () => ConsolidationOutbox;
  now?: () => string;
  leaseOwner?: string;
};

let startupOnce: Promise<void> | null = null;

function bootLeaseOwner(): string {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return `boot-${globalThis.crypto.randomUUID()}`;
  }

  return `boot-${Date.now().toString(16)}`;
}

/**
 * 每个页面模块实例只启动一次，重复调用（含 Strict Mode）返回同一 Promise。
 * 异常只打 warning，不向调用方抛出。
 */
export function scheduleStartupConsolidationDrain(
  deps: StartupConsolidationDrainDeps = {},
): Promise<void> {
  if (startupOnce) return startupOnce;

  startupOnce = runStartupConsolidationDrain(deps);
  return startupOnce;
}

/** 仅供离线测试隔离用例。不取消已经在飞的 drain。 */
export function resetStartupConsolidationDrainForTests(): void {
  startupOnce = null;
}

async function runStartupConsolidationDrain(
  deps: StartupConsolidationDrainDeps,
): Promise<void> {
  const fetchImpl =
    deps.fetchImpl ??
    ((input: Parameters<DrainFetch>[0], init?: RequestInit) =>
      globalThis.fetch(input, init));

  try {
    const outbox = deps.outbox ?? (deps.openOutbox ?? (() => new ConsolidationOutbox()))();
    await enqueueSerialDrain(() =>
      drainConsolidationOutbox({
        outbox,
        fetchImpl,
        now: deps.now ?? (() => new Date().toISOString()),
        leaseOwner: deps.leaseOwner ?? bootLeaseOwner(),
      }),
    );
  } catch (error) {
    console.warn("[Memory] startup consolidation drain failed:", error);
  }
}
