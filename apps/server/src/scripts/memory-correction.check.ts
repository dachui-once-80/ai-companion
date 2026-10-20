/**
 * 记忆纠正与检索一致性契约。
 * 隔离临时库；不触碰正式 companion.db。
 *
 * 数据模型说明：status=historical 同时表示「真实往事」与「纠正后归档」。
 * 本检查不要求问过去时完全排除后者（需迁移才能区分），只要求：
 * 默认/当前检索不把 historical 当现事实；问过去时历史条目带「以前的」标注；
 * 过去意图启发式对给定正反例判定稳定。
 */
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { prepareOfflineDb } from "./offlineDb.ts";
import {
  DEFAULT_RECALL_SCOPE,
  relevantScopeForUtterance,
  utteranceRequestsPastMemory,
} from "../memory/memoryScope.ts";
import {
  noteForFactQueryFailure,
  noteForRecallSuccess,
} from "../../../web/src/realtime/turnTranscript.ts";

const file = prepareOfflineDb("memory-correction-");

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
`);
sqlite.close();

const { MemoryManager } = await import("../memory/MemoryManager");
const { MemoryStore } = await import("../memory/MemoryStore");
const { clearMeaningCache } = await import("../memory/meaning");

assert.equal(DEFAULT_RECALL_SCOPE, "current");

/** 意图边界：正例 → all；反例 → current */
const PAST_INTENT_CASES: Array<{
  utterance: string;
  expectPast: boolean;
  label: string;
}> = [
  // 当前事实
  { utterance: "我现在喜欢什么", expectPast: false, label: "present-like" },
  { utterance: "我目前住哪", expectPast: false, label: "present-live" },
  { utterance: "我喜欢喝什么", expectPast: false, label: "plain-pref" },
  { utterance: "目前喜欢什么", expectPast: false, label: "present-pref" },
  // 明确回忆
  { utterance: "我以前喜欢什么", expectPast: true, label: "past-like" },
  { utterance: "我小时候喜欢什么", expectPast: true, label: "childhood" },
  { utterance: "上次我们聊到哪", expectPast: true, label: "last-time" },
  { utterance: "过去住在哪", expectPast: true, label: "past-live" },
  { utterance: "以前的偏好", expectPast: true, label: "past-pref-noun" },
  { utterance: "我以前住在哪", expectPast: true, label: "past-city" },
  // 普通时间范围（不得仅因「过去」打开 all）
  { utterance: "过去一周怎么样", expectPast: false, label: "past-week" },
  { utterance: "最近几天忙什么", expectPast: false, label: "recent-days" },
  // 历史背景 + 当前问题 → 以现在为准
  {
    utterance: "之前跟你说过的那个问题，现在怎么办",
    expectPast: false,
    label: "mixed-before-now",
  },
  // 含「之前」但非正式回忆请求 → 默认 current
  {
    utterance: "之前跟你说过那个问题",
    expectPast: false,
    label: "mentioned-before",
  },
];

const intentResults: Array<{
  utterance: string;
  label: string;
  past: boolean;
  scope: string;
}> = [];

for (const item of PAST_INTENT_CASES) {
  const past = utteranceRequestsPastMemory(item.utterance);
  const scope = relevantScopeForUtterance(item.utterance);

  assert.equal(
    past,
    item.expectPast,
    `${item.label}: utteranceRequestsPastMemory(${JSON.stringify(item.utterance)}) → ${past}, want ${item.expectPast}`,
  );
  assert.equal(
    scope,
    item.expectPast ? "all" : "current",
    `${item.label}: relevantScope`,
  );

  intentResults.push({
    utterance: item.utterance,
    label: item.label,
    past,
    scope,
  });
}

const store = new MemoryStore();
const memory = new MemoryManager(store, null, {
  embed: async (texts) => texts.map(() => [1, 0, 0]),
  judge: async (utterance, lines) => {
    const ids: number[] = [];

    for (const line of lines) {
      // 「喜欢什么 / 喝什么」类问句也要点选饮料偏好
      if (
        /喝|饮料|可乐|咖啡|喜欢/.test(utterance) &&
        /可乐|咖啡/.test(line.text)
      ) {
        ids.push(line.id);
      }
      if (/住|城市|海淀|深圳/.test(utterance) && /海淀|深圳/.test(line.text)) {
        ids.push(line.id);
      }
      if (/看展|周末/.test(utterance) && /看了展/.test(line.text)) {
        ids.push(line.id);
      }
    }

    return [...new Set(ids)].slice(0, 4);
  },
});

memory.remember({
  category: "preference",
  key: "favorite_drink",
  content: "喜欢喝咖啡",
  importance: "high",
  source: "user",
});
memory.remember({
  category: "preference",
  key: "favorite_drink",
  content: "喜欢喝可乐",
  importance: "high",
  source: "user",
});
memory.remember({
  category: "fact",
  key: "city",
  content: "深圳市南山区",
  importance: "medium",
  source: "user",
});
memory.saveEpisode("2026-10-01", "周末一起去看了展", "medium");

clearMeaningCache();

// --- current 可被正常检索 ---
{
  const recalled = await memory.recall({ query: "喜欢喝可乐" });
  assert.ok(
    recalled.some((item) => item.content.includes("可乐") && item.status === "current"),
    JSON.stringify(recalled),
  );

  const relevant = await memory.relevantText("可乐好喝吗");
  assert.match(relevant, /可乐/);
  assert.doesNotMatch(relevant, /以前的/);
}

// --- 多值撤销后：旧偏好不再作为当前事实 ---
{
  const forgotten = memory.forget("favorite_drink", "喜欢喝咖啡");
  assert.ok(forgotten);
  assert.equal(forgotten.status, "historical");

  const currentRecall = await memory.recall({
    query: "喜欢喝什么",
    scope: "current",
  });
  assert.equal(
    currentRecall.some((item) => item.content.includes("咖啡")),
    false,
    JSON.stringify(currentRecall),
  );
  assert.ok(currentRecall.some((item) => item.content.includes("可乐")));

  const defaultRecall = await memory.recall({ query: "喜欢喝咖啡" });
  assert.equal(
    defaultRecall.some((item) => item.content.includes("咖啡")),
    false,
    "default recall scope must be current",
  );

  const relevantNow = await memory.relevantText("我喜欢喝什么饮料");
  assert.doesNotMatch(relevantNow, /咖啡/);
  assert.match(relevantNow, /可乐/);

  // 反例意图：不得因「现在/目前」或「过去一周」把已纠正值注入
  for (const utterance of [
    "我现在喜欢什么",
    "我目前住哪",
    "过去一周怎么样",
    "之前跟你说过的那个问题，现在怎么办",
  ]) {
    const text = await memory.relevantText(utterance);
    assert.doesNotMatch(
      text,
      /咖啡/,
      `corrected value must not appear as current fact for: ${utterance} → ${text}`,
    );
  }
}

// --- 明确问过去：可检索合适历史，且带以前的标注 ---
{
  const pastRelevant = await memory.relevantText("我以前喜欢什么");
  assert.match(pastRelevant, /咖啡/);
  assert.match(pastRelevant, /以前的/);

  const childhood = await memory.relevantText("我小时候喜欢什么");
  assert.match(childhood, /咖啡/);
  assert.match(childhood, /以前的/);

  const histRecall = await memory.recall({
    query: "咖啡",
    scope: "historical",
  });
  assert.ok(histRecall.some((item) => item.content.includes("咖啡")));
  assert.ok(histRecall.every((item) => item.status === "historical"));
  assert.ok(histRecall.every((item) => item.kind.startsWith("以前的")));
}

// --- historical 默认不得当当前事实注入 ---
{
  const noPastCue = await memory.relevantText("周末喝点什么");
  assert.doesNotMatch(noPastCue, /咖啡/);
}

// --- 单值档案被新值覆盖后，旧值不再以当前事实出现 ---
{
  memory.remember({
    category: "fact",
    key: "city",
    content: "北京市海淀区",
    importance: "medium",
    source: "user",
  });

  const citiesNow = await memory.recall({ query: "海淀", scope: "current" });
  assert.ok(citiesNow.some((item) => item.content.includes("海淀")));
  assert.equal(
    citiesNow.some((item) => item.content.includes("深圳")),
    false,
  );

  const relevantCity = await memory.relevantText("我现在住哪");
  assert.match(relevantCity, /海淀/);
  assert.doesNotMatch(relevantCity, /深圳/);

  const pastCity = await memory.relevantText("我以前住在哪");
  assert.match(pastCity, /深圳/);
  assert.match(pastCity, /以前的/);
}

// --- 空结果：成功且无命中 → 空数组 / 空字符串，不是抛错 ---
{
  clearMeaningCache();
  const emptyRecall = await memory.recall({
    query: "量子飞船注册号",
    scope: "current",
  });
  assert.deepEqual(emptyRecall, []);

  const emptyRelevant = await memory.relevantText("量子飞船注册号是多少");
  assert.equal(emptyRelevant, "");
}

// --- recall_memory 等效工具 note：scope=all 混合 / 仅 current / 空 / 失败 ---
{
  clearMeaningCache();

  const mixed = await memory.recall({ query: "喜欢喝", scope: "all" });
  assert.ok(
    mixed.some(
      (item) => item.status === "historical" && item.content.includes("咖啡"),
    ),
    JSON.stringify(mixed),
  );
  assert.ok(
    mixed.some(
      (item) => item.status === "current" && item.content.includes("可乐"),
    ),
    JSON.stringify(mixed),
  );
  const mixedNote = noteForRecallSuccess(mixed);
  assert.match(mixedNote, /只用和问题对得上的这几条/);
  assert.match(mixedNote, /历史记录/);
  assert.match(mixedNote, /不代表当前事实/);
  assert.match(mixedNote, /不得据此覆盖用户当前说法/);

  const currentOnly = await memory.recall({
    query: "喜欢喝",
    scope: "current",
  });
  assert.ok(currentOnly.length > 0);
  assert.ok(currentOnly.every((item) => item.status === "current"));
  assert.equal(
    currentOnly.some((item) => item.content.includes("咖啡")),
    false,
  );
  const currentNote = noteForRecallSuccess(currentOnly);
  assert.match(currentNote, /只用和问题对得上的这几条/);
  assert.doesNotMatch(currentNote, /历史记录/);
  assert.doesNotMatch(currentNote, /不得据此覆盖/);

  const emptyTool = await memory.recall({
    query: "量子飞船注册号",
    scope: "all",
  });
  assert.deepEqual(emptyTool, []);
  const emptyNote = noteForRecallSuccess(emptyTool);
  assert.match(emptyNote, /没有对得上的记忆/);
  assert.doesNotMatch(emptyNote, /历史记录/);

  // 工具失败路径：HTTP !ok 时用同一失败 note，不得说成「没有记录」
  const failNote = noteForFactQueryFailure();
  assert.match(failNote, /查询失败/);
  assert.match(failNote, /不要说成没有/);
  assert.doesNotMatch(failNote, /没有对得上的记忆/);
}

// --- 查询失败与空结果区分：底层读库失败须抛错；HTTP 对应 500，不得当成「没有记录」 ---
{
  const boom = new MemoryManager(
    {
      getAll() {
        throw new Error("database locked");
      },
      rememberMemory() {
        throw new Error("unused");
      },
      forgetCurrentMemory() {
        throw new Error("unused");
      },
      findCurrentByKey() {
        return [];
      },
      findByCategory() {
        return [];
      },
      saveCompanionMemory() {
        throw new Error("unused");
      },
      retireCompanionMemory() {
        return 0;
      },
      removeMemory() {
        return false;
      },
      clear() {},
      search() {
        return [];
      },
      recall() {
        return [];
      },
      addMemory() {
        throw new Error("unused");
      },
      updateMemory() {
        throw new Error("unused");
      },
    } as unknown as InstanceType<typeof MemoryStore>,
    null,
    null,
  );

  await assert.rejects(
    () => boom.recall({ query: "可乐", scope: "current" }),
    /database locked/,
  );
  await assert.rejects(
    () => boom.relevantText("可乐好喝吗"),
    /database locked/,
  );
}

// 当前经历片段在默认 relevant 中仍可用
{
  const episodeHit = await memory.relevantText("周末看展");
  assert.match(episodeHit, /看了展/);
}

console.log("[memory-correction] intent cases:");
for (const row of intentResults) {
  console.log(
    `  ${row.label}: ${JSON.stringify(row.utterance)} → past=${row.past} scope=${row.scope}`,
  );
}
console.log("[memory-correction] offline ok");
