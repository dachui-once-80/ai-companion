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
  "常聊",
);
assert.equal(
  tier({
    firstSeenAt: at(40),
    warmth: 0.54,
    memories: [...kept(8, 40), ...kept(4, 40, "note")],
  }),
  "常聊",
);
assert.equal(
  tier({
    firstSeenAt: at(40),
    warmth: 0.55,
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
    warmth: 0.4,
    memories: kept(12, 40),
  }),
  "常聊",
);
assert.equal(
  tier({
    firstSeenAt: at(0),
    warmth: 0.55,
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
assert.match(text, /这三档都不改价值观、说话习惯、在意的事、会坚持的看法和内心/);
assert.match(text, /除非用户自己把关系说成那样，并且已经写进记忆/);
assert.doesNotMatch(text, /第一次连上|习惯的称呼|可以直说：|要先听完|先别给建议/);

const closeText = resolveCloseness({
  nowMs: now,
  firstSeenAt: at(40),
  warmth: 0.55,
  memories: kept(12, 40),
}).text;

assert.match(closeText, /就按很熟说话/);
assert.match(closeText, /不同意时更短/);
assert.match(closeText, /第一次连上是 \d{4}-\d{2}-\d{2}/);
assert.doesNotMatch(closeText, /习惯的称呼|可以直说：|要先听完|先别给建议/);

const familiarBase = {
  nowMs: now,
  warmth: 0.4,
} as const;

const yuan = resolveCloseness({
  ...familiarBase,
  firstSeenAt: at(20),
  memories: [
    ...kept(5, 20),
    {
      category: "identity",
      status: "current",
      key: "preferred_address",
      content: "叫我阿远",
      createdAt: at(20),
    },
    {
      category: "between",
      status: "current",
      key: "between:listen:烦心事",
      content: "工作上的烦心事要先听完，别急着给办法",
      createdAt: at(20),
    },
    {
      category: "identity",
      status: "historical",
      key: "preferred_address",
      content: "叫我老周",
      createdAt: at(20),
    },
  ],
});

const lin = resolveCloseness({
  ...familiarBase,
  firstSeenAt: at(12),
  memories: [
    ...kept(5, 12),
    {
      category: "between",
      status: "current",
      key: "between:address:叫用户",
      content: "她叫用户林姐",
      createdAt: at(12),
    },
    {
      category: "preference",
      status: "current",
      key: "when_sad",
      content: "难过时想要办法",
      createdAt: at(12),
    },
    {
      category: "between",
      status: "current",
      key: "between:hold:论文",
      content: "论文被拒这件事先别给建议",
      createdAt: at(12),
    },
  ],
});

assert.equal(yuan.tier, "常聊");
assert.equal(lin.tier, "常聊");
assert.notEqual(yuan.text, lin.text);

assert.match(yuan.text, /就按常聊说话/);
assert.match(yuan.text, /习惯的称呼：叫我阿远/);
assert.match(yuan.text, /要先听完：工作上的烦心事要先听完，别急着给办法/);
assert.match(yuan.text, /第一次连上是 \d{4}-\d{2}-\d{2}/);
assert.doesNotMatch(yuan.text, /林姐|想要办法|老周|先别给建议/);

assert.match(lin.text, /就按常聊说话/);
assert.match(lin.text, /习惯的称呼：她叫用户林姐/);
assert.match(lin.text, /可以直说：难过时想要办法/);
assert.match(lin.text, /先别给建议：论文被拒这件事先别给建议/);
assert.match(lin.text, /第一次连上是 \d{4}-\d{2}-\d{2}/);
assert.doesNotMatch(lin.text, /阿远|烦心事/);

const yuanDate = yuan.text.match(/第一次连上是 (\d{4}-\d{2}-\d{2})/)?.[1];
const linDate = lin.text.match(/第一次连上是 (\d{4}-\d{2}-\d{2})/)?.[1];

assert.ok(yuanDate && linDate && yuanDate !== linDate);

console.log("closeness checks passed");
console.log("--- 常聊 · 阿远 ---");
console.log(yuan.text);
console.log("--- 常聊 · 林姐 ---");
console.log(lin.text);
