import {
  inventsCompanionLife,
  isPersonaRewrite,
  subjectKey,
} from "../companion/ThoughtStore";
import type { MemoryImportance } from "./MemoryTypes";
import { contentKey } from "./openMemory";

/**
 * 你们之间怎么相处。和档案、片段、判断、笔记分开。
 *
 * address：怎么称呼对方。一直生效。
 * listen：哪一类事要先听完再给办法。一直生效。
 * hold：哪一件事不能先给建议。一直生效。
 * joke：变成内部笑话的那句。只有聊到那句才带上。
 * promise：答应过但还没做的事。只有聊到那件事才带上。做完就收掉。
 */
export const BETWEEN_KINDS = [
  "address",
  "joke",
  "listen",
  "promise",
  "hold",
] as const;

export type BetweenKind = (typeof BETWEEN_KINDS)[number];

const STANDING = new Set<BetweenKind>(["address", "listen", "hold"]);

/** 每次连线里，一直生效的相处方式只带这么多。 */
export const STANDING_LIMIT = 4;

/** 和当前话题相关的笑话、未完成的约定，另带这么多。 */
export const TOPIC_LIMIT = 4;

const KIND_LABEL: Record<BetweenKind, string> = {
  address: "称呼",
  joke: "笑话",
  listen: "先听完",
  promise: "还没做",
  hold: "先别建议",
};

const KIND_RANK: Record<BetweenKind, number> = {
  address: 0,
  listen: 1,
  hold: 2,
  joke: 3,
  promise: 4,
};

const IMPORTANCE_RANK: Record<MemoryImportance, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const STOP = new Set([
  "我们",
  "你们",
  "他们",
  "她们",
  "这个",
  "那个",
  "什么",
  "怎么",
  "如何",
  "一下",
  "一个",
  "不是",
  "没有",
  "自己",
  "用户",
  "今天",
  "昨天",
  "时候",
  "知道",
  "可以",
  "因为",
  "所以",
  "然后",
  "已经",
  "还是",
  "就是",
  "以后",
  "说好",
]);

export type BetweenRecord = {
  kind: BetweenKind;
  about: string;
  content: string;
  importance: MemoryImportance;
  updatedAt: string;
};

export function isBetweenKind(value: string): value is BetweenKind {
  return (BETWEEN_KINDS as readonly string[]).includes(value);
}

export function isStandingKind(kind: BetweenKind): boolean {
  return STANDING.has(kind);
}

export function betweenLabel(kind: BetweenKind): string {
  return KIND_LABEL[kind];
}

export function betweenKey(kind: BetweenKind, about: string): string {
  return `between:${kind}:${subjectKey(about)}`;
}

export function parseBetweenKey(
  key: string,
): { kind: BetweenKind; about: string } | null {
  const match = /^between:([^:]+):(.+)$/.exec(key.trim());

  if (!match) return null;

  const kind = match[1] ?? "";
  const about = match[2] ?? "";

  if (!isBetweenKind(kind) || !about) return null;

  return { kind, about };
}

/** 换人设、换性格、换说话方式，以及编她的身体或私人生活，都不能进这一层。 */
export function rejectedBetween(about: string, content: string): boolean {
  if (isPersonaRewrite(about, content)) return true;
  if (inventsCompanionLife(about, content)) return true;

  const text = `${about}${content}`.replace(/\s+/g, "");

  return /换人设|换性格|换说话方式|换说话习惯|扮演别人|扮演另一个人/.test(text);
}

export function sameMemoryText(a: string, b: string): boolean {
  const left = contentKey(a);
  const right = contentKey(b);

  if (!left || !right) return false;
  if (left === right) return true;

  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;

  return shorter.length >= 4 && longer.includes(shorter);
}

/** 称呼句里已经带了这个名字时，不要再写成姓名档案。 */
export function blocksProfileName(name: string, addressContent: string): boolean {
  const nick = contentKey(name);
  const address = contentKey(addressContent);

  return nick.length >= 2 && address.includes(nick);
}

export function relatesToTopic(
  topic: string,
  about: string,
  content: string,
): boolean {
  const query = contentKey(topic);

  if (query.length < 2) return false;

  const aboutKey = contentKey(about);
  const hay = contentKey(`${about}${content}`);

  if (!hay) return false;
  if (hay.includes(query)) return true;
  if (aboutKey.length >= 2 && query.includes(aboutKey)) return true;

  return distinctivePieces(query).some((piece) => {
    if (!hay.includes(piece) || STOP.has(piece)) return false;
    if (piece.length >= 3) return true;

    return piece === aboutKey;
  });
}

/**
 * 模型若把相处方式写进笔记，抽到这一层。
 * 只认很窄的句式，普通决定和近况留在原来的层。
 */
export function classifyBetweenNote(
  content: string,
): { kind: BetweenKind; about: string } | null {
  const text = content.replace(/\s+/g, "");

  if (text.length < 4 || rejectedBetween(text, text)) return null;

  if (/内部笑话|成了梗|成了我们的梗|变成了笑话/.test(text)) {
    return { kind: "joke", about: "那句" };
  }

  if (
    /你先听|先听我说完|先听完再|别急着给(办法|建议|主意)|先别出主意/.test(text)
  ) {
    return { kind: "listen", about: "先听完" };
  }

  if (/(别|不要|先别).{0,6}(先给建议|给建议)|不能先给建议|先别给建议/.test(text)) {
    return { kind: "hold", about: "先别建议" };
  }

  if (
    /((你|她)答应|我答应你).{0,24}(还没|尚未|未做)/.test(text) ||
    /说好了.{0,16}还没/.test(text)
  ) {
    return { kind: "promise", about: "约定" };
  }

  if (
    /(以后)?(你|她)(就)?叫我(?!明天|一下|去|来|先|别)|称呼我|你喊我/.test(text) &&
    !/^我叫/.test(text)
  ) {
    return { kind: "address", about: "叫用户" };
  }

  return null;
}

export function selectBetween(
  items: readonly BetweenRecord[],
  topic: string,
): BetweenRecord[] {
  const standing = items
    .filter((item) => isStandingKind(item.kind))
    .sort(compareStanding)
    .slice(0, STANDING_LIMIT);

  const topical =
    topic.trim().length === 0
      ? []
      : items
          .filter(
            (item) =>
              !isStandingKind(item.kind) &&
              relatesToTopic(topic, item.about, item.content),
          )
          .sort(compareRecent)
          .slice(0, TOPIC_LIMIT);

  return [...standing, ...topical];
}

export function renderBetweenText(items: readonly BetweenRecord[]): string {
  if (items.length === 0) return "还没有。";

  return items
    .map((item) => `- ${betweenLabel(item.kind)}：${item.content}`)
    .join("\n");
}

export function describeBetweenText(items: readonly BetweenRecord[]): string {
  if (items.length === 0) return "还没有。";

  return items
    .map((item) => `- ${item.kind}｜${item.about}：${item.content}`)
    .join("\n");
}

function compareStanding(a: BetweenRecord, b: BetweenRecord): number {
  return (
    KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
    IMPORTANCE_RANK[b.importance] - IMPORTANCE_RANK[a.importance] ||
    b.updatedAt.localeCompare(a.updatedAt)
  );
}

function compareRecent(a: BetweenRecord, b: BetweenRecord): number {
  return (
    IMPORTANCE_RANK[b.importance] - IMPORTANCE_RANK[a.importance] ||
    b.updatedAt.localeCompare(a.updatedAt)
  );
}

function distinctivePieces(text: string): string[] {
  const pieces: string[] = [];
  const chinese = text.match(/[\u4e00-\u9fff]+/g) ?? [];

  for (const segment of chinese) {
    if (segment.length >= 2) pieces.push(segment);

    for (let i = 0; i < segment.length - 1; i++) {
      pieces.push(segment.slice(i, i + 2));
    }
  }

  for (const word of text.split(/[^a-z0-9]+/)) {
    if (word.length >= 2) pieces.push(word);
  }

  return pieces;
}
