import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import {
  assertOfflineDbIsolated,
  cleanupOfflineDb,
  prepareOfflineDb,
} from "./offlineDb.ts";

/**
 * 租约安全：挂载生产 settleReminderFromBody / claimQueuedReminder，临时库。
 */

const file = prepareOfflineDb("reminder-claim-");
await assertOfflineDbIsolated(file);

const setup = new Database(file);
setup.exec(`
  CREATE TABLE tasks (
    id text PRIMARY KEY NOT NULL,
    title text NOT NULL,
    description text DEFAULT '' NOT NULL,
    status text NOT NULL,
    due_at text,
    reminder_at text,
    reminder_sent text NOT NULL,
    created_at text NOT NULL,
    updated_at text NOT NULL
  );
  CREATE TABLE companion_asides (
    id text PRIMARY KEY NOT NULL,
    body text NOT NULL,
    left_at text NOT NULL,
    matter_key text NOT NULL,
    matter_revision text NOT NULL,
    heard text DEFAULT 'false' NOT NULL
  );
  CREATE TABLE companion_aside_spoken (
    matter_key text NOT NULL,
    matter_revision text NOT NULL,
    spoken_at text NOT NULL,
    PRIMARY KEY (matter_key, matter_revision)
  );
`);
const now = new Date().toISOString();
setup
  .prepare(
    `INSERT INTO tasks (id, title, status, due_at, reminder_at, reminder_sent, created_at, updated_at)
     VALUES (?, ?, 'pending', ?, ?, 'queued', ?, ?)`,
  )
  .run("task-1", "交报告", now, now, now, now);
setup.close();

const { db } = await import("../db");
const { tasks } = await import("../db/schema");
const { asideStore } = await import("../companion/AsideStore");
const {
  claimQueuedReminder,
  settleReminderFromBody,
} = await import("../companion/reminderLease");

function rowOf(id: string) {
  return db.select().from(tasks).where(eq(tasks.id, id)).get();
}

function reclaimToQueued(id: string): void {
  db.update(tasks)
    .set({
      reminderSent: "queued",
      updatedAt: new Date().toISOString(),
    })
    .where(eq(tasks.id, id))
    .run();
}

const app = express();
app.use(express.json());

app.post("/api/tasks/reminders/settle", (req, res) => {
  const result = settleReminderFromBody(req.body);
  res.status(result.status).json(result.json);
});

const server = http.createServer(app);
await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve());
});
const address = server.address();
if (address === null || typeof address === "string") {
  throw new Error("bind failed");
}
const base = `http://127.0.0.1:${address.port}`;

async function settle(body: unknown) {
  const response = await fetch(`${base}/api/tasks/reminders/settle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    json: (await response.json()) as {
      success?: boolean;
      stale?: boolean;
      deferred?: boolean;
    },
  };
}

// --- 合法领取 ---
const claimA = claimQueuedReminder("task-1", "speaking");
assert.ok(claimA);
assert.equal(rowOf("task-1")?.reminderSent, "speaking");
assert.equal(rowOf("task-1")?.updatedAt, claimA);

// --- speaking + 无 claimedAt → 409，状态不变 ---
{
  const before = rowOf("task-1");
  const res = await settle({ id: "task-1", heard: true });
  assert.equal(res.status, 409);
  assert.equal(res.json.stale, true);
  const after = rowOf("task-1");
  assert.equal(after?.reminderSent, "speaking");
  assert.equal(after?.updatedAt, before?.updatedAt);
}

// --- 回收为 queued 后，旧领取者不能完成 ---
reclaimToQueued("task-1");
assert.equal(rowOf("task-1")?.reminderSent, "queued");
{
  const res = await settle({
    id: "task-1",
    heard: true,
    claimedAt: claimA,
  });
  assert.equal(res.status, 409);
  assert.equal(res.json.stale, true);
  assert.equal(rowOf("task-1")?.reminderSent, "queued");
}

// --- 他页重领后，旧 claimedAt finish / deferred 均不能改新租约 ---
const claimB = claimQueuedReminder("task-1", "speaking");
assert.ok(claimB);
assert.notEqual(claimA, claimB);

{
  const res = await settle({
    id: "task-1",
    heard: true,
    claimedAt: claimA,
  });
  assert.equal(res.status, 409);
  assert.equal(rowOf("task-1")?.reminderSent, "speaking");
  assert.equal(rowOf("task-1")?.updatedAt, claimB);
}

asideStore.leave({
  text: "未听完的留言挡着。",
  leftAt: new Date().toISOString(),
  matterKey: "unresolved:挡",
  matterRevision: "r1",
});
assert.equal(asideStore.current()?.heard, false);

{
  const res = await settle({
    id: "task-1",
    heard: false,
    claimedAt: claimA,
  });
  assert.equal(res.status, 409);
  assert.equal(rowOf("task-1")?.reminderSent, "speaking");
  assert.equal(rowOf("task-1")?.updatedAt, claimB);
}

// --- 校验与更新之间插入并发重领：条件 UPDATE 失败 ---
{
  const claimC = claimB;
  // 模拟「已读到旧租约」后、条件 UPDATE 前被重领
  reclaimToQueued("task-1");
  const claimD = claimQueuedReminder("task-1", "speaking");
  assert.ok(claimD);
  assert.notEqual(claimC, claimD);

  const res = settleReminderFromBody({
    id: "task-1",
    heard: true,
    claimedAt: claimC,
  });
  assert.equal(res.status, 409);
  assert.equal(res.json.stale, true);
  assert.equal(rowOf("task-1")?.reminderSent, "speaking");
  assert.equal(rowOf("task-1")?.updatedAt, claimD);

  // 合法新领取者可完成
  const ok = settleReminderFromBody({
    id: "task-1",
    heard: true,
    claimedAt: claimD,
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.success, true);
  assert.equal(rowOf("task-1")?.reminderSent, "true");
}

// --- 幂等：已完成后重复 settle（可无 claimedAt）---
{
  const again = await settle({ id: "task-1", heard: false });
  assert.equal(again.status, 200);
  assert.equal(again.json.success, true);
  assert.equal(rowOf("task-1")?.reminderSent, "true");
}

// --- deferred：合法租约可退回 queued；旧租约不可（新任务，避免 hasSpoken 短路）---
{
  const t = new Date().toISOString();
  db.insert(tasks)
    .values({
      id: "task-2",
      title: "开会",
      description: "",
      status: "pending",
      dueAt: t,
      reminderAt: t,
      reminderSent: "queued",
      createdAt: t,
      updatedAt: t,
    })
    .run();
}

const claimE = claimQueuedReminder("task-2", "speaking");
assert.ok(claimE);
assert.equal(asideStore.current()?.heard, false);

{
  const deferred = settleReminderFromBody({
    id: "task-2",
    heard: false,
    claimedAt: claimE,
  });
  assert.equal(deferred.status, 200);
  assert.equal(deferred.json.deferred, true);
  assert.equal(rowOf("task-2")?.reminderSent, "queued");
}

const claimF = claimQueuedReminder("task-2", "speaking");
assert.ok(claimF);
{
  const staleDefer = settleReminderFromBody({
    id: "task-2",
    heard: false,
    claimedAt: claimE,
  });
  assert.equal(staleDefer.status, 409);
  assert.equal(rowOf("task-2")?.updatedAt, claimF);
}

server.close();
cleanupOfflineDb(file);
console.log("[reminder-claim] atomic lease + missing claimedAt rejected ok");
