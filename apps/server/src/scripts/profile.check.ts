import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  explicitWhenSad,
  normalizeImportantDate,
  parseImportantDate,
} from "../memory/profileFacts";

assert.equal(explicitWhenSad("我难过时先别给建议"), "难过时先别给建议");
assert.equal(explicitWhenSad("如果我难过时先别给建议"), null);
assert.equal(explicitWhenSad("开玩笑，我难过时先别给建议"), null);
assert.equal(explicitWhenSad("我朋友难过时先别给建议"), null);
assert.equal(explicitWhenSad("他说他难过时不想听建议"), null);
assert.equal(normalizeImportantDate("下周三考试"), null);
assert.equal(normalizeImportantDate("2026年6月7日考研"), "2026-06-07 考研");
assert.equal(
  normalizeImportantDate("每年6月7日结婚纪念日"),
  "每年 06-07 结婚纪念日",
);
assert.equal(normalizeImportantDate("6月7日考试"), "06-07 考试");
assert.deepEqual(parseImportantDate("2026-06-07 考研"), {
  date: "2026-06-07",
  yearly: false,
  label: "考研",
});
assert.deepEqual(parseImportantDate("每年 06-07 结婚纪念日"), {
  date: "06-07",
  yearly: true,
  label: "结婚纪念日",
});

const dir = mkdtempSync(join(tmpdir(), "profile-"));
const file = join(dir, "companion.db");
process.env.COMPANION_DB = file;

const sqlite = new Database(file);
sqlite.exec(`
  CREATE TABLE memories (
    id text PRIMARY KEY NOT NULL,
    category text NOT NULL,
    key text NOT NULL DEFAULT 'unknown',
    content text NOT NULL,
    importance text NOT NULL,
    status text NOT NULL DEFAULT 'current',
    source text NOT NULL DEFAULT 'user',
    created_at text NOT NULL,
    updated_at text NOT NULL
  );
  CREATE TABLE companion_thoughts (
    id text PRIMARY KEY NOT NULL,
    kind text NOT NULL,
    content text NOT NULL,
    about text NOT NULL DEFAULT '',
    created_at text NOT NULL,
    updated_at text NOT NULL
  );
`);
sqlite.close();

const { consolidateConversation } = await import("../memory/consolidate");
const { MemoryManager } = await import("../memory/MemoryManager");
const { MemoryStore } = await import("../memory/MemoryStore");
const { ThoughtStore } = await import("../companion/ThoughtStore");
const { listMemoryKeys } = await import("../memory/MemoryPolicy");

const keys = new Set(listMemoryKeys().map((item) => item.key));
for (const key of [
  "when_sad",
  "preferred_address",
  "daily_routine",
  "current_activity",
  "avoid_topic",
  "important_date",
]) {
  assert.ok(keys.has(key), `missing policy key ${key}`);
}

const client = readFileSync(
  new URL("../../../web/src/realtime/RealtimeClient.ts", import.meta.url),
  "utf8",
);
assert.match(client, /name: "remember_memory"/);
assert.match(client, /when_sad/);
assert.match(client, /preferred_address/);
assert.match(client, /daily_routine/);
assert.match(client, /current_activity/);
assert.match(client, /avoid_topic/);
assert.match(client, /important_date/);
assert.match(client, /YYYY-MM-DD/);
assert.match(client, /每年 MM-DD/);
assert.match(client, /没说出口的不要推断/);

const memory = new MemoryManager(new MemoryStore());
const thoughts = new ThoughtStore();

const remembered = memory.remember({
  key: "when_sad",
  category: "preference",
  content: "难过时先别给建议",
  importance: "high",
  source: "user",
});
assert.equal(remembered.action, "created");

const dated = memory.remember({
  key: "important_date",
  category: "event",
  content: "2026年6月7日考研",
  importance: "medium",
  source: "user",
});
assert.equal(dated.memory.content, "2026-06-07 考研");
assert.deepEqual(memory.listImportantDates(), [
  { date: "2026-06-07", yearly: false, label: "考研" },
]);

assert.throws(
  () =>
    memory.remember({
      key: "important_date",
      category: "event",
      content: "考试快到了",
      importance: "medium",
      source: "user",
    }),
  /readable date/,
);
assert.throws(
  () =>
    memory.remember({
      key: "when_sad",
      category: "preference",
      content: "如果我难过时先别给建议",
      importance: "high",
      source: "user",
    }),
  /unstated/i,
);

const afterRemember = nextConnection(memory);
assert.match(section(afterRemember, "档案"), /when_sad: 难过时先别给建议/);
assert.match(afterRemember, /难过时按这一条来/);
assert.match(section(afterRemember, "档案"), /2026-06-07 考研/);

memory.clear();

const today = "2026-10-15";
let prompt = "";
const consolidated = await consolidateConversation({
  body: {
    occurredOn: today,
    turns: [
      { role: "user", text: "我难过时先别给建议" },
      { role: "companion", text: "好，你难过的时候我先听着。" },
    ],
  },
  memory,
  thoughts,
  generate: async (text) => {
    prompt = text;
    return JSON.stringify({
      ...emptyPlan(),
      between: [
        {
          kind: "hold",
          about: "难过",
          content: "用户难过时先别给建议",
          importance: "high",
        },
      ],
      notes: [
        {
          label: "陪伴",
          content: "我难过时先别给建议",
          importance: "high",
        },
      ],
    });
  },
});

assert.match(prompt, /when_sad/);
assert.match(prompt, /preferred_address/);
assert.match(prompt, /daily_routine/);
assert.match(prompt, /current_activity/);
assert.match(prompt, /avoid_topic/);
assert.match(prompt, /important_date/);
assert.match(prompt, /YYYY-MM-DD/);
assert.match(prompt, /每年 MM-DD/);
assert.match(prompt, /没说出口的不要推断/);
assert.match(prompt, /假设、玩笑、转述别人/);
assert.equal(consolidated.saved.profile, 1);
assert.equal(consolidated.saved.between, 0);

const current = memory.getAll().filter((item) => item.status === "current");
const sad = current.filter((item) => item.key === "when_sad");
assert.equal(sad.length, 1);
assert.equal(sad[0]?.content, "难过时先别给建议");
assert.equal(
  current.some((item) => item.category === "between" && /先别给建议/.test(item.content)),
  false,
);

const afterConsolidate = nextConnection(memory);
assert.match(section(afterConsolidate, "档案"), /when_sad: 难过时先别给建议/);
assert.match(afterConsolidate, /when_sad 是用户难过时想被听还是想要办法/);
assert.doesNotMatch(section(afterConsolidate, "我们之间"), /先别给建议/);

memory.clear();

await consolidateConversation({
  body: {
    occurredOn: today,
    turns: [
      { role: "user", text: "如果我难过时先别给建议" },
      { role: "companion", text: "那只是如果。" },
    ],
  },
  memory,
  thoughts,
  generate: async () =>
    JSON.stringify({
      ...emptyPlan(),
      profile: [
        {
          key: "when_sad",
          content: "难过时先别给建议",
          importance: "high",
        },
      ],
    }),
});
assert.equal(
  memory.getAll().filter((item) => item.key === "when_sad").length,
  0,
);

await consolidateConversation({
  body: {
    occurredOn: today,
    turns: [
      { role: "user", text: "我朋友难过时先别给建议，你记一下" },
      { role: "companion", text: "那是他的事。" },
    ],
  },
  memory,
  thoughts,
  generate: async () =>
    JSON.stringify({
      ...emptyPlan(),
      profile: [
        {
          key: "when_sad",
          content: "难过时先别给建议",
          importance: "high",
        },
      ],
    }),
});
assert.equal(
  memory.getAll().filter((item) => item.key === "when_sad").length,
  0,
);

const keptDate = await consolidateConversation({
  body: {
    occurredOn: today,
    turns: [
      { role: "user", text: "我每年6月7日有个结婚纪念日" },
      { role: "companion", text: "我记下这个日子。" },
    ],
  },
  memory,
  thoughts,
  generate: async () =>
    JSON.stringify({
      ...emptyPlan(),
      profile: [
        {
          key: "important_date",
          content: "每年6月7日结婚纪念日",
          importance: "high",
        },
      ],
    }),
});
assert.equal(keptDate.saved.profile, 1);
assert.deepEqual(memory.listImportantDates(), [
  { date: "06-07", yearly: true, label: "结婚纪念日" },
]);

console.log("[profile] archive fields ok");
console.log(section(afterConsolidate, "档案"));

function nextConnection(store: InstanceType<typeof MemoryManager>): string {
  return `## 当前用户长期记忆\n${store.getContext()}\n\n## 我们之间\n${store.renderBetween()}`;
}

function section(text: string, title: string): string {
  const start = text.indexOf(`## ${title}`);

  if (start < 0) return "";

  const rest = text.slice(start);
  const nextHeading = rest.indexOf("\n## ", 1);

  return nextHeading < 0 ? rest : rest.slice(0, nextHeading);
}

function emptyPlan() {
  return {
    episodes: [],
    impressions: [],
    retireImpressions: [],
    notes: [],
    profile: [],
    between: [],
    resolveBetween: [],
    views: [],
    unresolved: [],
    resolveUnresolved: [],
    question: [],
    resolveQuestion: [],
  };
}
