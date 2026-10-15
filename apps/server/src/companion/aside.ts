/**
 * 用户没在语音里、又隔了够久时，留下一句她的话。
 * 只从还悬着的事、没问完的问题、还没完成的约定、临近的在意日子、到期的待办里挑一件。
 * 没有值得说的就不留。一次只留一句。同一件事在内容再变之前不重复留。
 * 句子按她的口气，一两句。不编她的身体，也不编这段空档里的经历。
 */

import { REUNION_GAP_MS } from "../affect/affect";
import { contentKey } from "../memory/openMemory";
import {
  dateRef,
  daysUntilImportant,
  hangingRef,
  type MatterRef,
  type ReunionDate,
  type ReunionMatter,
} from "./reunion";
import { inventsCompanionLife } from "./ThoughtStore";

/** 和重逢同一段空档：隔了三个小时以上，才算够久。 */
export const ASIDE_GAP_MS = REUNION_GAP_MS;

const DAY_WORD = ["零", "一", "两", "三", "四", "五", "六", "七"] as const;

const GENERIC_ABOUT = new Set([
  "约定",
  "那件",
  "那句",
  "这件事",
  "旧事",
  "待办",
]);

export type DueMatter = {
  id: string;
  title: string;
  dueAt: string | null;
  reminderAt: string | null;
};

export type AsideChoice = {
  text: string;
  matterKey: string;
  matterRevision: string;
};

type AsideKind = "unresolved" | "question" | "promise" | "date" | "due";

type Candidate = {
  kind: AsideKind;
  about: string;
  content: string;
  readyAt: number;
  rank: number;
  days: number | null;
  ref: MatterRef;
};

export function decideAside(input: {
  nowMs: number;
  voiceOpen: boolean;
  awayAt: string | null;
  unheard: boolean;
  unresolved: readonly ReunionMatter[];
  questions: readonly ReunionMatter[];
  promises: readonly ReunionMatter[];
  dates: readonly ReunionDate[];
  dues: readonly DueMatter[];
  spoken: readonly MatterRef[];
}): AsideChoice | null {
  if (input.voiceOpen || input.unheard) return null;
  if (!apartLongEnough(input.awayAt, input.nowMs)) return null;

  for (const item of rankCandidates(input)) {
    if (isSpoken(item.ref, input.spoken)) continue;

    const text = composeAsideLine(item);

    if (!text) continue;

    return {
      text,
      matterKey: item.ref.key,
      matterRevision: item.ref.revision,
    };
  }

  return null;
}

export function composeAsideLine(item: {
  kind: AsideKind;
  about: string;
  content: string;
  days: number | null;
}): string | null {
  const line = draftLine(item);

  if (!line || !line.endsWith("。")) return null;

  const sentences = line.split("。").filter((part) => part.trim().length > 0);

  if (sentences.length < 1 || sentences.length > 2) return null;
  if (inventsCompanionLife(line, line)) return null;
  if (
    /睡了|吃过|吃了|度过|我昨晚|我今早|我刚才|这几个小时|这段时间我|分开了/.test(
      line,
    )
  ) {
    return null;
  }

  return line;
}

export function dueRef(task: Pick<DueMatter, "id" | "title" | "dueAt" | "reminderAt">): MatterRef {
  return {
    key: `due:${task.id.trim()}`,
    revision: contentKey(
      `${task.title}|${task.dueAt ?? ""}|${task.reminderAt ?? ""}`,
    ),
  };
}

/** 到点时她会说的那一句。说不出口就没有。 */
export function dueReminderLine(title: string): string | null {
  return composeAsideLine({
    kind: "due",
    about: title.trim(),
    content: title.trim(),
    days: null,
  });
}

export type ReminderDelivery =
  | { action: "skip" }
  | {
      action: "speak" | "leave";
      line: string;
      matterKey: string;
      matterRevision: string;
    };

/**
 * 提醒到点就交付，不等三个小时。
 * 人在语音里：把这句交给她说。人不在：留下这句。
 * 同一版本已经说过或留过，就跳过。
 */
export function deliverReminder(input: {
  voiceOpen: boolean;
  task: Pick<DueMatter, "id" | "title" | "dueAt" | "reminderAt">;
  alreadySpoken: boolean;
}): ReminderDelivery {
  const ref = dueRef(input.task);

  if (input.alreadySpoken) return { action: "skip" };

  const line = dueReminderLine(input.task.title);

  if (!line) return { action: "skip" };

  return {
    action: input.voiceOpen ? "speak" : "leave",
    line,
    matterKey: ref.key,
    matterRevision: ref.revision,
  };
}

function rankCandidates(input: {
  nowMs: number;
  unresolved: readonly ReunionMatter[];
  questions: readonly ReunionMatter[];
  promises: readonly ReunionMatter[];
  dates: readonly ReunionDate[];
  dues: readonly DueMatter[];
}): Candidate[] {
  const hanging: Candidate[] = [
    ...tagged("unresolved", input.unresolved, 0),
    ...tagged("question", input.questions, 1),
    ...tagged("promise", input.promises, 2),
    ...dueCandidates(input.dues, input.nowMs),
  ];

  hanging.sort(
    (a, b) => b.readyAt - a.readyAt || a.rank - b.rank || a.ref.key.localeCompare(b.ref.key),
  );

  const date = nearestDate(input.dates, input.nowMs);

  return date ? [...hanging, date] : hanging;
}

function tagged(
  kind: "unresolved" | "question" | "promise",
  items: readonly ReunionMatter[],
  rank: number,
): Candidate[] {
  return items.flatMap((item) => {
    const usable = normalize(item.about, item.content);
    const readyAt = Date.parse(item.updatedAt);

    if (!usable || !Number.isFinite(readyAt)) return [];

    return [
      {
        kind,
        about: usable.about,
        content: usable.content,
        readyAt,
        rank,
        days: null,
        ref: hangingRef(kind, usable.about, usable.content),
      },
    ];
  });
}

function dueCandidates(tasks: readonly DueMatter[], nowMs: number): Candidate[] {
  return tasks.flatMap((task) => {
    const readyAt = dueInstant(task);

    if (readyAt === null || readyAt > nowMs) return [];

    const title = task.title.trim();

    if (!title || inventsCompanionLife(title, title)) return [];

    return [
      {
        kind: "due" as const,
        about: title,
        content: title,
        readyAt,
        rank: 3,
        days: null,
        ref: dueRef(task),
      },
    ];
  });
}

function nearestDate(
  dates: readonly ReunionDate[],
  nowMs: number,
): Candidate | null {
  let best: Candidate | null = null;

  for (const item of dates) {
    const days = daysUntilImportant(item, new Date(nowMs));
    const label = item.label.trim();

    if (days === null || label.length < 2) continue;
    if (inventsCompanionLife(label, label)) continue;

    const candidate: Candidate = {
      kind: "date",
      about: label,
      content: label,
      readyAt: nowMs,
      rank: 4,
      days,
      ref: dateRef(item.date, label),
    };

    if (!best || days < (best.days ?? DATE_FALLBACK)) best = candidate;
  }

  return best;
}

const DATE_FALLBACK = 99;

function draftLine(item: {
  kind: AsideKind;
  about: string;
  content: string;
  days: number | null;
}): string | null {
  if (item.kind === "unresolved") return unresolvedLine(item.about, item.content);
  if (item.kind === "question") return questionLine(item.about, item.content);
  if (item.kind === "promise") return promiseLine(item.about, item.content);
  if (item.kind === "due") return dueLine(item.about);
  if (item.days === null) return null;

  return dateLine(item.about, item.days);
}

function unresolvedLine(about: string, content: string): string | null {
  const subject = specific(about);
  const detail = speakable(content);

  if (subject && detail && !detail.includes(subject)) {
    return `${subject}那件，我还放着。${detail}。`;
  }

  if (subject) return `${subject}那件，我还放着。`;
  if (detail) return `${detail}。这件我还放着。`;

  return null;
}

function questionLine(about: string, content: string): string | null {
  const detail = speakable(content);
  const subject = specific(about);

  if (detail) {
    const body =
      subject && !detail.includes(subject) ? `${subject}，${detail}` : detail;
    const asked = /[吗呢么?？]$/.test(body) ? body : `${body}吗`;

    return `${asked}。`;
  }

  if (subject) return `${subject}那件，我还没问完。`;

  return null;
}

function promiseLine(about: string, content: string): string | null {
  const subject = specific(about);
  const detail = speakable(content);

  if (detail && subject && !detail.includes(subject)) {
    return `${subject}那件还没做完。${detail}。`;
  }

  if (detail) return `${detail}。这件还没做完。`;
  if (subject) return `${subject}这件还没做完。`;

  return null;
}

function dueLine(title: string): string | null {
  const subject = specific(title) ?? speakable(title);

  if (!subject) return null;

  return `${subject}的时间到了。`;
}

function dateLine(label: string, days: number): string | null {
  const name = label.trim();

  if (name.length < 2 || inventsCompanionLife(name, name)) return null;
  if (days === 0) return `${name}就是今天。`;
  if (days === 1) return `${name}就在明天。`;

  return `${name}还有${dayCount(days)}天。`;
}

function specific(about: string): string | null {
  const subject = about.trim();

  if (subject.length < 2 || GENERIC_ABOUT.has(subject)) return null;
  if (inventsCompanionLife(subject, subject)) return null;

  return subject;
}

function speakable(content: string): string | null {
  const text = content.trim().replace(/[。！？?]+$/g, "");

  if (text.length < 2 || text.length > 42) return null;
  if (/用户|系统|档案|内部/.test(text)) return null;
  if (inventsCompanionLife(text, text)) return null;

  return text;
}

function dueInstant(task: DueMatter): number | null {
  const times = [task.dueAt, task.reminderAt]
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((value) => Number.isFinite(value));

  if (times.length === 0) return null;

  return Math.min(...times);
}

function normalize(
  about: string,
  content: string,
): { about: string; content: string } | null {
  const subject = about.trim();
  const detail = content.trim();

  if (!subject && !detail) return null;
  if (inventsCompanionLife(subject, detail || subject)) return null;

  return { about: subject, content: detail || subject };
}

function isSpoken(ref: MatterRef, spoken: readonly MatterRef[]): boolean {
  return spoken.some(
    (item) => item.key === ref.key && item.revision === ref.revision,
  );
}

function apartLongEnough(awayAt: string | null, nowMs: number): boolean {
  if (!awayAt) return false;

  const parsed = Date.parse(awayAt);

  if (!Number.isFinite(parsed)) return false;

  return nowMs - parsed >= ASIDE_GAP_MS;
}

function dayCount(days: number): string {
  if (days >= 0 && days <= 7) return DAY_WORD[days] ?? String(days);

  return String(days);
}
