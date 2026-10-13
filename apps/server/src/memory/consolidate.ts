import type { MemoryManager } from "./MemoryManager";
import { getMemoryCategory, isValidMemoryKey, listMemoryKeys } from "./MemoryPolicy";
import type { MemoryImportance } from "./MemoryTypes";
import {
  formatLocalDate,
  normalizeEpisodeDate,
  normalizeLabel,
  normalizeTheme,
} from "./openMemory";

export class ConsolidationInputError extends Error {}

export type DialogueTurn = {
  role: "user" | "companion";
  text: string;
};

export type ConsolidationResult = {
  saved: {
    episodes: number;
    impressions: number;
    notes: number;
    profile: number;
    retired: number;
  };
};

type PlannedItem = {
  content: string;
  importance: MemoryImportance;
};

type ConsolidationPlan = {
  episodes: Array<PlannedItem & { date: string }>;
  impressions: Array<PlannedItem & { theme: string }>;
  retireImpressions: string[];
  notes: Array<PlannedItem & { label: string }>;
  profile: Array<PlannedItem & { key: string }>;
};

const MAX_TURNS = 40;
const MAX_TURN_CHARS = 2_000;
const MAX_TOTAL_CHARS = 12_000;
const MAX_ITEMS = 4;
const MAX_CONTENT_CHARS = 500;

export const consolidationResponseSchema = {
  type: "object",
  properties: {
    episodes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          date: { type: "string" },
          content: { type: "string" },
          importance: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["date", "content", "importance"],
      },
    },
    impressions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          theme: { type: "string" },
          content: { type: "string" },
          importance: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["theme", "content", "importance"],
      },
    },
    retireImpressions: {
      type: "array",
      items: { type: "string" },
    },
    notes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          content: { type: "string" },
          importance: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["label", "content", "importance"],
      },
    },
    profile: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          content: { type: "string" },
          importance: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["key", "content", "importance"],
      },
    },
  },
  required: [
    "episodes",
    "impressions",
    "retireImpressions",
    "notes",
    "profile",
  ],
};

export function readConsolidationRequest(body: unknown): {
  today: string;
  turns: DialogueTurn[];
} {
  if (typeof body !== "object" || body === null) {
    throw new ConsolidationInputError("Request body is required");
  }

  const record = body as Record<string, unknown>;
  const today = resolveConversationDate(
    typeof record.occurredOn === "string" ? record.occurredOn : undefined,
  );

  if (!Array.isArray(record.turns) || record.turns.length === 0) {
    throw new ConsolidationInputError("turns are required");
  }

  if (record.turns.length > MAX_TURNS) {
    throw new ConsolidationInputError(`At most ${MAX_TURNS} turns`);
  }

  const turns: DialogueTurn[] = [];
  let total = 0;

  for (const item of record.turns) {
    if (typeof item !== "object" || item === null) {
      throw new ConsolidationInputError("Invalid turn");
    }

    const turn = item as Record<string, unknown>;

    if (turn.role !== "user" && turn.role !== "companion") {
      throw new ConsolidationInputError("Invalid turn role");
    }

    if (typeof turn.text !== "string") {
      throw new ConsolidationInputError("Invalid turn text");
    }

    const text = turn.text.trim().slice(0, MAX_TURN_CHARS);

    if (!text || text.includes("内部状态")) continue;

    total += text.length;

    if (total > MAX_TOTAL_CHARS) {
      throw new ConsolidationInputError("Transcript is too long");
    }

    turns.push({ role: turn.role, text });
  }

  if (!turns.some((turn) => turn.role === "user")) {
    throw new ConsolidationInputError("A user turn is required");
  }

  return { today, turns };
}

export function parseConsolidationResult(
  raw: string,
  today: string,
): ConsolidationPlan {
  const parsed: unknown = JSON.parse(stripJsonFence(raw));

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Consolidation response is not an object");
  }

  const record = parsed as Record<string, unknown>;
  const episodes: ConsolidationPlan["episodes"] = [];
  const impressions: ConsolidationPlan["impressions"] = [];
  const notes: ConsolidationPlan["notes"] = [];
  const profile: ConsolidationPlan["profile"] = [];
  const retireImpressions: string[] = [];

  for (const item of asObjects(record.episodes).slice(0, MAX_ITEMS)) {
    const content = readContent(item.content);
    if (!content) continue;

    episodes.push({
      date: normalizeEpisodeDate(readString(item.date), today),
      content,
      importance: readImportance(item.importance),
    });
  }

  for (const item of asObjects(record.impressions).slice(0, MAX_ITEMS)) {
    const theme = normalizeTheme(readString(item.theme) ?? "");
    const content = readContent(item.content);
    if (!theme || !content) continue;

    impressions.push({
      theme,
      content,
      importance: readImportance(item.importance),
    });
  }

  if (Array.isArray(record.retireImpressions)) {
    for (const item of record.retireImpressions.slice(0, MAX_ITEMS)) {
      if (typeof item !== "string") continue;
      const theme = normalizeTheme(item);
      if (theme) retireImpressions.push(theme);
    }
  }

  for (const item of asObjects(record.notes).slice(0, MAX_ITEMS)) {
    const label = normalizeLabel(readString(item.label) ?? "");
    const content = readContent(item.content);
    if (!label || !content) continue;

    notes.push({
      label,
      content,
      importance: readImportance(item.importance),
    });
  }

  for (const item of asObjects(record.profile).slice(0, MAX_ITEMS)) {
    const key = (readString(item.key) ?? "").trim();
    const content = readContent(item.content);
    if (!key || !content || !isValidMemoryKey(key)) continue;

    profile.push({
      key,
      content,
      importance: readImportance(item.importance),
    });
  }

  return {
    episodes,
    impressions,
    retireImpressions,
    notes,
    profile,
  };
}

export function applyConsolidation(
  memory: MemoryManager,
  plan: ConsolidationPlan,
): ConsolidationResult {
  const saved: ConsolidationResult["saved"] = {
    episodes: 0,
    impressions: 0,
    notes: 0,
    profile: 0,
    retired: 0,
  };

  for (const episode of plan.episodes) {
    const result = memory.saveEpisode(
      episode.date,
      episode.content,
      episode.importance,
    );

    if (result.action !== "unchanged") saved.episodes += 1;
  }

  for (const impression of plan.impressions) {
    const result = memory.saveImpression(
      impression.theme,
      impression.content,
      impression.importance,
    );

    if (result.action !== "unchanged") saved.impressions += 1;
  }

  const rewritten = new Set(
    plan.impressions.map((impression) => impression.theme),
  );

  for (const theme of plan.retireImpressions) {
    if (rewritten.has(theme)) continue;
    saved.retired += memory.retireImpression(theme);
  }

  for (const note of plan.notes) {
    const result = memory.saveNote(
      note.label,
      note.content,
      note.importance,
    );

    if (result.action !== "unchanged") saved.notes += 1;
  }

  for (const item of plan.profile) {
    const result = memory.remember({
      key: item.key,
      category: getMemoryCategory(item.key),
      content: item.content,
      importance: item.importance,
      source: "companion",
    });

    if (result.action !== "unchanged") saved.profile += 1;
  }

  return { saved };
}

export async function consolidateConversation(options: {
  generate: (prompt: string) => Promise<string>;
  memory: MemoryManager;
  body: unknown;
}): Promise<ConsolidationResult> {
  const { today, turns } = readConsolidationRequest(options.body);
  const userText = turns
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.text)
    .join("");

  if (userText.replace(/\s+/g, "").length < 4) {
    return emptyResult();
  }

  const raw = await options.generate(
    buildPrompt(today, options.memory.describeForReview(), turns),
  );
  const plan = parseConsolidationResult(raw, today);

  return applyConsolidation(options.memory, plan);
}

function buildPrompt(
  today: string,
  known: string,
  turns: DialogueTurn[],
): string {
  const transcript = turns
    .map((turn) => `${turn.role === "user" ? "用户" : "阿七"}：${turn.text}`)
    .join("\n");

  const keys = listMemoryKeys()
    .map(
      (item) =>
        `- ${item.key}（${item.category}，${item.cardinality === "single-current" ? "单值" : "可多值"}）`,
    )
    .join("\n");

  return `你在帮一个长期陪伴用户的人整理记忆。她刚刚和用户聊完下面这段话。今天是 ${today}。

你要决定什么值得以后还记得。没有值得留的就返回空数组。宁缺毋滥。

已经留下的记忆：
${known}

这段对话：
${transcript}

只输出 JSON。五个字段都要在，可以是空数组。

episodes：聊过的具体事情。以后用户问「昨天发生了什么」「前几天怎么了」时用得上。
- 写发生了什么，一两句话，不要写成聊天记录。
- date 用 YYYY-MM-DD。说的是今天的事就用 ${today}。说的是昨天或更早，按今天推算。推不出就用 ${today}。
- 问候、天气闲聊、复读，不要写。
- 不要和已有片段重复。

impressions：她对用户近况的判断，不是用户填的档案。例如「用户最近一直在加班，压力不小」。
- theme 用简短中文。同一件事沿用已有判断里的 theme，例如「加班」「压力」「睡眠」。
- content 用她注意到的口气，一句，称呼用「用户」。这是她的感觉，不要写成用户确认过的事实。
- 近况没变就不要再输出。变了就输出新的 content，同一 theme 的旧判断会被换掉。
- 没有依据不要推断。

retireImpressions：已有判断明显不再成立时，写下要收回的 theme。没有就空数组。

notes：整段话里值得以后再提起，但不是某一天的事件，也不是对近况的判断，也对不上下面的档案字段。例如一个决定、一件还没发生但用户放在心上的事。
- label 用简短中文。
- 不要和档案、片段、判断重复。

profile：只有用户在这段话里明确说出的稳定事实，而且 key 必须是下面之一。
${keys}
- 没说出口的不要推断。假设、玩笑、转述别人、没说完的，不要写。
- 和已有档案相同就不要写。没有把握就不要写。写错会盖掉旧的单值档案。

都不要保存：密码、验证码、密钥、证件号、银行卡号，以及用户要求她换性格或换人设的话。

importance 只用 low、medium、high。会反复影响以后怎么陪用户的用 high，其余用 medium 或 low。每类最多 4 条。`;
}

function emptyResult(): ConsolidationResult {
  return {
    saved: {
      episodes: 0,
      impressions: 0,
      notes: 0,
      profile: 0,
      retired: 0,
    },
  };
}

function resolveConversationDate(input: string | undefined): string {
  const today = formatLocalDate();

  if (!input || !/^\d{4}-\d{2}-\d{2}$/.test(input)) return today;

  const requested = Date.parse(`${input}T00:00:00`);
  const current = Date.parse(`${today}T00:00:00`);

  if (
    Number.isNaN(requested) ||
    Math.abs(requested - current) > 2 * 24 * 60 * 60 * 1000
  ) {
    return today;
  }

  return input;
}

function stripJsonFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1] ?? trimmed;
}

function asObjects(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];

  return value.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readContent(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const content = value.trim().slice(0, MAX_CONTENT_CHARS);
  return content.length >= 4 ? content : null;
}

function readImportance(value: unknown): MemoryImportance {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }

  return "medium";
}
