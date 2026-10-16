import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { MeaningDeps } from "../memory/meaning";
import { prepareOfflineDb } from "./offlineDb.ts";

const file = prepareOfflineDb("meaning-");

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

const { clearMeaningCache } = await import("../memory/meaning");
const { MemoryManager } = await import("../memory/MemoryManager");
const { MemoryStore } = await import("../memory/MemoryStore");
const { ThoughtStore } = await import("../companion/ThoughtStore");

const SAMPLE =
  "用户因为样本明早六点失效，今晚需要熬夜赶工交出数据，以避免三个月心血重来。";
const RUSH = "这周一直在赶项目";
const VIEW =
  "如果是为了挽救几个月的心血且只熬这一次，那这种熬夜赶工绝对是值得的。";

const store = new MemoryStore();
const thoughts = new ThoughtStore();
const memory = new MemoryManager(store, thoughts, fakeMeaning());

seed(memory, thoughts);

const context = memory.getContext();
const episodeSection = section(context, "最近发生的事");
const episodeLines = episodeSection.split("\n").filter((line) => line.startsWith("- "));

assert.ok(episodeLines.length <= 8, `fixed slice has ${episodeLines.length} episodes`);
assert.equal(context.includes(RUSH), false);
assert.match(episodeSection, /样本/);

const overtime = await memory.recall({ query: "加班", scope: "current" });
assert.ok(overtime.some((item) => item.content.includes(RUSH)), JSON.stringify(overtime));
assert.equal(overtime.some((item) => item.content.includes("香山")), false);
assert.equal(overtime.some((item) => item.content.includes("火锅")), false);
assert.equal(overtime.some((item) => item.content.includes("样本")), false);

const night = await memory.recall({
  query: "我上次为了赶上那个截止，连夜干活，你还记得吗",
  scope: "current",
});
assert.ok(night.some((item) => item.content.includes("样本")), JSON.stringify(night));
assert.equal(night.some((item) => item.content.includes(RUSH)), false);
assert.equal(night.some((item) => item.content.includes("香山")), false);
assert.equal(night.some((item) => item.content.includes("火锅")), false);
assert.ok(night.some((item) => item.kind.includes("看法") || item.kind.includes("判断") || item.content.includes("样本")));

const weather = await memory.recall({ query: "今天天气怎么样", scope: "current" });
assert.deepEqual(weather, []);

const food = await memory.recall({ query: "我喜欢吃什么", scope: "current" });
assert.ok(food.some((item) => item.content.includes("火锅")));
assert.equal(food.some((item) => item.content.includes("样本")), false);

const cities = await memory.recall({ query: "我现在住哪", scope: "all" });
assert.ok(cities.some((item) => item.content.includes("海淀")), JSON.stringify(cities));
assert.equal(cities.some((item) => item.content.includes("深圳")), false);

const report = await memory.relevantText("周末提醒");
assert.match(report, /交报告/);
assert.equal(await memory.relevantText("今天天气怎么样"), "");
assert.equal(await memory.relevantText("嗯"), "");

const injected = await memory.relevantText("我上次为了赶上那个截止，连夜干活");
assert.match(injected, /样本/);
assert.doesNotMatch(injected, /香山/);
assert.doesNotMatch(injected, /火锅/);

const literalOnly = new MemoryManager(store, thoughts, null);
assert.equal((await literalOnly.recall({ query: "加班", scope: "current" })).length, 0);
assert.ok(
  (await literalOnly.recall({ query: RUSH, scope: "current" })).some((item) =>
    item.content.includes(RUSH),
  ),
);

const broken = new MemoryManager(store, thoughts, {
  embed: async () => {
    throw new Error("embed down");
  },
  judge: async () => {
    throw new Error("judge down");
  },
});
clearMeaningCache();
assert.equal((await broken.recall({ query: "加班", scope: "current" })).length, 0);
assert.ok(
  (await broken.recall({ query: "样本明早六点", scope: "current" })).some((item) =>
    item.content.includes("样本"),
  ),
);

console.log("[meaning] offline ok");

function seed(
  target: InstanceType<typeof MemoryManager>,
  viewStore: InstanceType<typeof ThoughtStore>,
): void {
  target.saveEpisode("2026-01-01", RUSH, "medium");
  for (const [date, content] of [
    ["2026-03-01", "那天只是在家整理书架"],
    ["2026-04-01", "去超市买了牙膏"],
    ["2026-05-01", "看了一部老电影"],
    ["2026-06-01", "换了一套床单"],
    ["2026-07-01", "下雨天待在家里"],
    ["2026-08-01", "把自行车修好了"],
    ["2026-09-01", "买了一盆绿萝"],
    ["2026-10-01", "学了一道汤"],
  ] as const) {
    target.saveEpisode(date, content, "low");
  }
  target.saveEpisode("2026-10-10", "周末去爬了香山", "medium");
  target.saveEpisode("2026-10-14", SAMPLE, "high");
  target.saveImpression(
    "工作赶工",
    "用户虽然平时睡眠充足，但今晚必须熬通宵挽救三个月的工作成果，正面临关键节点。",
    "medium",
  );
  target.saveNote("陶艺", "下个月想去学陶艺", "low");
  target.saveBetween(
    "promise",
    "周末提醒",
    "她答应周末提醒交报告，还没提醒",
    "medium",
  );
  target.remember({
    category: "preference",
    key: "favorite_food",
    content: "喜欢吃火锅",
    importance: "medium",
    source: "user",
  });
  target.remember({
    category: "fact",
    key: "city",
    content: "以前住在深圳",
    importance: "medium",
    source: "user",
  });
  target.remember({
    category: "fact",
    key: "city",
    content: "北京市海淀区",
    importance: "medium",
    source: "user",
  });
  viewStore.save({
    kind: "view",
    about: "关键时刻熬夜赶工",
    content: VIEW,
  });
}

function fakeMeaning(): MeaningDeps {
  return {
    embed: async (texts) => texts.map((text) => vectorFor(text)),
    judge: async (utterance, lines) => {
      const picked = lines.filter((line) => sameMatter(utterance, line.text));
      return picked.slice(0, 4).map((line) => line.id);
    },
  };
}

function vectorFor(text: string): number[] {
  if (text.includes("香山")) return unit(0.96, 0, 0, 0, 0, 0.28);
  if (/加班|赶项目|样本|熬夜|熬通宵|心血|截止|连夜/.test(text)) return axis(0);
  if (/火锅|吃什么|喜欢吃/.test(text)) return axis(1);
  if (/交报告|材料|提醒我交|周末提醒/.test(text)) return axis(2);
  if (/住哪|城市|海淀|深圳/.test(text)) return axis(3);
  if (/陶艺|手艺/.test(text)) return axis(4);
  return axis(5);
}

function axis(index: number): number[] {
  const vector = [0, 0, 0, 0, 0, 0];
  vector[index] = 1;
  return vector;
}

function unit(...values: number[]): number[] {
  const norm = Math.hypot(...values);
  return values.map((value) => value / norm);
}

function sameMatter(utterance: string, text: string): boolean {
  if (/天气/.test(utterance)) return false;
  if (utterance.includes("加班")) return text.includes(RUSH);
  if (/连夜|截止|样本/.test(utterance)) {
    return /样本|熬通宵|值得/.test(text) && !text.includes(RUSH);
  }
  if (/值不值|值得/.test(utterance)) return text.includes("值得");
  if (/吃什么|火锅/.test(utterance)) return text.includes("火锅");
  if (/住哪|哪个城市|人在哪/.test(utterance)) {
    return text.includes("海淀") && !text.startsWith("以前");
  }
  if (/以前住/.test(utterance)) return text.includes("深圳");
  if (/材料|交报告|提醒我交/.test(utterance)) return text.includes("交报告");
  if (/手艺|陶艺/.test(utterance)) return text.includes("陶艺");
  return false;
}

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
    console.error("[meaning] live precondition not met: GEMINI_API_KEY is missing");
    process.exit(1);
  }

  const proxy = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || "http://127.0.0.1:1082";
  if (proxy !== "off" && proxy !== "false") {
    const { ProxyAgent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new ProxyAgent(proxy));
  }

  const { GoogleGenAI } = await import("@google/genai");
  const { createGeminiMeaning } = await import("../memory/meaning");
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { apiVersion: "v1alpha" },
  });
  clearMeaningCache();
  const live = new MemoryManager(store, thoughts, createGeminiMeaning(apiKey, ai));

  const nightHits = await live.recall({
    query: "我上次为了赶上那个截止，连夜干活，你还记得吗",
    scope: "current",
  });
  console.log("[meaning] live night", nightHits.map((item) => item.content));
  assert.ok(
    nightHits.some((item) => item.content.includes("样本")),
    JSON.stringify(nightHits),
  );
  assertNone(nightHits, ["香山", "火锅", "陶艺", "交报告", "绿萝", RUSH]);

  const rushHits = await live.recall({ query: "加班", scope: "current" });
  console.log("[meaning] live 加班", rushHits.map((item) => item.content));
  assert.ok(rushHits.some((item) => item.content.includes(RUSH)), JSON.stringify(rushHits));
  assertNone(rushHits, ["香山", "火锅", "陶艺", "交报告", "绿萝"]);

  const weatherHits = await live.recall({ query: "今天天气怎么样", scope: "current" });
  console.log("[meaning] live weather", weatherHits.map((item) => item.content));
  assert.deepEqual(weatherHits, []);

  const reportHits = await live.recall({
    query: "我那份材料你说过要提醒我交",
    scope: "current",
  });
  console.log("[meaning] live report", reportHits.map((item) => item.content));
  assert.ok(reportHits.some((item) => item.content.includes("交报告")), JSON.stringify(reportHits));
  assertNone(reportHits, ["样本", "香山", "火锅"]);

  const viewHits = await live.recall({ query: "通宵值不值得", scope: "current" });
  console.log("[meaning] live view", viewHits.map((item) => `${item.kind}:${item.content}`));
  assert.ok(viewHits.some((item) => item.content.includes("值得")), JSON.stringify(viewHits));
  assertNone(viewHits, ["火锅", "香山", "陶艺"]);

  const foodHits = await live.recall({ query: "我喜欢吃什么", scope: "current" });
  console.log("[meaning] live food", foodHits.map((item) => item.content));
  assert.ok(foodHits.some((item) => item.content.includes("火锅")), JSON.stringify(foodHits));
  assertNone(foodHits, ["样本", "香山"]);

  const cityHits = await live.recall({ query: "我现在住哪", scope: "current" });
  console.log("[meaning] live city", cityHits.map((item) => item.content));
  assert.ok(cityHits.some((item) => item.content.includes("海淀")), JSON.stringify(cityHits));
  assert.equal(cityHits.some((item) => item.content.includes("深圳")), false);

  const injectedLive = await live.relevantText(
    "我上次为了赶上那个截止，连夜干活，你还记得吗",
  );
  console.log("[meaning] live inject\n" + injectedLive);
  assert.match(injectedLive, /样本/);
  assert.doesNotMatch(injectedLive, /香山/);
  assert.doesNotMatch(injectedLive, /火锅/);
  assert.equal((injectedLive.match(/^- /gm) ?? []).length <= 4, true);

  const response = await ai.models.generateContent({
    model: "gemini-flash-lite-latest",
    contents: `你是阿七。用两三句口语回答。

${live.getContext()}

这一句临时补进来的，只和对方刚刚说的有关：
${injectedLive}

这一句只讲对得上的那一件。没有对得上的就说不记得。不要把没问到的旧事一起讲，不要用相近但不对的事来顶。

用户：我上次为了赶上那个截止，连夜干活，你还记得吗？`,
    config: { temperature: 0.2 },
  });
  const answer = response.text?.trim() ?? "";
  console.log("[meaning] live answer");
  console.log(answer);
  assert.match(answer, /熬夜|样本|六点|数据|心血|赶工/);
  assert.doesNotMatch(answer, /香山|火锅|陶艺|绿萝|交报告/);

  console.log("[meaning] live ok");
}

function assertNone(
  hits: Array<{ content: string }>,
  banned: string[],
): void {
  for (const word of banned) {
    assert.equal(
      hits.some((item) => item.content.includes(word)),
      false,
      `${word} in ${hits.map((item) => item.content).join(" | ")}`,
    );
  }
}
