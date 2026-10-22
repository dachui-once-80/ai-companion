/**
 * P0 fail-closed 拦截：/api/memory/consolidate 默认拒绝，禁止 route.continue()。
 * 不读 token／.env；不触达正式 :3000（由 Playwright 在浏览器网络栈拦截）。
 */

import assert from "node:assert/strict";
import http from "node:http";
import type { BrowserContext, Page, Route } from "@playwright/test";

export const EXPECTED_BATCH_ID = "p0-smoke-expected-batch-0001";

export const MOCK_SUCCESS_BODY = {
  saved: {
    episodes: 0,
    impressions: 0,
    notes: 0,
    profile: 0,
    between: 0,
    closedBetween: 0,
    retired: 0,
    views: 0,
    unresolved: 0,
    question: 0,
    closedUnresolved: 0,
    closedQuestion: 0,
  },
  p0Mock: true,
};

export type ConsolidateRequestLog = {
  method: string;
  url: string;
  batchId: string | null;
  outcome: "mocked" | "blocked";
  reason?: string;
};

export type FailClosedIntercept = {
  ready: boolean;
  mockHits: number;
  blockedHits: number;
  logs: ConsolidateRequestLog[];
  failures: string[];
  allowExpectedPost: boolean;
  /** mock handler 故意抛错（异常路径）。 */
  throwInMock: boolean;
};

function isConsolidateUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    return path === "/api/memory/consolidate";
  } catch {
    return /\/api\/memory\/consolidate(?:\?|$)/.test(url);
  }
}

function readBatchId(postData: string | null): string | null {
  if (!postData) return null;
  try {
    const body = JSON.parse(postData) as { batchId?: unknown };
    return typeof body.batchId === "string" ? body.batchId : null;
  } catch {
    return null;
  }
}

async function blockConsolidate(
  state: FailClosedIntercept,
  route: Route,
  method: string,
  url: string,
  batchId: string | null,
  reason: string,
): Promise<void> {
  state.failures.push(reason);
  state.blockedHits += 1;
  state.logs.push({ method, url, batchId, outcome: "blocked", reason });
  // 禁止 continue：只 abort
  await route.abort("failed");
}

/**
 * 在导航前注册。对 consolidate：**永不** route.continue()。
 */
export async function installFailClosedConsolidateIntercept(
  context: BrowserContext,
  state: FailClosedIntercept,
): Promise<void> {
  await context.route("**/*", async (route: Route) => {
    const request = route.request();
    const url = request.url();

    if (!isConsolidateUrl(url)) {
      await route.continue();
      return;
    }

    const method = request.method().toUpperCase();
    const batchId = readBatchId(request.postData());

    const isExpectedPost =
      state.allowExpectedPost &&
      method === "POST" &&
      batchId === EXPECTED_BATCH_ID;

    if (!isExpectedPost) {
      const reason =
        method !== "POST"
          ? `unexpected_method:${method}`
          : batchId !== EXPECTED_BATCH_ID
            ? `unexpected_batchId:${batchId ?? "null"}`
            : "unexpected_consolidate_request";
      await blockConsolidate(state, route, method, url, batchId, reason);
      return;
    }

    if (state.throwInMock) {
      await blockConsolidate(
        state,
        route,
        method,
        url,
        batchId,
        "mock_handler_error:p0 mock handler forced failure",
      );
      return;
    }

    state.mockHits += 1;
    state.logs.push({ method, url, batchId, outcome: "mocked" });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(MOCK_SUCCESS_BODY),
    });
  });

  state.ready = true;
}

export function assertInterceptReady(state: FailClosedIntercept): void {
  assert.equal(
    state.ready,
    true,
    "consolidate intercept must be ready before navigation or page fetch",
  );
}

/** 仅当拦截已 ready 才允许导航；否则抛错并停止。 */
export async function gotoOnlyIfInterceptReady(
  page: Page,
  state: FailClosedIntercept,
  url: string,
): Promise<void> {
  assertInterceptReady(state);
  await page.goto(url, { waitUntil: "domcontentloaded" });
}

export type StubOrigin = {
  origin: string;
  consolidateLeaks: { count: number; methods: string[] };
  close: () => Promise<void>;
};

/**
 * 极简源站：只服务 GET /。consolidate 若落到此服务器＝拦截泄漏（仍非正式 :3000）。
 */
export async function startStubOrigin(): Promise<StubOrigin> {
  const consolidateLeaks = { count: 0, methods: [] as string[] };

  const server = http.createServer((req, res) => {
    const host = req.headers.host ?? "127.0.0.1";
    const url = new URL(req.url ?? "/", `http://${host}`);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/api/memory/consolidate") {
      consolidateLeaks.count += 1;
      consolidateLeaks.methods.push(req.method ?? "?");
      res.writeHead(599, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "p0_stub_leak_consolidate_must_not_reach_origin",
        }),
      );
      return;
    }

    if (req.method === "GET" && path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!doctype html><html><head><meta charset='utf-8'><title>p0-stub</title></head><body><p>p0 stub</p></body></html>",
      );
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("stub server failed to bind 127.0.0.1");
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    consolidateLeaks,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export function createInterceptState(
  overrides: Partial<FailClosedIntercept> = {},
): FailClosedIntercept {
  return {
    ready: false,
    mockHits: 0,
    blockedHits: 0,
    logs: [],
    failures: [],
    allowExpectedPost: true,
    throwInMock: false,
    ...overrides,
  };
}
