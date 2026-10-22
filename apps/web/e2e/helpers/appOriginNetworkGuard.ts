/**
 * P1-B：真实 Vite App origin 的网络门闩。
 * - /api/memory/consolidate：永不 continue（一律 abort）
 * - 其它 /api/*：fulfill 无害 stub（永不转发到 Vite proxy／:3000）
 * - 非 /api：continue（静态资源走 Vite）
 * - live-proxy WS／路径：abort
 */

import assert from "node:assert/strict";
import type { BrowserContext, Page, Route } from "@playwright/test";

export type AppOriginGuardState = {
  ready: boolean;
  /** consolidate 被 abort 次数（本阶段期望为 0）。 */
  consolidateBlockedHits: number;
  /** 其它 /api stub fulfill 次数。 */
  apiStubHits: number;
  consolidateLogs: Array<{
    method: string;
    url: string;
    outcome: "blocked";
    reason: string;
  }>;
  apiStubPaths: string[];
};

function pathnameOf(url: string): string | null {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "") || "/";
    return path;
  } catch {
    return null;
  }
}

function isConsolidateUrl(url: string): boolean {
  const path = pathnameOf(url);
  if (path) return path === "/api/memory/consolidate";
  return /\/api\/memory\/consolidate(?:\?|$)/.test(url);
}

function isLiveProxyUrl(url: string): boolean {
  return url.includes("/api/gemini/live-proxy");
}

function isApiUrl(url: string): boolean {
  const path = pathnameOf(url);
  if (path) return path === "/api" || path.startsWith("/api/");
  try {
    return new URL(url).pathname.startsWith("/api");
  } catch {
    return false;
  }
}

function stubBodyForPath(path: string): string {
  if (path === "/api/companion/identity") {
    return JSON.stringify({ currentName: "p1b-probe" });
  }
  if (path.startsWith("/api/tasks/reminders")) {
    return JSON.stringify([]);
  }
  if (path === "/api/companion/aside") {
    return JSON.stringify({ text: "" });
  }
  if (path.startsWith("/api/affect/")) {
    return JSON.stringify({ ok: true });
  }
  return JSON.stringify({ ok: true, p1bStub: true });
}

export function createAppOriginGuardState(): AppOriginGuardState {
  return {
    ready: false,
    consolidateBlockedHits: 0,
    apiStubHits: 0,
    consolidateLogs: [],
    apiStubPaths: [],
  };
}

/**
 * 必须在 page.goto(真实 App) 之前调用。
 * consolidate：**禁止** route.continue()。
 */
export async function installAppOriginNetworkGuard(
  context: BrowserContext,
  state: AppOriginGuardState,
): Promise<void> {
  await context.route("**/*", async (route: Route) => {
    const request = route.request();
    const url = request.url();
    const method = request.method().toUpperCase();

    if (isConsolidateUrl(url)) {
      const reason = `p1b_unexpected_consolidate:${method}`;
      state.consolidateBlockedHits += 1;
      state.consolidateLogs.push({
        method,
        url,
        outcome: "blocked",
        reason,
      });
      await route.abort("failed");
      return;
    }

    if (isLiveProxyUrl(url)) {
      await route.abort("failed");
      return;
    }

    if (isApiUrl(url)) {
      const path = pathnameOf(url) ?? "/api";
      state.apiStubHits += 1;
      state.apiStubPaths.push(`${method} ${path}`);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: stubBodyForPath(path),
      });
      return;
    }

    await route.continue();
  });

  state.ready = true;
}

export function assertAppOriginGuardReady(state: AppOriginGuardState): void {
  assert.equal(
    state.ready,
    true,
    "app-origin network guard must be ready before navigation",
  );
}

export async function gotoAppOnlyIfGuardReady(
  page: Page,
  state: AppOriginGuardState,
  url: string,
): Promise<void> {
  assertAppOriginGuardReady(state);
  await page.goto(url, { waitUntil: "domcontentloaded" });
}

export function assertNoConsolidateTraffic(state: AppOriginGuardState): void {
  assert.equal(
    state.consolidateBlockedHits,
    0,
    `expected zero consolidate attempts, got ${state.consolidateBlockedHits}: ${JSON.stringify(state.consolidateLogs)}`,
  );
  assert.equal(state.consolidateLogs.length, 0);
}
