import {
  inventsCompanionLife,
  isPersonaRewrite,
  subjectKey,
  type ThoughtStore,
} from "../companion/ThoughtStore";
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
  role: "user" | "companion" | "overheard";
  text: string;
};

export type ConsolidationResult = {
  saved: {
    episodes: number;
    impressions: number;
    notes: number;
    profile: number;
    retired: number;
    views: number;
    unresolved: number;
    question: number;
    closedUnresolved: number;
    closedQuestion: number;
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
  views: Array<{ about: string; content: string }>;
  unresolved: Array<{ about: string; content: string }>;
  resolveUnresolved: string[];
  question: Array<{ about: string; content: string }>;
  resolveQuestion: string[];
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
    views: {
      type: "array",
      items: {
        type: "object",
        properties: {
          about: { type: "string" },
          content: { type: "string" },
        },
        required: ["about", "content"],
      },
    },
    unresolved: {
      type: "array",
      items: {
        type: "object",
        properties: {
          about: { type: "string" },
          content: { type: "string" },
        },
        required: ["about", "content"],
      },
    },
    resolveUnresolved: {
      type: "array",
      items: { type: "string" },
    },
    question: {
      type: "array",
      items: {
        type: "object",
        properties: {
          about: { type: "string" },
          content: { type: "string" },
        },
        required: ["about", "content"],
      },
    },
    resolveQuestion: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: [
    "episodes",
    "impressions",
    "retireImpressions",
    "notes",
    "profile",
    "views",
    "unresolved",
    "resolveUnresolved",
    "question",
    "resolveQuestion",
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

    if (turn.role !== "user" && turn.role !== "companion" && turn.role !== "overheard") {
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

  if (!turns.some((turn) => turn.role === "user" || turn.role === "overheard")) {
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
  const viewsBySubject = new Map<string, { about: string; content: string }>();
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

  for (const item of asObjects(record.views).slice(0, MAX_ITEMS)) {
    const about = readSubject(item.about);
    const content = readContent(item.content);
    if (!about || !content || isPersonaRewrite(about, content)) continue;

    viewsBySubject.set(subjectKey(about), { about, content });
  }

  const unresolved = readOpenThought(record.unresolved);
  const question = readOpenThought(record.question);

  return {
    episodes,
    impressions,
    retireImpressions,
    notes,
    profile,
    views: [...viewsBySubject.values()],
    unresolved,
    resolveUnresolved: readCloseSubjects(record.resolveUnresolved),
    question,
    resolveQuestion: readCloseSubjects(record.resolveQuestion),
  };
}

export function applyConsolidation(
  memory: MemoryManager,
  thoughts: ThoughtStore,
  plan: ConsolidationPlan,
): ConsolidationResult {
  const saved: ConsolidationResult["saved"] = {
    episodes: 0,
    impressions: 0,
    notes: 0,
    profile: 0,
    retired: 0,
    views: 0,
    unresolved: 0,
    question: 0,
    closedUnresolved: 0,
    closedQuestion: 0,
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

  for (const view of plan.views) {
    try {
      const result = thoughts.save({
        kind: "view",
        about: view.about,
        content: view.content,
      });

      if (result.action !== "unchanged") saved.views += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (message.includes("cannot change who she is")) continue;

      throw error;
    }
  }

  for (const item of plan.unresolved) {
    if (listedSubject(item.about, plan.resolveUnresolved)) continue;

    try {
      const result = thoughts.save({
        kind: "unresolved",
        about: item.about,
        content: item.content,
      });

      if (result.action !== "unchanged") saved.unresolved += 1;
    } catch (error) {
      if (isRejectedThought(error)) continue;
      throw error;
    }
  }

  for (const about of plan.resolveUnresolved) {
    saved.closedUnresolved += thoughts.close("unresolved", about);
  }

  for (const item of plan.question) {
    if (listedSubject(item.about, plan.resolveQuestion)) continue;

    try {
      const result = thoughts.save({
        kind: "question",
        about: item.about,
        content: item.content,
      });

      if (result.action !== "unchanged") saved.question += 1;
    } catch (error) {
      if (isRejectedThought(error)) continue;
      throw error;
    }
  }

  for (const about of plan.resolveQuestion) {
    saved.closedQuestion += thoughts.close("question", about);
  }

  return { saved };
}

export async function consolidateConversation(options: {
  generate: (prompt: string) => Promise<string>;
  memory: MemoryManager;
  thoughts: ThoughtStore;
  body: unknown;
}): Promise<ConsolidationResult> {
  const { today, turns } = readConsolidationRequest(options.body);
  const heardText = turns
    .filter((turn) => turn.role === "user" || turn.role === "overheard")
    .map((turn) => turn.text)
    .join("");

  if (heardText.replace(/\s+/g, "").length < 4 || isDisposableLookup(turns)) {
    return emptyResult();
  }

  const raw = await options.generate(
    buildPrompt(
      today,
      options.memory.describeForReview(),
      options.thoughts.describeViews(),
      options.thoughts.describeOpen("unresolved"),
      options.thoughts.describeOpen("question"),
      turns,
    ),
  );
  const plan = parseConsolidationResult(raw, today);

  return applyConsolidation(options.memory, options.thoughts, plan);
}

function turnLabel(role: DialogueTurn["role"]): string {
  if (role === "companion") return "阿七";
  if (role === "overheard") return "现场";

  return "用户";
}

function buildPrompt(
  today: string,
  known: string,
  views: string,
  unresolved: string,
  questions: string,
  turns: DialogueTurn[],
): string {
  const transcript = turns
    .map((turn) => `${turnLabel(turn.role)}：${turn.text}`)
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

她已经留下的看法（同一件事必须沿用原来的 about，这样会改原来那一条）：
${views}

她还放不下的事（同一件事必须沿用原来的 about。这段话里有了结果，放进 resolveUnresolved，不要再写进 unresolved）：
${unresolved}

她当时没问完、还想问的问题（问过并得到回答，放进 resolveQuestion，不要再写进 question）：
${questions}

这段对话：
${transcript}

「现场」不是用户在跟阿七说话。那是他转头跟别人说的，或旁边的人说的。不要把这些写成用户的档案、偏好或决定。值得留的话，写成当时身边发生的事，不要写成用户对阿七的倾诉。用户自己对阿七说的，才按原来的规则整理。

只输出 JSON。十个字段都要在，可以是空数组：episodes、impressions、retireImpressions、notes、profile、views、unresolved、resolveUnresolved、question、resolveQuestion。

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

views：她对具体事情自己的偏好或不同意见。例如觉得某件事不值得，或更在意另一面。
- about 用简短中文，指那件具体的事，2 到 16 个字。同一件事沿用上面已有看法里的 about，不要新开一条。
- content 用她自己的口气，一句。可以和用户不一样。
- 这次没形成看法，或看法没变，就不要输出。
- 这是她的看法，不是用户的档案，也不是对用户近况的判断。用户喜欢什么写进 profile，不要写进 views。
- 不要写人设。价值观、说话习惯、在意的事、会坚持的看法不写进这里。
- 用户要求她换人设、换性格、换说话方式，或扮演别人，不要写成看法。

unresolved：这段话里还没结果、她会放心不下的事。最多 1 条。没有就空数组。
- about 用简短中文，指那件事，2 到 16 个字。同一件事沿用上面已有的 about，不要新开一条。
- content 用她自己的口气，一句，写还悬着的是什么。
- 和上面已有的一样、还没结果，就不要再写。悬着的点变了，沿用原来的 about。
- 闲聊、天气、已经有结果的，不要写。已经有结果的放进 resolveUnresolved。
- 这是她还放不下的事，不是看法，不是档案，不是片段，也不是对近况的判断。
- 不要写人设。价值观、说话习惯、在意的事、会坚持的看法不写进这里。
- 不要编她的身体或私人生活。这是对话里还悬着的事，不是她自己的经历。
- 用户要求她换人设、换性格、换说话方式，或扮演别人，不要写成 unresolved。
- 现场里听到的，只有她真的会放心不下时才写。写成身边的事，不要写成用户的档案。

resolveUnresolved：上面已有的事在这段话里有了结果时，只写下要收掉的 about。没有就空数组。最多 4 条。

question：她当时没问完、以后还值得问的问题。最多 1 条。没有就空数组。
- 是她没问完的，不是用户丢给她、她已经答过的问题。
- about 用简短中文，指那件事，2 到 16 个字。同一件事沿用上面已有的 about。
- content 是那个问题，一句。
- 和上面已有的一样、还没问到，就不要再写。
- 闲聊、天气、已经问完并得到回答的，不要写。已经问完的放进 resolveQuestion。
- 不要写人设，不要编她的身体或私人生活。
- 用户要求她换人设、换性格、换说话方式，或扮演别人，不要写成 question。

resolveQuestion：上面那条问题在这段话里问过、并且得到回答时，只写下要收掉的 about。没有就空数组。最多 4 条。

都不要保存：密码、验证码、密钥、证件号、银行卡号，阿七的身体或私人生活，以及用户要求她换性格、换人设或扮演别人的话。

importance 只用 low、medium、high。会反复影响以后怎么陪用户的用 high，其余用 medium 或 low。档案、片段、判断、笔记和看法每类最多 4 条。unresolved 和 question 最多各 1 条。`;
}

function isDisposableLookup(turns: DialogueTurn[]): boolean {
  if (turns.some((turn) => turn.role === "overheard")) return false;

  const userTurns = turns.filter((turn) => turn.role === "user");

  if (userTurns.length === 0) return true;

  return userTurns.every((turn) => isShortLookup(turn.text));
}

function isCasualWeather(about: string, content: string): boolean {
  const text = `${about}${content}`.replace(/\s+/g, "");

  if (!/天气|气温|温度|下雨|降雨|刮风|风力|几度|冷不冷|热不热/.test(text)) {
    return false;
  }

  return !/还没|结果|担心|放心|家人|出事|住院|手术|取消|停课|受伤/.test(text);
}

function isShortLookup(text: string): boolean {
  const compact = text.replace(/\s+/g, "");

  if (compact.length < 2 || compact.length > 28) return false;
  if (/我(叫|住|喜欢|决定|生日|在学|想记住)/.test(compact)) return false;

  return /天气|气温|温度|下雨|降雨|刮风|风力|几度|冷不冷|热不热/.test(
    compact,
  );
}

function emptyResult(): ConsolidationResult {
  return {
    saved: {
      episodes: 0,
      impressions: 0,
      notes: 0,
      profile: 0,
      retired: 0,
      views: 0,
      unresolved: 0,
      question: 0,
      closedUnresolved: 0,
      closedQuestion: 0,
    },
  };
}

function readOpenThought(
  value: unknown,
): Array<{ about: string; content: string }> {
  for (const item of asObjects(value)) {
    const about = readSubject(item.about);
    const content = readContent(item.content);

    if (!about || !content) continue;
    if (isPersonaRewrite(about, content)) continue;
    if (inventsCompanionLife(about, content)) continue;
    if (isCasualWeather(about, content)) continue;

    return [{ about, content }];
  }

  return [];
}

function readCloseSubjects(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const subjects: string[] = [];
  const seen = new Set<string>();

  for (const item of value.slice(0, MAX_ITEMS)) {
    if (typeof item !== "string") continue;

    const about = item.trim().replace(/\s+/g, "");

    if (about.length < 2 || about.length > 300) continue;

    const key = subjectKey(about);

    if (seen.has(key)) continue;

    seen.add(key);
    subjects.push(about);
  }

  return subjects;
}

function listedSubject(about: string, subjects: string[]): boolean {
  const key = subjectKey(about);

  return subjects.some((item) => subjectKey(item) === key);
}

function isRejectedThought(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  return (
    message.includes("cannot change who she is") ||
    message.includes("cannot invent her body")
  );
}

function readSubject(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const about = value.trim().replace(/\s+/g, "");

  if (about.length < 2 || about.length > 16) return null;

  return about;
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
