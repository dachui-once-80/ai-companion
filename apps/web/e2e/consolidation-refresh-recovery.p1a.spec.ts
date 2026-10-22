/**
 * P1-A：专用 Playwright profile 下 localStorage outbox 刷新恢复。
 * - 使用生产 ConsolidationOutbox + 默认 storage key
 * - 不启动 Vite App／Live／麦克风；刷新不会加载 RealtimeClient → 不触发 drain
 * - P0 fail-closed 拦截：allowExpectedPost=false；断言 mockHits===0
 * - 不读 .env／token；不碰正式库／日常 profile
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import {
  ConsolidationOutbox,
  CONSOLIDATION_OUTBOX_STORAGE_KEY,
  createMemoryOutboxStorage,
  type ConsolidationOutboxItem,
} from "../src/realtime/consolidationOutbox.ts";
import { computeConsolidationPayloadHash } from "../src/realtime/consolidationPayload.ts";
import {
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
  "p1a-refresh-recovery",
);

const OCCURRED_ON = "2026-10-20";
const TURNS = [
  { role: "user" as const, text: "p1a refresh probe remember this uniquely" },
  { role: "companion" as const, text: "p1a noted in isolated profile only" },
];

/** 冻结／状态字段摘要（无秘密）。 */
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

async function readOutboxRawFromPage(page: Page): Promise<string | null> {
  return page.evaluate(
    (key) => localStorage.getItem(key),
    CONSOLIDATION_OUTBOX_STORAGE_KEY,
  );
}

async function writeOutboxRawToPage(page: Page, raw: string): Promise<void> {
  await page.evaluate(
    ({ key, value }) => {
      localStorage.setItem(key, value);
    },
    { key: CONSOLIDATION_OUTBOX_STORAGE_KEY, value: raw },
  );
}

function outboxFromRaw(raw: string, nowIso: string): ConsolidationOutbox {
  const storage = createMemoryOutboxStorage({
    [CONSOLIDATION_OUTBOX_STORAGE_KEY]: raw,
  });
  return new ConsolidationOutbox({ storage, now: () => nowIso });
}

test.describe.configure({ mode: "serial" });

test.describe("P1-A outbox refresh recovery (storage only)", () => {
  let stub: StubOrigin;
  let context: BrowserContext;
  let page: Page;
  let state: FailClosedIntercept;
  let profileDir: string;
  let batchId: string;
  let fixedNow: string;
  let beforeSummary: ReturnType<typeof summarizeItem>;
  let evidence: {
    batchId: string;
    before: ReturnType<typeof summarizeItem>;
    after: ReturnType<typeof summarizeItem> | null;
    mockHits: number;
    blockedHits: number;
    stubLeaks: number;
  };

  test.beforeAll(async () => {
    fs.mkdirSync(PROFILE_ROOT, { recursive: true });
    profileDir = fs.mkdtempSync(path.join(PROFILE_ROOT, "run-"));
    stub = await startStubOrigin();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    batchId = `p1a-refresh-${stamp}-0001`;
    fixedNow = "2026-10-20T14:28:00.000Z";
  });

  test.afterAll(async () => {
    await stub?.close().catch(() => undefined);
  });

  test.beforeEach(async () => {
    // P1-A：禁止任何预期 mock 成功路径；consolidate 一律 abort
    state = createInterceptState({ allowExpectedPost: false });
    context = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      serviceWorkers: "block",
    });
    page = context.pages()[0] ?? (await context.newPage());
  });

  test.afterEach(async () => {
    await context?.close().catch(() => undefined);
  });

  test("T1-T3: write via ConsolidationOutbox, reload, freeze+state match, zero consolidate", async () => {
    await installFailClosedConsolidateIntercept(context, state);
    await gotoOnlyIfInterceptReady(page, state, stub.origin);

    // 空 profile：默认 key 应不存在
    const preExisting = await readOutboxRawFromPage(page);
    expect(preExisting).toBeNull();

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
    expect(seeded.batchId).toBe(batchId);
    expect(seeded.batchId.startsWith("p1a-refresh-")).toBe(true);

    const rawBefore = mem.getItem(CONSOLIDATION_OUTBOX_STORAGE_KEY);
    expect(rawBefore).toBeTruthy();
    await writeOutboxRawToPage(page, rawBefore!);

    beforeSummary = summarizeItem(seeded);
    // eslint-disable-next-line no-console
    console.log("[p1a] before summary", JSON.stringify(beforeSummary));

    expect(state.mockHits).toBe(0);
    expect(state.blockedHits).toBe(0);
    expect(stub.consolidateLeaks.count).toBe(0);

    // 同 context／同 origin 刷新（stub 页无 App → 无 connect-drain）
    await page.reload({ waitUntil: "domcontentloaded" });

    expect(state.mockHits).toBe(0);
    expect(state.blockedHits).toBe(0);
    expect(stub.consolidateLeaks.count).toBe(0);
    expect(state.logs.filter((l) => l.url.includes("/api/memory/consolidate")))
      .toHaveLength(0);

    const rawAfter = await readOutboxRawFromPage(page);
    expect(rawAfter).toBeTruthy();
    expect(rawAfter).toBe(rawBefore);

    const reader = outboxFromRaw(rawAfter!, fixedNow);
    const recovered = reader.get(batchId);
    expect(recovered).not.toBeNull();
    const afterSummary = summarizeItem(recovered!);
    // eslint-disable-next-line no-console
    console.log("[p1a] after summary", JSON.stringify(afterSummary));

    // 冻结字段
    expect(recovered!.batchId).toBe(beforeSummary.batchId);
    expect(recovered!.payloadHash).toBe(beforeSummary.payloadHash);
    expect(recovered!.occurredOn).toBe(beforeSummary.occurredOn);
    expect(recovered!.turns).toEqual(beforeSummary.turns);

    // 状态字段（写入后未 drain → 应与写入时一致）
    expect(recovered!.status).toBe("pending");
    expect(recovered!.attempts).toBe(beforeSummary.attempts);
    expect(recovered!.leaseOwner).toBe(beforeSummary.leaseOwner);
    expect(recovered!.leaseExpiresAt).toBe(beforeSummary.leaseExpiresAt);
    expect(recovered!.nextAttemptAt).toBe(beforeSummary.nextAttemptAt);
    expect(recovered!.lastError).toBe(beforeSummary.lastError);
    expect(recovered!.createdAt).toBe(beforeSummary.createdAt);
    expect(recovered!.updatedAt).toBe(beforeSummary.updatedAt);

    evidence = {
      batchId,
      before: beforeSummary,
      after: afterSummary,
      mockHits: state.mockHits,
      blockedHits: state.blockedHits,
      stubLeaks: stub.consolidateLeaks.count,
    };
    expect(evidence.mockHits).toBe(0);
    expect(evidence.stubLeaks).toBe(0);

    // 仅删除本次可识别 batchId（证据已断言完毕；不整 key 盲清）
    const cleanupMem = createMemoryOutboxStorage({
      [CONSOLIDATION_OUTBOX_STORAGE_KEY]: rawAfter!,
    });
    const cleanupBox = new ConsolidationOutbox({
      storage: cleanupMem,
      now: () => fixedNow,
    });
    const target = cleanupBox.get(batchId);
    expect(target?.batchId.startsWith("p1a-refresh-")).toBe(true);
    cleanupBox.remove(batchId);
    expect(cleanupBox.get(batchId)).toBeNull();

    const remaining = cleanupBox.list();
    if (remaining.length === 0) {
      await page.evaluate(
        (key) => localStorage.removeItem(key),
        CONSOLIDATION_OUTBOX_STORAGE_KEY,
      );
    } else {
      const nextRaw = cleanupMem.getItem(CONSOLIDATION_OUTBOX_STORAGE_KEY);
      expect(nextRaw).toBeTruthy();
      await writeOutboxRawToPage(page, nextRaw!);
    }

    const postCleanup = await readOutboxRawFromPage(page);
    if (postCleanup) {
      const leftover = outboxFromRaw(postCleanup, fixedNow);
      expect(leftover.get(batchId)).toBeNull();
    }
  });
});

test("P1-A profile path is under project .playwright (not daily Chrome)", () => {
  const resolved = path.resolve(PROFILE_ROOT);
  expect(resolved.includes(`${path.sep}.playwright${path.sep}`)).toBe(true);
  expect(resolved.startsWith(path.resolve(os.homedir(), "Library"))).toBe(
    false,
  );
});
