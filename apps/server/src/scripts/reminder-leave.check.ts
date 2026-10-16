import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  assertOfflineDbIsolated,
  cleanupOfflineDb,
  prepareOfflineDb,
} from "./offlineDb.ts";

/**
 * D2：reminder leave 不得覆盖未听完 aside；听完或过期后可继续 leave。
 * 使用临时库 + AsideStore，不碰生产 companion.db。
 */

const file = prepareOfflineDb("reminder-leave-");
await assertOfflineDbIsolated(file);

const setup = new Database(file);
setup.exec(`
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
  CREATE TABLE companion_voice (
    id text PRIMARY KEY NOT NULL,
    left_at text NOT NULL
  );
`);
setup.close();

const { AsideStore } = await import("../companion/AsideStore");
const {
  ASIDE_GAP_MS,
  dueReminderLine,
  shouldProtectUnheardAside,
} = await import("../companion/aside");

const store = new AsideStore();
const now = Date.now();

const firstLeftAt = new Date(now - 60_000).toISOString();
store.leave({
  text: "面试那件，我还放着。结果还没出来。",
  leftAt: firstLeftAt,
  matterKey: "unresolved:面试",
  matterRevision: "rev-1",
});

const current = store.current();
assert.ok(current);
assert.equal(current.heard, false);
assert.equal(
  shouldProtectUnheardAside({ current, nowMs: now }),
  true,
);

// 模拟 GET leave：受保护时不得 leave 覆盖
if (
  !shouldProtectUnheardAside({
    current: store.current(),
    nowMs: now,
  })
) {
  store.leave({
    text: dueReminderLine("交报告") ?? "交报告的时间到了。",
    leftAt: new Date(now).toISOString(),
    matterKey: "due:report",
    matterRevision: "rev-due",
  });
}

assert.equal(store.current()?.text, "面试那件，我还放着。结果还没出来。");
assert.equal(store.current()?.matterKey, "unresolved:面试");

// 语音连上后 markHeard → 可被提醒替换
store.markHeard();
assert.equal(store.current()?.heard, true);
assert.equal(
  shouldProtectUnheardAside({
    current: store.current(),
    nowMs: now,
  }),
  false,
);

const reminderLine = dueReminderLine("交报告");
assert.ok(reminderLine);

store.leave({
  text: reminderLine,
  leftAt: new Date(now).toISOString(),
  matterKey: "due:report",
  matterRevision: "rev-due",
});
assert.equal(store.current()?.text, reminderLine);
assert.equal(store.current()?.matterKey, "due:report");

// 过期未听完：允许替换（休息/未连语音也不会永久饿死提醒）
store.leave({
  text: "旧留言。",
  leftAt: new Date(now - ASIDE_GAP_MS - 1_000).toISOString(),
  matterKey: "unresolved:旧",
  matterRevision: "old",
});
// 直接写成 unheard
const row = new Database(file);
row.prepare(
  "UPDATE companion_asides SET heard = 'false' WHERE id = 'current'",
).run();
row.close();

const stale = store.current();
assert.ok(stale);
assert.equal(stale.heard, false);
assert.equal(
  shouldProtectUnheardAside({ current: stale, nowMs: now }),
  false,
);

store.leave({
  text: reminderLine,
  leftAt: new Date(now).toISOString(),
  matterKey: "due:report2",
  matterRevision: "rev-due-2",
});
assert.equal(store.current()?.matterKey, "due:report2");

cleanupOfflineDb(file);
console.log("[reminder-leave] unheard protect and eventual delivery ok");
