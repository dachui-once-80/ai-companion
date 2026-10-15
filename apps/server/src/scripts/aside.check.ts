import assert from "node:assert/strict";
import {
  ASIDE_GAP_MS,
  composeAsideLine,
  decideAside,
  deliverReminder,
  dueRef,
  dueReminderLine,
} from "../companion/aside";
import { dateRef, hangingRef, type ReunionDate, type ReunionMatter } from "../companion/reunion";

const now = new Date(2026, 9, 15, 12, 0, 0).getTime();
const HOUR = 60 * 60 * 1000;

function at(msAgo: number): string {
  return new Date(now - msAgo).toISOString();
}

function matter(about: string, content: string, msAgo: number): ReunionMatter {
  return { about, content, updatedAt: at(msAgo) };
}

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

function leave(input: {
  gap?: number | null;
  voiceOpen?: boolean;
  unheard?: boolean;
  unresolved?: ReunionMatter[];
  questions?: ReunionMatter[];
  promises?: ReunionMatter[];
  dates?: ReunionDate[];
  dues?: Array<{
    id: string;
    title: string;
    dueAt: string | null;
    reminderAt: string | null;
  }>;
  spoken?: Array<{ key: string; revision: string }>;
}) {
  return decideAside({
    nowMs: now,
    voiceOpen: input.voiceOpen ?? false,
    awayAt: input.gap === null ? null : at(input.gap ?? ASIDE_GAP_MS),
    unheard: input.unheard ?? false,
    unresolved: input.unresolved ?? [],
    questions: input.questions ?? [],
    promises: input.promises ?? [],
    dates: input.dates ?? [],
    dues: input.dues ?? [],
    spoken: input.spoken ?? [],
  });
}

const interview = matter("面试", "结果还没出来", 2 * 24 * HOUR);
const rush = matter(
  "今晚赶工交数据",
  "不知道用户今晚赶工顺不顺利、数据能不能赶在明早六点前交出去，忙完后有没有好好补眠。",
  5 * HOUR,
);
const question = matter("那只猫", "后来找到了吗", 3 * HOUR);
const promise = matter("约定", "周末提醒交报告", 4 * HOUR);
const invented = matter("昨晚", "我昨晚睡了，今天吃过早饭", HOUR);

assert.equal(leave({ voiceOpen: true, unresolved: [interview] }), null);
assert.equal(leave({ unheard: true, unresolved: [interview] }), null);
assert.equal(leave({ gap: ASIDE_GAP_MS - 1, unresolved: [interview] }), null);
assert.equal(leave({ gap: null, unresolved: [interview] }), null);
assert.equal(leave({}), null);
assert.equal(leave({ unresolved: [invented] }), null);
assert.equal(
  leave({ dates: [exam(8), { date: "2026-10-14", yearly: false, label: "昨天的事" }] }),
  null,
);

const hung = leave({ unresolved: [interview] });
assert.ok(hung);
assert.equal(hung.text, "面试那件，我还放着。结果还没出来。");
assert.equal(hung.matterKey, hangingRef("unresolved", "面试", "结果还没出来").key);
assert.equal(hung.matterRevision, hangingRef("unresolved", "面试", "结果还没出来").revision);
assert.doesNotMatch(hung.text, /睡了|吃过|度过|分开了|用户/);

assert.equal(
  leave({
    unresolved: [interview],
    spoken: [hangingRef("unresolved", "面试", "结果还没出来")],
  }),
  null,
);

const changed = leave({
  unresolved: [matter("面试", "结果出来了，还在等通知", 2 * HOUR)],
  spoken: [hangingRef("unresolved", "面试", "结果还没出来")],
});
assert.ok(changed);
assert.match(changed.text, /还在等通知/);
assert.doesNotMatch(changed.text, /结果还没出来/);

const newerQuestion = leave({
  unresolved: [interview],
  questions: [question],
});
assert.ok(newerQuestion);
assert.equal(newerQuestion.text, "那只猫，后来找到了吗。");

const internal = leave({ unresolved: [rush] });
assert.ok(internal);
assert.equal(internal.text, "今晚赶工交数据那件，我还放着。");
assert.doesNotMatch(internal.text, /用户|补眠|睡/);

const promised = leave({ promises: [promise] });
assert.ok(promised);
assert.equal(promised.text, "周末提醒交报告。这件还没做完。");

const dated = leave({ dates: [exam(2), exam(6, "体检")] });
assert.ok(dated);
assert.equal(dated.text, "考试还有两天。");
assert.equal(dated.matterKey, dateRef(exam(2).date, "考试").key);
assert.doesNotMatch(dated.text, /体检/);

const today = leave({ dates: [exam(0)] });
assert.ok(today);
assert.equal(today.text, "考试就是今天。");

const tomorrow = leave({ dates: [exam(1)] });
assert.ok(tomorrow);
assert.equal(tomorrow.text, "考试就在明天。");

const staleDue = {
  id: "old-task",
  title: "旧提醒",
  dueAt: at(40 * 24 * HOUR),
  reminderAt: null,
};
const freshDue = {
  id: "report",
  title: "交报告",
  dueAt: at(HOUR),
  reminderAt: null,
};

const hangingWins = leave({
  unresolved: [rush],
  dues: [staleDue],
});
assert.ok(hangingWins);
assert.match(hangingWins.text, /今晚赶工交数据/);
assert.doesNotMatch(hangingWins.text, /旧提醒/);

const dueWins = leave({
  unresolved: [interview],
  dues: [freshDue],
});
assert.ok(dueWins);
assert.equal(dueWins.text, "交报告的时间到了。");
assert.equal(dueWins.matterKey, dueRef(freshDue).key);

assert.equal(
  leave({
    dues: [freshDue],
    spoken: [dueRef(freshDue)],
    unresolved: [],
  }),
  null,
);

const undated = leave({
  dues: [{ id: "plain", title: "没有时间的待办", dueAt: null, reminderAt: null }],
});
assert.equal(undated, null);

for (const line of [hung.text, internal.text, promised.text, dated.text, dueWins.text]) {
  const sentences = line.split("。").filter((part) => part.trim().length > 0);
  assert.ok(sentences.length >= 1 && sentences.length <= 2, line);
  assert.doesNotMatch(line, /睡了|吃过|吃了|度过|我昨晚|这几个小时|这段时间我/);
}

assert.equal(
  composeAsideLine({
    kind: "unresolved",
    about: "我的身体",
    content: "我昨晚睡了",
    days: null,
  }),
  null,
);

assert.equal(dueReminderLine("交报告"), "交报告的时间到了。");
assert.equal(dueReminderLine("  "), null);
assert.equal(dueReminderLine("我昨晚睡了"), null);

const reportTask = {
  id: "report",
  title: "交报告",
  dueAt: null,
  reminderAt: at(HOUR),
};
const spokenDelivery = deliverReminder({
  voiceOpen: true,
  task: reportTask,
  alreadySpoken: false,
});
assert.equal(spokenDelivery.action, "speak");
if (spokenDelivery.action === "speak") {
  assert.equal(spokenDelivery.line, "交报告的时间到了。");
  assert.equal(spokenDelivery.matterKey, dueRef(reportTask).key);
  assert.equal(spokenDelivery.matterRevision, dueRef(reportTask).revision);
  assert.doesNotMatch(spokenDelivery.line, /提醒|待办|编号|数据库|工具/);
}

const leftDelivery = deliverReminder({
  voiceOpen: false,
  task: reportTask,
  alreadySpoken: false,
});
assert.equal(leftDelivery.action, "leave");
if (leftDelivery.action === "leave" && spokenDelivery.action === "speak") {
  assert.equal(leftDelivery.line, spokenDelivery.line);
}

assert.equal(
  deliverReminder({
    voiceOpen: true,
    task: reportTask,
    alreadySpoken: true,
  }).action,
  "skip",
);
assert.equal(
  deliverReminder({
    voiceOpen: false,
    task: { ...reportTask, title: "我昨晚睡了" },
    alreadySpoken: false,
  }).action,
  "skip",
);

console.log("aside checks passed");
