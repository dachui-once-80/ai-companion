/**
 * P1-C：真实 App 启动 drain。本文件由 Playwright 执行；本阶段不运行它。
 * 不刷新页面。端口检查在 gotoP1cApp 内、第一次导航之前完成。
 */

import { chromium, expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  CONSOLIDATION_OUTBOX_STORAGE_KEY,
  cleanupP1cBatchOnPage,
  readP1cBatch,
  seedP1cBatch,
  seedP1cSuccessPair,
} from "./helpers/p1cBatch.ts";
import { summarizeP1cTurns } from "./helpers/p1cMockApi.ts";
import { disposeAllP1cSessions, startP1cSession, type P1cSession } from "./helpers/p1cLaunch.ts";

type P1cCleanupState = {
  page?: Page;
  context?: BrowserContext;
  batchIds: string[];
  tornDown: boolean;
};

const p1cTest = test.extend<{ p1cCleanup: P1cCleanupState }>({
  p1cCleanup: [
    async ({}, use) => {
      await use({ batchIds: [], tornDown: false });
    },
    { scope: "test" },
  ],
});

async function readRaw(page: Page): Promise<string | null> {
  return page.evaluate(
    (key) => localStorage.getItem(key),
    CONSOLIDATION_OUTBOX_STORAGE_KEY,
  );
}

p1cTest.describe.configure({ mode: "serial" });

p1cTest.describe("P1-C startup drain isolation", () => {
  const contextCloses = new WeakMap<BrowserContext, Promise<void>>();

  function formatCleanupError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  function throwCleanupErrors(errors: unknown[]): void {
    if (errors.length === 1) throw errors[0];

    if (errors.length > 1) {
      throw new Error(errors.map((error) => formatCleanupError(error)).join("\n"));
    }
  }

  async function closeContextOnce(context: BrowserContext): Promise<void> {
    const existing = contextCloses.get(context);

    if (existing) {
      await existing;
      return;
    }

    const closing = context.close();

    contextCloses.set(context, closing);

    try {
      await closing;
    } catch (error) {
      if (contextCloses.get(context) === closing) contextCloses.delete(context);

      throw error;
    }
  }

  async function finishP1cTest(input: {
    failure?: unknown;
    cleanup: P1cCleanupState;
    page?: Page;
    context?: BrowserContext;
    session?: P1cSession;
    batchIds: string[];
  }): Promise<void> {
    const errors: unknown[] = [];

    input.cleanup.page = input.page;
    if (!input.cleanup.tornDown) input.cleanup.context = input.context;
    input.cleanup.batchIds = input.batchIds;

    if (input.failure !== undefined) errors.push(input.failure);

    if (input.session) {
      try {
        await input.session.dispose({
          retainProfile: input.failure !== undefined,
        });
      } catch (error) {
        errors.push(error);
      }
    }

    throwCleanupErrors(errors);
  }

  p1cTest.afterEach(async ({ p1cCleanup }, testInfo) => {
    p1cCleanup.tornDown = true;

    const errors: unknown[] = [];

    try {
      let status: string | undefined;

      try {
        status = testInfo.status;
      } catch (error) {
        errors.push(error);
      }

      const page = p1cCleanup.page;
      const batchIds = p1cCleanup.batchIds.filter((batchId) => batchId.length > 0);

      if (status === "passed" && page && batchIds.length > 0) {
        for (const batchId of batchIds) {
          try {
            await cleanupP1cBatchOnPage(page, batchId);
          } catch (error) {
            errors.push(error);
          }
        }
      }
    } finally {
      if (p1cCleanup.context) {
        try {
          await closeContextOnce(p1cCleanup.context);
        } catch (error) {
          errors.push(error);
        }
      }

      try {
        await disposeAllP1cSessions();
      } catch (error) {
        errors.push(error);
      }
    }

    throwCleanupErrors(errors);
  });

  p1cTest("success drain removes the seeded batch after one response", async ({ p1cCleanup }) => {
    let session: P1cSession | undefined;
    let context: BrowserContext | undefined;
    let page: Page | undefined;
    let batchId = "";
    let sentinelId = "";

    let failure: unknown;

    try {
      session = await startP1cSession("success");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const seeded = await seedP1cSuccessPair({
        stamp,
        nowIso: new Date(Date.now() - 60_000).toISOString(),
      });
      batchId = seeded.target.batchId;
      sentinelId = seeded.sentinel.batchId;
      p1cCleanup.batchIds = [batchId, sentinelId];
      context = await chromium.launchPersistentContext(session.profileDir, {
        headless: true,
        serviceWorkers: "block",
      });
      if (p1cCleanup.tornDown) {
        await closeContextOnce(context);
      } else {
        p1cCleanup.context = context;
      }
      page = context.pages()[0] ?? (await context.newPage());
      p1cCleanup.page = page;
      const openPage = page;
      await context.addInitScript(
        ({ key, value }) => {
          localStorage.setItem(key, value);
        },
        { key: CONSOLIDATION_OUTBOX_STORAGE_KEY, value: seeded.raw },
      );
      await session.gotoApp(page);

      const log = await session.waitForConsolidate(seeded.target.batchId, 15_000);

      await expect
        .poll(async () => readP1cBatch(await readRaw(openPage), seeded.target.batchId), {
          timeout: 15_000,
        })
        .toBeNull();

      const held = readP1cBatch(await readRaw(openPage), seeded.sentinel.batchId);
      const matches = session.consolidateLogs.filter(
        (entry) => entry.batchId === seeded.target.batchId,
      );

      expect(matches).toHaveLength(1);
      expect(session.consolidateLogs).toHaveLength(1);
      expect(log.batchId).toBe(seeded.target.batchId);
      expect(log.outcome).toBe("responded");
      expect(log.responseStatus).toBe(200);
      expect(log.payloadHash).toBe(seeded.target.payloadHash);
      expect(log.occurredOn).toBe(seeded.target.occurredOn);
      expect(log.turns).toEqual(summarizeP1cTurns(seeded.target.turns));
      expect(log.closedAt).toBeNull();
      expect(log.url).toContain(`127.0.0.1:${session.apiPort}`);
      expect(held?.payloadHash).toBe(seeded.sentinel.payloadHash);
      expect(held?.occurredOn).toBe(seeded.sentinel.occurredOn);
      expect(held?.status).toBe("pending");
      expect(held?.attempts).toBe(0);
      expect(held?.leaseOwner).toBeNull();
      expect(held?.leaseExpiresAt).toBeNull();
      expect(summarizeP1cTurns(held?.turns ?? [])).toEqual(
        summarizeP1cTurns(seeded.sentinel.turns),
      );
      expect(session.unexpectedLogs).toHaveLength(0);
      expect(session.apiPort).not.toBe(3000);
      expect(session.apiPort).not.toBe(5173);
      expect(session.vitePort).not.toBe(3000);
      expect(session.vitePort).not.toBe(5173);
    } catch (error) {
      failure = error;
    } finally {
      await finishP1cTest({
        failure,
        cleanup: p1cCleanup,
        page,
        context,
        session,
        batchIds: [batchId, sentinelId],
      });
    }
  });

  p1cTest("network disconnect keeps the batch pending and does not send a second request", async ({ p1cCleanup }) => {
    let session: P1cSession | undefined;
    let context: BrowserContext | undefined;
    let page: Page | undefined;
    let batchId = "";

    let failure: unknown;

    try {
      session = await startP1cSession("disconnect");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const seeded = await seedP1cBatch({
        kind: "net",
        stamp,
        nowIso: new Date(Date.now() - 60_000).toISOString(),
      });
      batchId = seeded.batchId;
      p1cCleanup.batchIds = [batchId];
      context = await chromium.launchPersistentContext(session.profileDir, {
        headless: true,
        serviceWorkers: "block",
      });
      if (p1cCleanup.tornDown) {
        await closeContextOnce(context);
      } else {
        p1cCleanup.context = context;
      }
      page = context.pages()[0] ?? (await context.newPage());
      p1cCleanup.page = page;
      const openPage = page;
      await context.addInitScript(
        ({ key, value }) => {
          localStorage.setItem(key, value);
        },
        { key: CONSOLIDATION_OUTBOX_STORAGE_KEY, value: seeded.raw },
      );
      await session.gotoApp(openPage);

      const log = await session.waitForConsolidate(seeded.batchId, 15_000);

      await expect
        .poll(async () => {
          const item = readP1cBatch(await readRaw(openPage), seeded.batchId);

          if (!item) return false;

          return (
            item.status === "pending" &&
            item.leaseOwner === null &&
            item.leaseExpiresAt === null &&
            item.attempts === 1 &&
            typeof item.lastError === "string" &&
            item.lastError.startsWith("network:")
          );
        }, { timeout: 15_000 })
        .toBe(true);

      const item = readP1cBatch(await readRaw(openPage), seeded.batchId);

      expect(item).not.toBeNull();
      expect(item?.batchId).toBe(seeded.batchId);
      expect(item?.payloadHash).toBe(seeded.payloadHash);
      expect(item?.occurredOn).toBe(seeded.occurredOn);
      expect(summarizeP1cTurns(item?.turns ?? [])).toEqual(summarizeP1cTurns(seeded.turns));
      expect(log.batchId).toBe(seeded.batchId);
      expect(log.payloadHash).toBe(seeded.payloadHash);
      expect(log.occurredOn).toBe(seeded.occurredOn);
      expect(log.turns).toEqual(summarizeP1cTurns(seeded.turns));

      const failureMs = Date.parse(log.closedAt ?? "");
      const enteredMs = Date.parse(log.enteredAt);
      const nextMs = Date.parse(item?.nextAttemptAt ?? "");
      const deltaMs = nextMs - failureMs;

      console.log(
        "[p1c-net] nextAttemptAt",
        item?.nextAttemptAt,
        "closedAt",
        log.closedAt,
        "deltaMs",
        deltaMs,
      );
      expect(Number.isNaN(enteredMs)).toBe(false);
      expect(Number.isNaN(failureMs)).toBe(false);
      expect(failureMs).toBeGreaterThanOrEqual(enteredMs);
      expect(deltaMs).toBeGreaterThanOrEqual(50_000);
      expect(deltaMs).toBeLessThanOrEqual(70_000);

      const matches = session.consolidateLogs.filter(
        (entry) => entry.batchId === seeded.batchId,
      );

      expect(matches).toHaveLength(1);
      expect(session.consolidateLogs).toHaveLength(1);
      expect(log.outcome).toBe("disconnected");
      expect(log.responseStatus).toBeNull();
      expect(log.payloadHash).toBe(seeded.payloadHash);
      expect(session.unexpectedLogs).toHaveLength(0);
    } catch (error) {
      failure = error;
    } finally {
      await finishP1cTest({
        failure,
        cleanup: p1cCleanup,
        page,
        context,
        session,
        batchIds: [batchId],
      });
    }
  });
});
