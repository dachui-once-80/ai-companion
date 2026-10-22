/**
 * P0：consolidation fail-closed 网络拦截冒烟。
 * - 独立 persistent profile（非日常浏览器目录）
 * - 不启动 Vite App／Gemini Live／麦克风
 * - 不读 .env／token；不写默认 outbox／正式库
 * - 页面内 fetch 证明拦截；不以 Node 侧替换 fetch 作为证据
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import {
  EXPECTED_BATCH_ID,
  MOCK_SUCCESS_BODY,
  assertInterceptReady,
  createInterceptState,
  gotoOnlyIfInterceptReady,
  installFailClosedConsolidateIntercept,
  startStubOrigin,
  type FailClosedIntercept,
  type StubOrigin,
} from "./helpers/consolidationIntercept.ts";

const PROFILE_ROOT = path.join(
  process.cwd(),
  ".playwright",
  "profiles",
  "p0-consolidation-intercept",
);

async function pageFetchConsolidate(
  page: Page,
  origin: string,
  init: { method: string; batchId?: string },
): Promise<{ ok: boolean; status: number; bodyText: string }> {
  return page.evaluate(
    async ({ origin: base, method, batchId }) => {
      try {
        const response = await fetch(`${base}/api/memory/consolidate`, {
          method,
          headers: { "Content-Type": "application/json" },
          body:
            method === "GET" || method === "HEAD"
              ? undefined
              : JSON.stringify({
                  batchId: batchId ?? "missing",
                  payloadHash: "a".repeat(64),
                  occurredOn: "2026-10-20",
                  turns: [{ role: "user", text: "p0" }],
                }),
        });
        const bodyText = await response.text();
        return { ok: response.ok, status: response.status, bodyText };
      } catch (error) {
        return {
          ok: false,
          status: 0,
          bodyText: error instanceof Error ? error.message : String(error),
        };
      }
    },
    { origin, method: init.method, batchId: init.batchId },
  );
}

test.describe.configure({ mode: "serial" });

test.describe("P0 consolidation fail-closed intercept", () => {
  let stub: StubOrigin;
  let context: BrowserContext;
  let page: Page;
  let state: FailClosedIntercept;
  let profileDir: string;

  test.beforeAll(async () => {
    fs.mkdirSync(PROFILE_ROOT, { recursive: true });
    profileDir = fs.mkdtempSync(path.join(PROFILE_ROOT, "run-"));
    stub = await startStubOrigin();
  });

  test.afterAll(async () => {
    await stub?.close().catch(() => undefined);
  });

  test.beforeEach(async () => {
    state = createInterceptState();
    context = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      serviceWorkers: "block",
    });
    page = context.pages()[0] ?? (await context.newPage());
  });

  test.afterEach(async () => {
    await context?.close().catch(() => undefined);
  });

  test("T1: expected POST is fulfilled by mock only (no stub leak)", async () => {
    await installFailClosedConsolidateIntercept(context, state);
    await gotoOnlyIfInterceptReady(page, state, stub.origin);

    const result = await pageFetchConsolidate(page, stub.origin, {
      method: "POST",
      batchId: EXPECTED_BATCH_ID,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(JSON.parse(result.bodyText)).toMatchObject({
      p0Mock: true,
      saved: MOCK_SUCCESS_BODY.saved,
    });
    expect(state.mockHits).toBe(1);
    expect(state.blockedHits).toBe(0);
    expect(stub.consolidateLeaks.count).toBe(0);
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0]?.outcome).toBe("mocked");
  });

  test("T2: unexpected method is aborted (fail closed, no continue)", async () => {
    await installFailClosedConsolidateIntercept(context, state);
    await gotoOnlyIfInterceptReady(page, state, stub.origin);

    const result = await pageFetchConsolidate(page, stub.origin, {
      method: "GET",
    });

    expect(result.ok).toBe(false);
    expect(state.mockHits).toBe(0);
    expect(state.blockedHits).toBe(1);
    expect(state.failures.some((f) => f.startsWith("unexpected_method:"))).toBe(
      true,
    );
    expect(stub.consolidateLeaks.count).toBe(0);
  });

  test("T3: unexpected batchId is aborted", async () => {
    await installFailClosedConsolidateIntercept(context, state);
    await gotoOnlyIfInterceptReady(page, state, stub.origin);

    const result = await pageFetchConsolidate(page, stub.origin, {
      method: "POST",
      batchId: "p0-smoke-WRONG-batch",
    });

    expect(result.ok).toBe(false);
    expect(state.mockHits).toBe(0);
    expect(state.blockedHits).toBe(1);
    expect(
      state.failures.some((f) => f.startsWith("unexpected_batchId:")),
    ).toBe(true);
    expect(stub.consolidateLeaks.count).toBe(0);
  });

  test("T4: navigation refused when intercept is not ready", async () => {
    // 故意不调用 installFailClosedConsolidateIntercept
    expect(state.ready).toBe(false);

    let threw = false;
    try {
      await gotoOnlyIfInterceptReady(page, state, stub.origin);
    } catch (error) {
      threw = true;
      expect(String(error)).toMatch(/intercept must be ready/);
    }
    expect(threw).toBe(true);
    expect(state.mockHits).toBe(0);
    expect(stub.consolidateLeaks.count).toBe(0);

    // 未导航成功时页面不应处于 stub origin 文档
    expect(page.url()).not.toBe(stub.origin + "/");
  });

  test("T5: mock handler failure aborts (no fallback to network)", async () => {
    state.throwInMock = true;
    await installFailClosedConsolidateIntercept(context, state);
    await gotoOnlyIfInterceptReady(page, state, stub.origin);

    const result = await pageFetchConsolidate(page, stub.origin, {
      method: "POST",
      batchId: EXPECTED_BATCH_ID,
    });

    expect(result.ok).toBe(false);
    expect(state.mockHits).toBe(0);
    expect(state.blockedHits).toBe(1);
    expect(
      state.failures.some((f) => f.includes("mock_handler_error")),
    ).toBe(true);
    expect(stub.consolidateLeaks.count).toBe(0);
  });

  test("T6: assertInterceptReady gates page fetch path", async () => {
    expect(state.ready).toBe(false);
    expect(() => assertInterceptReady(state)).toThrow(/must be ready/);

    await installFailClosedConsolidateIntercept(context, state);
    assertInterceptReady(state);
    await gotoOnlyIfInterceptReady(page, state, stub.origin);

    // 证明页面 fetch 走拦截而非 Node 全局 fetch（命中 mock 计数）
    const result = await pageFetchConsolidate(page, stub.origin, {
      method: "POST",
      batchId: EXPECTED_BATCH_ID,
    });
    expect(result.status).toBe(200);
    expect(state.mockHits).toBe(1);
    expect(stub.consolidateLeaks.count).toBe(0);
  });
});

test("P0 profile path is under project .playwright (not daily Chrome)", () => {
  const resolved = path.resolve(PROFILE_ROOT);
  expect(resolved.includes(`${path.sep}.playwright${path.sep}`)).toBe(true);
  expect(resolved.startsWith(path.resolve(os.homedir(), "Library"))).toBe(
    false,
  );
});
