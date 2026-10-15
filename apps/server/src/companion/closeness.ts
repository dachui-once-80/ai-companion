/**
 * 这一次连线算刚认识、常聊还是很熟。
 * 只从相处记录现算，不存成一档，也不改人设。
 *
 * 三样都要够到同一档，取最低的一档。缺任何一样就停在更远的地方。
 * 没有第一次记忆、也没有第一次连上，或留下的片段和笔记不够，就是刚认识。
 *
 * 远近说明里另外写已经记下的质地：第一次连上的日子、习惯的称呼、
 * 可以直说的、要先听完的。没有记录的那一项就不写，也不编。
 */

import { formatLocalDate } from "../memory/openMemory";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 满这些天数，时间才够得上常聊、很熟。 */
const FAMILIAR_DAYS = 7;
const CLOSE_DAYS = 30;

/** 当前还留着的片段和笔记加在一起。不到 4 条算没有足够记录。 */
const FAMILIAR_KEPT = 4;
const CLOSE_KEPT = 12;

/**
 * 温暖平时是 0.4。
 * 低于 0.32，这一项不够常聊。
 * 很熟要明显高于平时。不到 0.55，这一项只够常聊。
 */
const WARMTH_FAMILIAR = 0.32;
const WARMTH_CLOSE = 0.55;

export type ClosenessTier = "刚认识" | "常聊" | "很熟";

export type ClosenessMemory = {
  category: string;
  status: string;
  content: string;
  createdAt: string;
  key?: string;
};

export type ClosenessInput = {
  nowMs: number;
  firstSeenAt: string | null;
  warmth: number;
  memories: readonly ClosenessMemory[];
};

const TIER_RULE: Record<ClosenessTier, string> = {
  刚认识: "少把对方的事说成自己早就知道，少主动翻旧事，称呼保持普通。",
  常聊: "相关的旧事可以自然接，仍要等对方把话说完。",
  很熟: "可以更直接，不同意时更短，也可以先提一件你们早就在聊的事。",
};

export function resolveCloseness(input: ClosenessInput): {
  tier: ClosenessTier;
  text: string;
} {
  const kept = countKept(input.memories);
  const elapsedMs = elapsedSince(input.nowMs, input.firstSeenAt, input.memories);
  const level = Math.min(
    timeLevel(elapsedMs),
    recordLevel(kept),
    warmthLevel(input.warmth),
  );
  const tier = level === 2 ? "很熟" : level === 1 ? "常聊" : "刚认识";

  return { tier, text: renderCloseness(tier, readTexture(input)) };
}

export function renderCloseness(
  tier: ClosenessTier,
  texture: readonly string[] = [],
): string {
  const lines = [
    `这一次是「${tier}」。就按${tier}说话。`,
    `${tier}：${TIER_RULE[tier]}`,
  ];

  if (texture.length > 0) {
    lines.push(
      "",
      ...texture,
      "只使用上面记下的日子、称呼和话题。没写下的不要编。",
    );
  }

  lines.push(
    "",
    "三档是：",
    `刚认识：${TIER_RULE.刚认识}`,
    `常聊：${TIER_RULE.常聊}`,
    `很熟：${TIER_RULE.很熟}`,
    "",
    "这三档都不改价值观、说话习惯、在意的事、会坚持的看法和内心。",
    "不要出现亲昵到像恋人的话，除非用户自己把关系说成那样，并且已经写进记忆。",
  );

  return lines.join("\n");
}

/**
 * 只抄当前还留着的记录。
 * 称呼来自档案里的平时称呼，以及相处里另记的叫法。
 * 可以直说、要先听完，来自难过时怎么陪，以及要先听完、先别给建议的相处方式。
 */
function readTexture(input: ClosenessInput): string[] {
  const lines: string[] = [];
  const seen = Date.parse(input.firstSeenAt ?? "");

  if (Number.isFinite(seen)) {
    lines.push(`第一次连上是 ${formatLocalDate(new Date(seen))}。`);
  }

  const addresses: string[] = [];
  const direct: string[] = [];
  const listen: string[] = [];
  const hold: string[] = [];

  for (const memory of input.memories) {
    if (memory.status !== "current") continue;

    const content = memory.content.trim();
    if (!content) continue;

    const key = memory.key?.trim() ?? "";

    if (key === "preferred_address") {
      addresses.push(content);
      continue;
    }

    if (key === "when_sad") {
      const mode = whenSadMode(content);

      if (mode === "direct") direct.push(content);
      else if (mode === "listen") listen.push(content);

      continue;
    }

    if (memory.category !== "between") continue;

    const kind = betweenKind(key);

    if (kind === "address") addresses.push(content);
    else if (kind === "listen") listen.push(content);
    else if (kind === "hold") hold.push(content);
  }

  for (const content of unique(addresses).slice(0, 4)) {
    lines.push(`习惯的称呼：${content}`);
  }

  for (const content of unique(direct).slice(0, 4)) {
    lines.push(`可以直说：${content}`);
  }

  for (const content of unique(listen).slice(0, 4)) {
    lines.push(`要先听完：${content}`);
  }

  for (const content of unique(hold).slice(0, 4)) {
    lines.push(`先别给建议：${content}`);
  }

  return lines;
}

/** 相处记录的 key 是 between:kind:about。这里只用一直生效的三种。 */
function betweenKind(key: string): "address" | "listen" | "hold" | null {
  const match = /^between:(address|listen|hold):(.+)$/.exec(key);

  if (!match?.[2]) return null;

  return match[1] as "address" | "listen" | "hold";
}

/** 档案里难过时怎么陪，只认已经写明的两种。对不上就不归进直说或先听完。 */
function whenSadMode(content: string): "direct" | "listen" | null {
  const text = content.replace(/\s+/g, "");

  if (/想要办法|给我办法|想听建议|给我建议/.test(text)) return "direct";

  if (
    /先别给建议|别给建议|不要给建议|不要建议|别出主意|想先被听|想被听|先听我说|先听着|听完再说|先听完|别给办法|不要给办法/.test(
      text,
    )
  ) {
    return "listen";
  }

  return null;
}

function unique(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of items) {
    if (seen.has(item)) continue;

    seen.add(item);
    result.push(item);
  }

  return result;
}

function countKept(memories: readonly ClosenessMemory[]): number {
  let kept = 0;

  for (const memory of memories) {
    if (memory.status !== "current") continue;
    if (memory.content.trim().length === 0) continue;
    if (memory.category !== "episode" && memory.category !== "note") continue;

    kept += 1;
  }

  return kept;
}

/** 第一次有记忆，或第一次连上，取更早的那个。两个都没有就是还没开始。 */
function elapsedSince(
  nowMs: number,
  firstSeenAt: string | null,
  memories: readonly ClosenessMemory[],
): number | null {
  const marks: number[] = [];
  const seen = Date.parse(firstSeenAt ?? "");

  if (Number.isFinite(seen)) marks.push(seen);

  for (const memory of memories) {
    const created = Date.parse(memory.createdAt);

    if (Number.isFinite(created)) marks.push(created);
  }

  if (marks.length === 0) return null;

  return Math.max(0, nowMs - Math.min(...marks));
}

function timeLevel(elapsedMs: number | null): 0 | 1 | 2 {
  if (elapsedMs === null) return 0;
  if (elapsedMs < FAMILIAR_DAYS * DAY_MS) return 0;
  if (elapsedMs < CLOSE_DAYS * DAY_MS) return 1;

  return 2;
}

function recordLevel(kept: number): 0 | 1 | 2 {
  if (kept < FAMILIAR_KEPT) return 0;
  if (kept < CLOSE_KEPT) return 1;

  return 2;
}

function warmthLevel(warmth: number): 0 | 1 | 2 {
  if (!Number.isFinite(warmth) || warmth < WARMTH_FAMILIAR) return 0;
  if (warmth < WARMTH_CLOSE) return 1;

  return 2;
}
