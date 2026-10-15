import assert from "node:assert/strict";
import { REUNION_GAP_MS } from "../affect/affect";
import {
  buildReunionOpening,
  DATE_NEAR_DAYS,
  daysUntilImportant,
  RECENT_MATTER_MS,
  type ReunionDate,
  type ReunionMatter,
} from "../companion/reunion";

const now = new Date(2026, 9, 15, 12, 0, 0).getTime();
const HOUR = 60 * 60 * 1000;

function at(msAgo: number): string {
  return new Date(now - msAgo).toISOString();
}

function matter(about: string, content: string, msAgo: number): ReunionMatter {
  return { about, content, updatedAt: at(msAgo) };
}

function open(input: {
  gap?: number | null;
  lastSeenAt?: string;
  tier?: "刚认识" | "常聊" | "很熟";
  unresolved?: ReunionMatter[];
  questions?: ReunionMatter[];
  promises?: ReunionMatter[];
  dates?: ReunionDate[];
}) {
  return buildReunionOpening({
    nowMs: now,
    lastSeenAt:
      input.lastSeenAt !== undefined
        ? input.lastSeenAt
        : input.gap === null
          ? null
          : at(input.gap ?? REUNION_GAP_MS),
    tier: input.tier ?? "很熟",
    unresolved: input.unresolved ?? [],
    questions: input.questions ?? [],
    promises: input.promises ?? [],
    dates: input.dates ?? [],
  });
}

const interview = matter("面试", "结果还没出来", 2 * 24 * HOUR);
const oldWorry = matter("搬家", "还没定下来", RECENT_MATTER_MS + HOUR);
const recentQuestion = matter("那只猫", "后来找到了吗", 3 * HOUR);
const olderQuestion = matter("那只猫", "后来找到了吗", 2 * 24 * HOUR);
const promise = matter("约定", "周末提醒交报告", 5 * HOUR);
const invented = matter("昨晚", "我昨晚睡了，今天吃过早饭", HOUR);

assert.equal(open({ gap: REUNION_GAP_MS - 1, unresolved: [interview] }).apart, false);
assert.equal(open({ gap: REUNION_GAP_MS - 1, unresolved: [interview] }).cue, "");
assert.equal(open({ gap: null, unresolved: [interview] }).apart, false);
assert.equal(open({ lastSeenAt: "not-a-time", unresolved: [interview] }).apart, false);

const greeted = open({ tier: "刚认识", unresolved: [interview], dates: [exam(2)] });
assert.equal(greeted.apart, true);
assert.equal(greeted.matter, null);
assert.match(greeted.cue, /只打招呼，不翻旧事/);
assert.doesNotMatch(greeted.cue, /面试|考试/);

const recent = open({
  tier: "常聊",
  unresolved: [oldWorry, interview],
  questions: [recentQuestion],
});
assert.equal(recent.matter, "没问完的问题：那只猫，后来找到了吗");
assert.match(recent.cue, /轻轻接这一件和最近有关的/);
assert.doesNotMatch(recent.cue, /搬家|面试/);

const familiarDate = open({
  tier: "常聊",
  unresolved: [oldWorry],
  dates: [exam(2), exam(6, "体检")],
});
assert.equal(familiarDate.matter, "在意的日子临近了：考试，还有 2 天");
assert.doesNotMatch(familiarDate.cue, /搬家|体检/);

const familiarNone = open({ tier: "常聊", unresolved: [oldWorry] });
assert.equal(familiarNone.matter, null);
assert.match(familiarNone.cue, /只打招呼/);

const closeHang = open({
  tier: "很熟",
  unresolved: [oldWorry],
  questions: [olderQuestion],
  promises: [promise],
  dates: [exam(1)],
});
assert.equal(closeHang.matter, "还没完成的约定：周末提醒交报告");
assert.match(closeHang.cue, /先提这一件还悬着的/);
assert.doesNotMatch(closeHang.cue, /搬家|那只猫|考试/);

const closeOld = open({ tier: "很熟", unresolved: [oldWorry] });
assert.equal(closeOld.matter, "还放不下的事：搬家，还没定下来");

const closeDate = open({ tier: "很熟", dates: [exam(0)] });
assert.equal(closeDate.matter, "在意的日子临近了：考试，就是今天");
assert.match(closeDate.cue, /只提这一件临近的日子/);

const skipped = open({
  tier: "很熟",
  unresolved: [invented],
  dates: [exam(DATE_NEAR_DAYS + 1), { date: "2026-10-14", yearly: false, label: "昨天的事" }],
});
assert.equal(skipped.matter, null);
assert.match(skipped.cue, /只打招呼/);
assert.doesNotMatch(skipped.cue, /我昨晚|早饭|昨天的事/);

for (const opening of [greeted, recent, familiarDate, closeHang, closeDate, skipped]) {
  assert.match(opening.cue, /最多两句/);
  assert.match(opening.cue, /不要汇报你这段时间做了什么/);
  assert.match(opening.cue, /不要编你睡过、吃过/);
  assert.match(opening.cue, /分开了多久不是要讲的事/);
  assert.doesNotMatch(opening.cue, /又见面了/);
}

assert.equal(
  daysUntilImportant({ date: "10-16", yearly: false, label: "考试" }, new Date(now)),
  1,
);
assert.equal(
  daysUntilImportant({ date: "10-08", yearly: true, label: "纪念日" }, new Date(now)),
  null,
);
assert.equal(
  daysUntilImportant({ date: "2026-10-14", yearly: false, label: "昨天" }, new Date(now)),
  null,
);

console.log("reunion checks passed");

function exam(daysAhead: number, label = "考试"): ReunionDate {
  const when = new Date(now + daysAhead * 24 * HOUR);

  return {
    date: `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`,
    yearly: false,
    label,
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
