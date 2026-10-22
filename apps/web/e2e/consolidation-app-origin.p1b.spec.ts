/**
 * P1-B：真实 Vite App origin（localhost:5173）无 Live 验证。
 * - 导航前安装 App origin 网络门闩：consolidate 一律 abort；其它 /api stub fulfill
 * - 不点击呼叫、不连 Live、不开麦
 * - 不读 .env／token 文件；Vite 子进程仅注入合成 COMPANION_ACCESS_TOKEN（不打印）
 * - 不启动 apps/server（不打开正式 SQLite）
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import {
  ConsolidationOutbox,
  CONSOLIDATION_OUTBOX_STORAGE_KEY,
  createMemoryOutboxStorage,
  type ConsolidationOutboxItem,
} from "../src/realtime/consolidationOutbox.ts";
import { computeConsolidationPayloadHash } from "../src/realtime/consolidationPayload.ts";
import {
  assertNoConsolidateTraffic,
  createAppOriginGuardState,
  gotoAppOnlyIfGuardReady,
  installAppOriginNetworkGuard,
  type AppOriginGuardState,
} from "./helpers/appOriginNetworkGuard.ts";

const WEB_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const APP_ORIGIN = "http://localhost:5173";
const PROFILE_ROOT = path.join(
  process.cwd(),
  ".playwright",
  "profiles",
  "p1b-app-origin",
);

/** 合成 token：仅注入 Vite 子进程以通过 vite.config serve 校验；绝不打印／写入报告正文。 */
const SYNTHETIC_VITE_TOKEN = "s1b-test-companion-access-token-0001";

const OCCURRED_ON = "2026-10-20";
const TURNS = [
  { role: "user" as const, text: "p1b app-origin refresh probe unique" },
  { role: "companion" as const, text: "p1b isolated profile only" },
];

function summarizeItem(item: ConsolidationOutboxItem) {
  return {
    batchId: item.batchId,
    payloadHash: item.payloadHash,
    occurredOn: item.occurredOn,
    turns: item.turns,
    status: item.status,
    attempts: item.attempts,
    leaseOwner: item.leaseOwner,
    leaseExpiresAt: item.leaseExpiresAt,
    nextAttemptAt: item.nextAttemptAt,
    lastError: item.lastError,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

async function probeAppOrigin(origin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const url = new URL(origin);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: "/",
        method: "GET",
        timeout: 1_500,
      },
      (res) => {
        res.resume();
        resolve(
          typeof res.statusCode === "number" &&
            res.statusCode >= 200 &&
            res.statusCode < 500,
        );
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

async function waitForAppOrigin(
  origin: string,
  timeoutMs = 60_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await probeAppOrigin(origin)) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Vite App origin not reachable: ${origin}`);
}

test.describe.configure({ mode: "serial" });

test.describe("P1-B real Vite App origin (no Live)", () => {
  let viteProc: ChildProcess | null = null;
  let startedVite = false;
  let context: BrowserContext;
  let page: Page;
  let guard: AppOriginGuardState;
  let profileDir: string;
  let batchId: string;
  const fixedNow = "2026-10-20T15:00:00.000Z";

  test.beforeAll(async () => {
    fs.mkdirSync(PROFILE_ROOT, { recursive: true });
    profileDir = fs.mkdtempSync(path.join(PROFILE_ROOT, "run-"));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    batchId = `p1b-refresh-${stamp}-0001`;

    const alreadyUp = await probeAppOrigin(APP_ORIGIN);
    if (alreadyUp) {
      // eslint-disable-next-line no-console
      console.log(
        `[p1b] reusing existing server at ${APP_ORIGIN} (Playwright still stubs all /api; consolidate abort-only)`,
      );
    } else {
      // eslint-disable-next-line no-console
      console.log(
        `[p1b] starting Vite only: pnpm exec vite --host localhost --port 5173`,
      );
      // eslint-disable-next-line no-console
      console.log(
        "[p1b] NOT starting apps/server; NOT opening companion.db; synthetic COMPANION_ACCESS_TOKEN for Vite config only",
      );
      viteProc = spawn(
        "pnpm",
        ["exec", "vite", "--host", "localhost", "--port", "5173"],
        {
          cwd: WEB_ROOT,
          env: {
            ...process.env,
            COMPANION_ACCESS_TOKEN: SYNTHETIC_VITE_TOKEN,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      startedVite = true;
      viteProc.stderr?.on("data", (buf: Buffer) => {
        const text = buf.toString("utf8");
        if (/COMPANION_ACCESS_TOKEN|error|Error/i.test(text)) {
          // eslint-disable-next-line no-console
          console.log("[p1b vite stderr]", text.slice(0, 400));
        }
      });
    }

    await waitForAppOrigin(APP_ORIGIN);
    // eslint-disable-next-line no-console
    console.log(`[p1b] App origin ready: ${APP_ORIGIN}`);
  });

  test.afterAll(async () => {
    if (startedVite && viteProc && !viteProc.killed) {
      viteProc.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 500));
      if (!viteProc.killed) viteProc.kill("SIGKILL");
    }
  });

  test.beforeEach(async () => {
    guard = createAppOriginGuardState();
    context = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      serviceWorkers: "block",
    });
    page = context.pages()[0] ?? (await context.newPage());
  });

  test.afterEach(async () => {
    await context?.close().catch(() => undefined);
  });

  test("T1: load+dwell on real App origin produces zero consolidate", async () => {
    expect(guard.ready).toBe(false);
    await installAppOriginNetworkGuard(context, guard);
    expect(guard.ready).toBe(true);

    await gotoAppOnlyIfGuardReady(page, guard, APP_ORIGIN);

    expect(page.url().startsWith(APP_ORIGIN)).toBe(true);
    // eslint-disable-next-line no-console
    console.log("[p1b] loaded url", page.url());

    await page.waitForTimeout(2_000);

    assertNoConsolidateTraffic(guard);
    // eslint-disable-next-line no-console
    console.log("[p1b] T1 apiStubHits", guard.apiStubHits, guard.apiStubPaths.slice(0, 12));
  });

  test("T2: pending batch survives reload; still zero consolidate", async () => {
    await installAppOriginNetworkGuard(context, guard);
    await gotoAppOnlyIfGuardReady(page, guard, APP_ORIGIN);
    assertNoConsolidateTraffic(guard);

    const mem = createMemoryOutboxStorage();
    const writer = new ConsolidationOutbox({
      storage: mem,
      now: () => fixedNow,
    });
    const payloadHash = await computeConsolidationPayloadHash(OCCURRED_ON, TURNS);
    const seeded = writer.add({
      batchId,
      payloadHash,
      occurredOn: OCCURRED_ON,
      turns: TURNS,
      status: "pending",
    });
    expect(seeded.batchId.startsWith("p1b-refresh-")).toBe(true);

    const rawBefore = mem.getItem(CONSOLIDATION_OUTBOX_STORAGE_KEY);
    expect(rawBefore).toBeTruthy();
    await page.evaluate(
      ({ key, value }) => localStorage.setItem(key, value),
      { key: CONSOLIDATION_OUTBOX_STORAGE_KEY, value: rawBefore! },
    );

    const before = summarizeItem(seeded);
    // eslint-disable-next-line no-console
    console.log("[p1b] before", JSON.stringify(before));

    assertNoConsolidateTraffic(guard);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1_500);

    assertNoConsolidateTraffic(guard);

    const rawAfter = await page.evaluate(
      (key) => localStorage.getItem(key),
      CONSOLIDATION_OUTBOX_STORAGE_KEY,
    );
    expect(rawAfter).toBeTruthy();
    expect(rawAfter).toBe(rawBefore);

    const reader = new ConsolidationOutbox({
      storage: createMemoryOutboxStorage({
        [CONSOLIDATION_OUTBOX_STORAGE_KEY]: rawAfter!,
      }),
      now: () => fixedNow,
    });
    const recovered = reader.get(batchId);
    expect(recovered).not.toBeNull();
    const after = summarizeItem(recovered!);
    // eslint-disable-next-line no-console
    console.log("[p1b] after", JSON.stringify(after));

    expect(after.batchId).toBe(before.batchId);
    expect(after.payloadHash).toBe(before.payloadHash);
    expect(after.occurredOn).toBe(before.occurredOn);
    expect(after.turns).toEqual(before.turns);
    expect(after.status).toBe(before.status);
    expect(after.attempts).toBe(before.attempts);
    expect(after.leaseOwner).toBe(before.leaseOwner);
    expect(after.leaseExpiresAt).toBe(before.leaseExpiresAt);
    expect(after.nextAttemptAt).toBe(before.nextAttemptAt);
    expect(after.lastError).toBe(before.lastError);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.updatedAt).toBe(before.updatedAt);

    // 仅清理本次 p1b-refresh-* 批次
    const cleanupStorage = createMemoryOutboxStorage({
      [CONSOLIDATION_OUTBOX_STORAGE_KEY]: rawAfter!,
    });
    const cleanup = new ConsolidationOutbox({
      storage: cleanupStorage,
      now: () => fixedNow,
    });
    expect(cleanup.get(batchId)?.batchId.startsWith("p1b-refresh-")).toBe(true);
    cleanup.remove(batchId);
    if (cleanup.list().length === 0) {
      await page.evaluate(
        (key) => localStorage.removeItem(key),
        CONSOLIDATION_OUTBOX_STORAGE_KEY,
      );
    } else {
      await page.evaluate(
        ({ key, value }) => localStorage.setItem(key, value),
        {
          key: CONSOLIDATION_OUTBOX_STORAGE_KEY,
          value: cleanupStorage.getItem(CONSOLIDATION_OUTBOX_STORAGE_KEY)!,
        },
      );
    }

    assertNoConsolidateTraffic(guard);
    // eslint-disable-next-line no-console
    console.log(
      "[p1b] T2 consolidateBlockedHits",
      guard.consolidateBlockedHits,
      "apiStubHits",
      guard.apiStubHits,
    );
  });

  test("T3: navigation refused when guard not ready", async () => {
    expect(guard.ready).toBe(false);
    let threw = false;
    try {
      await gotoAppOnlyIfGuardReady(page, guard, APP_ORIGIN);
    } catch (error) {
      threw = true;
      expect(String(error)).toMatch(/must be ready/);
    }
    expect(threw).toBe(true);
    expect(page.url().startsWith(APP_ORIGIN)).toBe(false);
  });
});

test("P1-B profile path is under project .playwright", () => {
  const resolved = path.resolve(PROFILE_ROOT);
  expect(resolved.includes(`${path.sep}.playwright${path.sep}`)).toBe(true);
  expect(resolved.startsWith(path.resolve(os.homedir(), "Library"))).toBe(
    false,
  );
});
