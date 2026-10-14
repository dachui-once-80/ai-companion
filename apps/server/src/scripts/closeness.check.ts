import assert from "node:assert/strict";
import { resolveCloseness, type ClosenessMemory } from "../companion/closeness";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-10-14T08:00:00.000Z");

function at(daysAgo: number): string {
  return new Date(now - daysAgo * DAY).toISOString();
}

function kept(count: number, daysAgo: number, category: "episode" | "note" = "episode"): ClosenessMemory[] {
  return Array.from({ length: count }, (_, index) => ({
    category,
    status: "current",
    content: `留下的第${index + 1}条`,
    createdAt: at(daysAgo),
  }));
}

function tier(input: {
  firstSeenAt?: string | null;
  warmth?: number;
  memories?: ClosenessMemory[];
}) {
  return resolveCloseness({
    nowMs: now,
    firstSeenAt: input.firstSeenAt ?? null,
    warmth: input.warmth ?? 0.4,
    memories: input.memories ?? [],
  }).tier;
}

assert.equal(tier({ warmth: 0.9 }), "刚认识");
assert.equal(
  tier({ firstSeenAt: at(1), warmth: 0.9, memories: kept(20, 1) }),
  "刚认识",
);
assert.equal(
  tier({ firstSeenAt: at(10), warmth: 0.9, memories: kept(2, 10) }),
  "刚认识",
);
assert.equal(
  tier({ firstSeenAt: at(10), warmth: 0.4, memories: kept(5, 10) }),
  "常聊",
);
assert.equal(
  tier({
    firstSeenAt: at(40),
    warmth: 0.4,
    memories: [...kept(8, 40), ...kept(4, 40, "note")],
  }),
  "很熟",
);
assert.equal(
  tier({
    firstSeenAt: at(40),
    warmth: 0.35,
    memories: kept(12, 40),
  }),
  "常聊",
);
assert.equal(
  tier({
    firstSeenAt: at(40),
    warmth: 0.2,
    memories: kept(12, 40),
  }),
  "刚认识",
);
assert.equal(
  tier({
    firstSeenAt: at(0),
    warmth: 0.5,
    memories: kept(12, 40),
  }),
  "很熟",
);

const historical: ClosenessMemory[] = [
  {
    category: "episode",
    status: "historical",
    content: "已经撤掉的片段",
    createdAt: at(40),
  },
  {
    category: "impression",
    status: "current",
    content: "这是判断，不是笔记",
    createdAt: at(40),
  },
  ...kept(4, 10, "note"),
];

assert.equal(tier({ firstSeenAt: at(10), warmth: 0.4, memories: historical }), "常聊");

const text = resolveCloseness({
  nowMs: now,
  firstSeenAt: null,
  warmth: 0.4,
  memories: [],
}).text;

assert.match(text, /这一次是「刚认识」/);
assert.match(text, /少把对方的事说成自己早就知道/);
assert.match(text, /称呼保持普通/);
assert.match(text, /相关的旧事可以自然接/);
assert.match(text, /可以更直接/);
assert.match(text, /这三档都不改价值观、说话习惯、在意的事和会坚持的看法/);
assert.match(text, /除非用户自己把关系说成那样，并且已经写进记忆/);

const closeText = resolveCloseness({
  nowMs: now,
  firstSeenAt: at(40),
  warmth: 0.4,
  memories: kept(12, 40),
}).text;

assert.match(closeText, /就按很熟说话/);
assert.match(closeText, /不同意时更短/);

console.log("closeness checks passed");
