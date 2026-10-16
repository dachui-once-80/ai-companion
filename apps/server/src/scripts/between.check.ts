import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { prepareOfflineDb } from "./offlineDb.ts";

const file = prepareOfflineDb("between-");

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

const { classifyBetweenNote, rejectedBetween } = await import("../memory/between");
const {
  applyConsolidation,
  consolidateConversation,
  consolidationResponseSchema,
  parseConsolidationResult,
} = await import("../memory/consolidate");
const { MemoryManager } = await import("../memory/MemoryManager");
const { MemoryStore } = await import("../memory/MemoryStore");
const { ThoughtStore } = await import("../companion/ThoughtStore");

assert.equal(classifyBetweenNote("我叫张三，这是我的名字"), null);
assert.equal(classifyBetweenNote("她叫我明天交报告"), null);
assert.equal(classifyBetweenNote("以后你就叫我阿远")?.kind, "address");
assert.equal(
  classifyBetweenNote("我烦的时候你先听我说完，别急着给办法")?.kind,
  "listen",
);
assert.equal(
  rejectedBetween("人设", "用户要求她换说话方式，变成另一个人"),
  true,
);
assert.equal(
  rejectedBetween("身体", "阿七的身体最近不舒服，她答应休息"),
  true,
);

const today = "2026-10-15";
const raw = JSON.stringify({
  episodes: [
    {
      date: today,
      content: "她叫用户阿远，这是你们的称呼",
      importance: "medium",
    },
  ],
  impressions: [
    {
      theme: "称呼",
      content: "她叫用户阿远，这是你们的称呼",
      importance: "medium",
    },
  ],
  retireImpressions: [],
  notes: [
    {
      label: "称呼",
      content: "她叫用户阿远，这是你们的称呼",
      importance: "high",
    },
    {
      label: "姓名",
      content: "我叫张三，这是我的名字",
      importance: "medium",
    },
    {
      label: "倾听",
      content: "我烦的时候你先听我说完，别急着给办法",
      importance: "high",
    },
  ],
  profile: [
    { key: "user_name", content: "用户阿远", importance: "high" },
    { key: "user_name", content: "用户姓名张三", importance: "high" },
  ],
  between: [
    {
      kind: "address",
      about: "叫用户",
      content: "她叫用户阿远，这是你们的称呼",
      importance: "high",
    },
    {
      kind: "address",
      about: "人设",
      content: "用户要求她换说话方式，变成另一个人",
      importance: "high",
    },
    {
      kind: "promise",
      about: "身体",
      content: "阿七的身体最近不舒服，她答应休息",
      importance: "medium",
    },
    {
      kind: "joke",
      about: "冷笑话",
      content: "那句冷笑话成了你们的梗",
      importance: "medium",
    },
    {
      kind: "promise",
      about: "周末提醒",
      content: "她答应周末提醒交报告，还没提醒",
      importance: "medium",
    },
    {
      kind: "hold",
      about: "工作选择",
      content: "用户谈工作选择时，不能先给建议",
      importance: "high",
    },
  ],
  resolveBetween: [],
  views: [],
  unresolved: [],
  resolveUnresolved: [],
  question: [],
  resolveQuestion: [],
});

const memory = new MemoryManager(new MemoryStore());
const thoughts = new ThoughtStore();
const plan = parseConsolidationResult(raw, today);

assert.equal(
  plan.between.some((item) => item.content.includes("换说话方式")),
  false,
);
assert.equal(
  plan.between.some((item) => item.content.includes("阿七的身体")),
  false,
);
assert.equal(
  plan.notes.some((item) => item.content.includes("阿远")),
  false,
);
assert.equal(
  plan.notes.some((item) => item.content.includes("先听我说完")),
  false,
);
assert.equal(
  plan.between.some((item) => item.kind === "listen"),
  true,
);

applyConsolidation(memory, thoughts, plan);

for (let index = 0; index < 5; index += 1) {
  memory.saveBetween(
    "joke",
    `梗${index + 1}`,
    `第${index + 1}句内部笑话先记着，聊到才用`,
    "low",
  );
}

const current = memory.getAll().filter((item) => item.status === "current");
const betweenRows = current.filter((item) => item.category === "between");

assert.ok(betweenRows.length > 6, `stored ${betweenRows.length}, want more than 6`);

const ayuan = current.filter((item) => item.content.includes("阿远"));
assert.ok(ayuan.length >= 1);
assert.ok(
  ayuan.every((item) => item.category === "between"),
  ayuan.map((item) => `${item.category}:${item.key}:${item.content}`).join(" | "),
);

const next = memory.renderBetween();
const context = memory.getContext();
const joined = `## 当前用户长期记忆\n${context}\n\n## 我们之间\n${next}`;

assert.match(section(joined, "我们之间"), /阿远/);
assert.match(section(joined, "我们之间"), /先听/);
assert.doesNotMatch(section(joined, "我们之间"), /冷笑话/);
assert.doesNotMatch(section(joined, "我们之间"), /交报告/);
assert.doesNotMatch(section(joined, "档案"), /阿远/);
assert.doesNotMatch(section(joined, "你决定留下的事"), /阿远/);
assert.match(section(joined, "档案"), /用户姓名张三/);
assert.match(section(joined, "你决定留下的事"), /张三/);
assert.ok(section(joined, "我们之间").split("\n").filter((line) => line.startsWith("- ")).length <= 4);

assert.match(memory.renderBetween("那句冷笑话"), /冷笑话/);
assert.doesNotMatch(memory.renderBetween("今天天气怎么样"), /冷笑话/);
assert.match(memory.renderBetween("周末提醒交报告"), /交报告/);
assert.equal(memory.renderBetweenTopic("今天天气怎么样"), "");
assert.match(memory.renderBetweenTopic("周末提醒"), /交报告/);

const closed = parseConsolidationResult(
  JSON.stringify({
    episodes: [],
    impressions: [],
    retireImpressions: [],
    notes: [],
    profile: [],
    between: [],
    resolveBetween: [{ kind: "promise", about: "周末提醒" }],
    views: [],
    unresolved: [],
    resolveUnresolved: [],
    question: [],
    resolveQuestion: [],
  }),
  today,
);
const closedSaved = applyConsolidation(memory, thoughts, closed);

assert.ok(closedSaved.saved.closedBetween >= 1);
assert.doesNotMatch(memory.renderBetween("周末提醒交报告"), /交报告/);

console.log("[between] pipeline ok");
console.log(next);

memory.clear();

function section(text: string, title: string): string {
  const start = text.indexOf(`## ${title}`);

  if (start < 0) return "";

  const rest = text.slice(start);
  const nextHeading = rest.indexOf("\n## ", 1);

  return nextHeading < 0 ? rest : rest.slice(0, nextHeading);
}

export async function runLive(): Promise<void> {
  if (process.env.COMPANION_LIVE_SKIP_DOTENV !== "1") {
    const dotenv = await import("dotenv");
    dotenv.config({ path: new URL("../../.env", import.meta.url).pathname });
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim();

  if (!apiKey) {
    console.error("[between] live precondition not met: GEMINI_API_KEY is missing");
    process.exit(1);
  }

  const store = memory;
  const thoughtStore = thoughts;

  const proxy = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || "http://127.0.0.1:1082";

  if (proxy !== "off" && proxy !== "false") {
    const { ProxyAgent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new ProxyAgent(proxy));
  }

  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { apiVersion: "v1alpha" },
  });

  const turns = [
    {
      role: "user" as const,
      text: "以后你就叫我阿远。我要是在说烦心事，你先听我说完，别急着给我出主意。这是我们之间的约定。",
    },
    {
      role: "companion" as const,
      text: "好，阿远。你说烦心事的时候，我先听完。",
    },
  ];

  const result = await consolidateConversation({
    body: { occurredOn: today, turns },
    memory: store,
    thoughts: thoughtStore,
    generate: async (prompt) => {
      const response = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: prompt,
        config: {
          temperature: 0.2,
          responseMimeType: "application/json",
          responseJsonSchema: consolidationResponseSchema,
        },
      });
      const text = response.text?.trim();

      if (!text) throw new Error("Empty consolidation response");

      return text;
    },
  });

  const between = store.renderBetween();
  const memoryContext = store.getContext();
  const prompt = `## 当前用户长期记忆\n${memoryContext}\n\n## 我们之间\n${between}`;
  const kept = store.getAll().filter((item) => item.status === "current");
  const named = kept.filter((item) => item.content.includes("阿远"));

  console.log("[between] live saved", result.saved);
  console.log("[between] live rows");

  for (const item of kept) {
    console.log(`- ${item.category} ${item.key}: ${item.content}`);
  }

  console.log("[between] next connection 我们之间");
  console.log(between);

  assert.ok(named.length >= 1, "live consolidation did not keep 阿远");
  assert.equal(
    named.filter((item) => item.key === "user_name").length,
    0,
    named.map((item) => `${item.category}:${item.key}:${item.content}`).join(" | "),
  );
  assert.ok(
    named.some(
      (item) => item.category === "between" || item.key === "preferred_address",
    ),
    named.map((item) => `${item.category}:${item.key}:${item.content}`).join(" | "),
  );
  assert.match(prompt, /阿远/);
  assert.doesNotMatch(section(prompt, "你决定留下的事"), /阿远/);
  assert.match(prompt, /听/);

  console.log("[between] live ok");
}
