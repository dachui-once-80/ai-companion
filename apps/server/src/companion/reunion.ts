/**
 * 隔了三个小时以上再连上、对方还没开口时，先说一句很短的开场。
 * 只从还放不下的事、没问完的问题、还没完成的约定、临近的在意的日子里挑一件。
 * 远近决定能不能提：刚认识只打招呼；常聊只轻轻接一件和最近有关的；很熟可以先提一件还悬着的。
 * 没有可接的，就只打招呼。不开口汇报她这段时间做了什么。
 */

import { REUNION_GAP_MS } from "../affect/affect";
import { contentKey } from "../memory/openMemory";
import type { ClosenessTier } from "./closeness";
import { inventsCompanionLife, subjectKey } from "./ThoughtStore";

/** 常聊只接这么近还留着的事。再早的，等对方聊到再接。 */
export const RECENT_MATTER_MS = 7 * 24 * 60 * 60 * 1000;

/** 在意的日子落在这几天里，才算临近。 */
export const DATE_NEAR_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

const HANGING_KINDS = ["unresolved", "question", "promise"] as const;

type HangingKind = (typeof HANGING_KINDS)[number];

const KIND_LABEL: Record<HangingKind, string> = {
  unresolved: "还放不下的事",
  question: "没问完的问题",
  promise: "还没完成的约定",
};

const KIND_RANK: Record<HangingKind, number> = {
  unresolved: 0,
  question: 1,
  promise: 2,
};

const GENERIC_ABOUT = new Set([
  "约定",
  "那件",
  "那句",
  "这件事",
  "旧事",
]);

export type ReunionMatter = {
  about: string;
  content: string;
  updatedAt: string;
};

export type ReunionDate = {
  date: string;
  yearly: boolean;
  label: string;
};

export type MatterRef = {
  key: string;
  revision: string;
};

export type ReunionOpening = {
  apart: boolean;
  matter: string | null;
  cue: string;
  matterKey: string | null;
  matterRevision: string | null;
};

export function hangingRef(
  kind: HangingKind,
  about: string,
  content: string,
): MatterRef {
  return {
    key: `${kind}:${subjectKey(about)}`,
    revision: contentKey(content),
  };
}

export function dateRef(date: string, label: string): MatterRef {
  const labelKey = contentKey(label);

  return {
    key: `date:${date}:${labelKey}`,
    revision: `${date}:${labelKey}`,
  };
}

type Picked = {
  kind: HangingKind | "date";
  text: string;
  ref: MatterRef;
};

export function buildReunionOpening(input: {
  nowMs: number;
  lastSeenAt: string | null;
  tier: ClosenessTier;
  unresolved: readonly ReunionMatter[];
  questions: readonly ReunionMatter[];
  promises: readonly ReunionMatter[];
  dates: readonly ReunionDate[];
  /** 已经留过或说过的同一版本。开场换下一件，没有就只打招呼。 */
  skip?: readonly MatterRef[];
}): ReunionOpening {
  if (!apartLongEnough(input.lastSeenAt, input.nowMs)) {
    return {
      apart: false,
      matter: null,
      cue: "",
      matterKey: null,
      matterRevision: null,
    };
  }

  const picked = pickOne(input);
  const matter = picked?.text ?? null;

  return {
    apart: true,
    matter,
    cue: reunionCue(input.tier, picked),
    matterKey: picked?.ref.key ?? null,
    matterRevision: picked?.ref.revision ?? null,
  };
}

function pickOne(input: {
  nowMs: number;
  tier: ClosenessTier;
  unresolved: readonly ReunionMatter[];
  questions: readonly ReunionMatter[];
  promises: readonly ReunionMatter[];
  dates: readonly ReunionDate[];
  skip?: readonly MatterRef[];
}): Picked | null {
  if (input.tier === "刚认识") return null;

  const hanging = pickHanging(
    input.tier,
    input.nowMs,
    [
      ...tagged("unresolved", input.unresolved),
      ...tagged("question", input.questions),
      ...tagged("promise", input.promises),
    ],
    input.skip,
  );

  if (hanging) {
    return {
      kind: hanging.kind,
      text: renderMatter(KIND_LABEL[hanging.kind], hanging.about, hanging.content),
      ref: hangingRef(hanging.kind, hanging.about, hanging.content),
    };
  }

  const date = pickDate(input.dates, new Date(input.nowMs), input.skip);

  if (!date) return null;

  return { kind: "date", text: date.text, ref: date.ref };
}

function tagged(
  kind: HangingKind,
  items: readonly ReunionMatter[],
): Array<ReunionMatter & { kind: HangingKind }> {
  return items.flatMap((item) => {
    const usable = normalizeMatter(item);

    if (!usable) return [];

    return [{ ...item, ...usable, kind }];
  });
}

function pickHanging(
  tier: ClosenessTier,
  nowMs: number,
  items: Array<ReunionMatter & { kind: HangingKind }>,
  skip: readonly MatterRef[] | undefined,
): (ReunionMatter & { kind: HangingKind }) | null {
  const pool =
    tier === "常聊"
      ? items.filter((item) => isRecent(item.updatedAt, nowMs))
      : items;

  pool.sort(
    (a, b) =>
      b.updatedAt.localeCompare(a.updatedAt) ||
      KIND_RANK[a.kind] - KIND_RANK[b.kind],
  );

  return (
    pool.find(
      (item) => !isSkipped(hangingRef(item.kind, item.about, item.content), skip),
    ) ?? null
  );
}

function pickDate(
  dates: readonly ReunionDate[],
  now: Date,
  skip: readonly MatterRef[] | undefined,
): { text: string; ref: MatterRef } | null {
  const near: Array<{ days: number; text: string; ref: MatterRef }> = [];

  for (const item of dates) {
    const days = daysUntilImportant(item, now);

    if (days === null) continue;

    near.push({
      days,
      text: renderDate(item.label, days),
      ref: dateRef(item.date, item.label.trim()),
    });
  }

  near.sort((a, b) => a.days - b.days);

  return near.find((item) => !isSkipped(item.ref, skip)) ?? null;
}

function isSkipped(ref: MatterRef, skip: readonly MatterRef[] | undefined): boolean {
  if (!skip || skip.length === 0) return false;

  return skip.some((item) => item.key === ref.key && item.revision === ref.revision);
}

function reunionCue(tier: ClosenessTier, picked: Picked | null): string {
  const head =
    "你们隔了三个小时以上，对方还没开口。你先说一句很短的开场，最多两句。";
  const tail =
    "不要汇报你这段时间做了什么。不要编你睡过、吃过，或度过了怎样的一天。分开了多久不是要讲的事。";

  if (!picked || tier === "刚认识") {
    return `${head}只打招呼，不翻旧事。${tail}`;
  }

  if (tier === "常聊") {
    return `${head}轻轻接这一件和最近有关的：${picked.text}。不要再提别的旧事。${tail}`;
  }

  if (picked.kind === "date") {
    return `${head}只提这一件临近的日子：${picked.text}。不要再提别的旧事。${tail}`;
  }

  return `${head}先提这一件还悬着的：${picked.text}。不要再提别的旧事。${tail}`;
}

function normalizeMatter(
  item: ReunionMatter,
): { about: string; content: string } | null {
  const about = item.about.trim();
  const content = item.content.trim();

  if (!about && !content) return null;
  if (inventsCompanionLife(about, content || about)) return null;

  return { about, content: content || about };
}

function renderMatter(label: string, about: string, content: string): string {
  const subject = about.trim();
  const detail = content.trim() || subject;

  if (!subject || subject === detail || GENERIC_ABOUT.has(subject) || detail.includes(subject)) {
    return `${label}：${detail}`;
  }

  return `${label}：${subject}，${detail}`;
}

function renderDate(label: string, days: number): string {
  const when = days === 0 ? "就是今天" : days === 1 ? "就在明天" : `还有 ${days} 天`;

  return `在意的日子临近了：${label.trim()}，${when}`;
}

function isRecent(updatedAt: string, nowMs: number): boolean {
  const parsed = Date.parse(updatedAt);

  if (!Number.isFinite(parsed)) return false;

  return nowMs - parsed <= RECENT_MATTER_MS;
}

function apartLongEnough(lastSeenAt: string | null, nowMs: number): boolean {
  if (!lastSeenAt) return false;

  const parsed = Date.parse(lastSeenAt);

  if (!Number.isFinite(parsed)) return false;

  return nowMs - parsed >= REUNION_GAP_MS;
}

export function daysUntilImportant(item: ReunionDate, now: Date): number | null {
  const label = item.label.trim();

  if (label.length < 2) return null;

  const today = utcDay(now.getFullYear(), now.getMonth() + 1, now.getDate());
  const parsed = splitDate(item.date);

  if (today === null || !parsed) return null;

  if (parsed.year !== null) {
    const target = utcDay(parsed.year, parsed.month, parsed.day);

    if (target === null) return null;

    return withinNear(target, today);
  }

  const year = now.getFullYear();
  let target = utcDay(year, parsed.month, parsed.day);

  if (target === null) return null;

  if (target < today) {
    if (!item.yearly) return null;

    target = utcDay(year + 1, parsed.month, parsed.day);

    if (target === null) return null;
  }

  return withinNear(target, today);
}

function withinNear(target: number, today: number): number | null {
  const days = Math.round((target - today) / DAY_MS);

  if (days < 0 || days > DATE_NEAR_DAYS) return null;

  return days;
}

function splitDate(
  value: string,
): { year: number | null; month: number; day: number } | null {
  const full = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());

  if (full) {
    return {
      year: Number(full[1]),
      month: Number(full[2]),
      day: Number(full[3]),
    };
  }

  const monthDay = /^(\d{2})-(\d{2})$/.exec(value.trim());

  if (!monthDay) return null;

  return {
    year: null,
    month: Number(monthDay[1]),
    day: Number(monthDay[2]),
  };
}

function utcDay(year: number, month: number, day: number): number | null {
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date.getTime();
}
