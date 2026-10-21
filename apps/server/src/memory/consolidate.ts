import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  inventsCompanionLife,
  isPersonaRewrite,
  subjectKey,
  type ThoughtStore,
} from "../companion/ThoughtStore";
import { db } from "../db";
import { consolidationReceipts } from "../db/schema";
import {
  blocksProfileName,
  classifyBetweenNote,
  isBetweenKind,
  rejectedBetween,
  sameMemoryText,
  type BetweenKind,
} from "./between";
import type { MemoryManager } from "./MemoryManager";
import { getMemoryCategory, isValidMemoryKey, listMemoryKeys } from "./MemoryPolicy";
import {
  describesWhenSad,
  explicitWhenSad,
  isUnstatedProfile,
  normalizeImportantDate,
} from "./profileFacts";
import type { MemoryImportance } from "./MemoryTypes";
import {
  formatLocalDate,
  normalizeEpisodeDate,
  normalizeLabel,
  normalizeTheme,
} from "./openMemory";
import {
  canonicalConsolidationPayloadJson,
  normalizeConsolidationOccurredOn,
  normalizeConsolidationTurnText,
} from "./consolidationPayload";

export class ConsolidationInputError extends Error {}

/** 同 batchId 已登记为另一份 payload。 */
export class ConsolidationPayloadConflictError extends Error {}

/**
 * 仅在 LLM `generate` 阶段识别到的配额／限流错误。
 * 路由层可据此返回 200 + retryAfterMs；apply／收据写入不得包装为此类。
 */
export class ConsolidationQuotaError extends Error {
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConsolidationQuotaError";
    this.retryAfterMs = retryAfterMs;
  }
}

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
    between: number;
    closedBetween: number;
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
  between: Array<PlannedItem & { kind: BetweenKind; about: string }>;
  resolveBetween: Array<{ kind: BetweenKind; about: string }>;
  views: Array<{ about: string; content: string }>;
  unresolved: Array<{ about: string; content: string }>;
  resolveUnresolved: string[];
  question: Array<{ about: string; content: string }>;
  resolveQuestion: string[];
};

const MAX_BETWEEN = 6;
const MAX_TURNS = 40;
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
    between: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["address", "joke", "listen", "promise", "hold"],
          },
          about: { type: "string" },
          content: { type: "string" },
          importance: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["kind", "about", "content", "importance"],
      },
    },
    resolveBetween: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["address", "joke", "listen", "promise", "hold"],
          },
          about: { type: "string" },
        },
        required: ["kind", "about"],
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
    "between",
    "resolveBetween",
    "views",
    "unresolved",
    "resolveUnresolved",
    "question",
    "resolveQuestion",
  ],
};

export type ConsolidationRequest = {
  today: string;
  turns: DialogueTurn[];
  batchId?: string;
  payloadHash?: string;
};

/**
 * 对**已规范化**的 occurredOn + turns 做 SHA-256 hex（Node sync）。
 * 不再二次 trim／过滤；canonical 见 consolidationPayload.ts。
 */
export function computeConsolidationPayloadHash(
  occurredOn: string,
  turns: readonly DialogueTurn[],
): string {
  return createHash("sha256")
    .update(canonicalConsolidationPayloadJson(occurredOn, turns), "utf8")
    .digest("hex");
}

/** 仅用于识别 generate 阶段的配额错误；不得用于 apply／DB 错误。 */
function generateQuotaRetryMs(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status: unknown }).status
      : undefined;
  const quota =
    status === 429 ||
    message.includes("RESOURCE_EXHAUSTED") ||
    message.includes("Quota exceeded");

  if (!quota) return null;

  const delay = message.match(/"retryDelay":"(\d+(?:\.\d+)?)s"/);

  if (delay) {
    return Math.ceil(Number(delay[1]) * 1000);
  }

  return 15 * 60 * 1000;
}

/**
 * 将 consolidate 失败映射为 HTTP 状态与 JSON 体。
 * 只有 ConsolidationQuotaError 会得到 200 + retryAfterMs。
 */
export function httpBodyForConsolidationError(error: unknown): {
  status: number;
  json: Record<string, unknown>;
} {
  if (error instanceof ConsolidationInputError) {
    return { status: 400, json: { error: error.message } };
  }

  if (error instanceof ConsolidationPayloadConflictError) {
    return { status: 409, json: { error: error.message } };
  }

  if (error instanceof ConsolidationQuotaError) {
    return {
      status: 200,
      json: {
        ...emptyResult(),
        retryAfterMs: error.retryAfterMs,
      },
    };
  }

  return {
    status: 502,
    json: {
      error: error instanceof Error ? error.message : String(error),
    },
  };
}

function readOptionalBatchId(record: Record<string, unknown>): string | undefined {
  if (!("batchId" in record) || record.batchId === undefined || record.batchId === null) {
    return undefined;
  }

  if (typeof record.batchId !== "string") {
    throw new ConsolidationInputError("batchId must be a string");
  }

  const batchId = record.batchId.trim();

  if (!batchId) {
    throw new ConsolidationInputError("batchId must not be empty");
  }

  if (batchId.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(batchId)) {
    throw new ConsolidationInputError("batchId is invalid");
  }

  return batchId;
}

function readOptionalPayloadHash(
  record: Record<string, unknown>,
  batchId: string | undefined,
): string | undefined {
  const raw = record.payloadHash ?? record.payload_hash;

  if (batchId === undefined) {
    if (raw !== undefined && raw !== null && raw !== "") {
      throw new ConsolidationInputError("payloadHash requires batchId");
    }

    return undefined;
  }

  if (typeof raw !== "string") {
    throw new ConsolidationInputError("payloadHash is required when batchId is set");
  }

  const payloadHash = raw.trim().toLowerCase();

  if (!/^[a-f0-9]{64}$/.test(payloadHash)) {
    throw new ConsolidationInputError("payloadHash must be a sha256 hex digest");
  }

  return payloadHash;
}

/**
 * 带 batchId 的新协议：严格日历日，不作两日窗口改写。
 * 使用 UTC 组件 round-trip，拒绝 02-31 等 Date.parse 溢出伪日期。
 */
export function parseStrictConsolidationOccurredOn(input: unknown): string {
  if (input === undefined || input === null) {
    throw new ConsolidationInputError("occurredOn is required when batchId is set");
  }

  if (typeof input !== "string") {
    throw new ConsolidationInputError("occurredOn must be a string");
  }

  const trimmed = input.trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new ConsolidationInputError("occurredOn must be YYYY-MM-DD");
  }

  const year = Number(trimmed.slice(0, 4));
  const month = Number(trimmed.slice(5, 7));
  const day = Number(trimmed.slice(8, 10));

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day)
  ) {
    throw new ConsolidationInputError("occurredOn is not a real calendar date");
  }

  const utc = new Date(Date.UTC(year, month - 1, day));

  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    throw new ConsolidationInputError("occurredOn is not a real calendar date");
  }

  return trimmed;
}

export function readConsolidationRequest(body: unknown): ConsolidationRequest {
  if (typeof body !== "object" || body === null) {
    throw new ConsolidationInputError("Request body is required");
  }

  const record = body as Record<string, unknown>;

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

    const text = normalizeConsolidationTurnText(turn.text);

    if (text === null) continue;

    total += text.length;

    if (total > MAX_TOTAL_CHARS) {
      throw new ConsolidationInputError("Transcript is too long");
    }

    turns.push({ role: turn.role, text });
  }

  if (!turns.some((turn) => turn.role === "user" || turn.role === "overheard")) {
    throw new ConsolidationInputError("A user turn is required");
  }

  const batchId = readOptionalBatchId(record);
  const payloadHash = readOptionalPayloadHash(record, batchId);

  // 方案 A：有 batchId 时保留经严格校验的原始日期；无 batchId 仍用两日窗口。
  const today =
    batchId !== undefined
      ? parseStrictConsolidationOccurredOn(record.occurredOn)
      : normalizeConsolidationOccurredOn(
          typeof record.occurredOn === "string" ? record.occurredOn : undefined,
          formatLocalDate(),
        );

  if (batchId !== undefined && payloadHash !== undefined) {
    const expected = computeConsolidationPayloadHash(today, turns);

    if (payloadHash !== expected) {
      throw new ConsolidationInputError("payloadHash does not match request body");
    }
  }

  return { today, turns, batchId, payloadHash };
}

function parseStoredResult(raw: string): ConsolidationResult {
  const parsed: unknown = JSON.parse(raw);

  if (typeof parsed !== "object" || parsed === null || !("saved" in parsed)) {
    throw new Error("Invalid consolidation receipt payload");
  }

  return parsed as ConsolidationResult;
}

function readReceipt(batchId: string): {
  payloadHash: string;
  result: ConsolidationResult;
} | null {
  const row = db
    .select()
    .from(consolidationReceipts)
    .where(eq(consolidationReceipts.batchId, batchId))
    .get();

  if (!row) return null;

  return {
    payloadHash: row.payloadHash,
    result: parseStoredResult(row.resultJson),
  };
}

function insertReceipt(input: {
  batchId: string;
  payloadHash: string;
  occurredOn: string;
  result: ConsolidationResult;
}): void {
  db.insert(consolidationReceipts)
    .values({
      batchId: input.batchId,
      payloadHash: input.payloadHash,
      resultJson: JSON.stringify(input.result),
      occurredOn: input.occurredOn,
      createdAt: new Date().toISOString(),
    })
    .run();
}

/**
 * 同步事务：再次查收据 → apply → 写收据。
 * LLM 不得进入此函数。
 */
export function commitConsolidationWithReceipt(options: {
  batchId: string;
  payloadHash: string;
  occurredOn: string;
  apply: () => ConsolidationResult;
}): ConsolidationResult {
  return db.transaction(
    () => {
      const existing = readReceipt(options.batchId);

      if (existing) {
        if (existing.payloadHash !== options.payloadHash) {
          throw new ConsolidationPayloadConflictError(
            "batchId was already used with a different payload",
          );
        }

        return existing.result;
      }

      const result = options.apply();

      insertReceipt({
        batchId: options.batchId,
        payloadHash: options.payloadHash,
        occurredOn: options.occurredOn,
        result,
      });

      return result;
    },
    { behavior: "immediate" },
  );
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
  const betweenByKey = new Map<string, ConsolidationPlan["between"][number]>();
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
    let content = readContent(item.content);
    if (!key || !content || !isValidMemoryKey(key)) continue;
    if (isUnstatedProfile(content)) continue;

    if (key === "important_date") {
      const normalized = normalizeImportantDate(content);
      if (!normalized) continue;
      content = normalized;
    }

    profile.push({
      key,
      content,
      importance: readImportance(item.importance),
    });
  }

  for (const item of asObjects(record.between).slice(0, MAX_BETWEEN)) {
    const kind = readString(item.kind) ?? "";
    const about = readSubject(item.about);
    const content = readContent(item.content);

    if (!isBetweenKind(kind) || !about || !content) continue;
    if (rejectedBetween(about, content)) continue;
    if ((kind === "hold" || kind === "listen") && describesWhenSad(content)) {
      continue;
    }

    betweenByKey.set(`${kind}:${subjectKey(about)}`, {
      kind,
      about,
      content,
      importance: readImportance(item.importance),
    });
  }

  const keptNotes: ConsolidationPlan["notes"] = [];

  for (const note of notes) {
    const lifted = classifyBetweenNote(note.content);

    if (
      lifted &&
      (lifted.kind === "hold" || lifted.kind === "listen") &&
      describesWhenSad(note.content)
    ) {
      continue;
    }

    if (lifted && !rejectedBetween(lifted.about, note.content)) {
      const key = `${lifted.kind}:${subjectKey(lifted.about)}`;
      const already = [...betweenByKey.values()].some((item) =>
        sameMemoryText(item.content, note.content),
      );

      if (!already && !betweenByKey.has(key)) {
        betweenByKey.set(key, {
          kind: lifted.kind,
          about: lifted.about,
          content: note.content,
          importance: note.importance,
        });
      }

      continue;
    }

    keptNotes.push(note);
  }

  for (const item of asObjects(record.views).slice(0, MAX_ITEMS)) {
    const about = readSubject(item.about);
    const content = readContent(item.content);
    if (!about || !content || isPersonaRewrite(about, content)) continue;

    viewsBySubject.set(subjectKey(about), { about, content });
  }

  const unresolved = readOpenThought(record.unresolved);
  const question = readOpenThought(record.question);

  const between = [...betweenByKey.values()].slice(0, MAX_BETWEEN);

  return {
    episodes,
    impressions,
    retireImpressions,
    notes: keptNotes.filter(
      (note) => !between.some((item) => sameMemoryText(note.content, item.content)),
    ),
    profile,
    between,
    resolveBetween: readResolveBetween(record.resolveBetween),
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
    between: 0,
    closedBetween: 0,
    retired: 0,
    views: 0,
    unresolved: 0,
    question: 0,
    closedUnresolved: 0,
    closedQuestion: 0,
  };

  for (const item of plan.between) {
    if (rejectedBetween(item.about, item.content)) continue;

    const result = memory.saveBetween(
      item.kind,
      item.about,
      item.content,
      item.importance,
    );

    if (result.action !== "unchanged") saved.between += 1;
  }

  for (const item of plan.resolveBetween) {
    const rewritten = plan.between.some(
      (kept) =>
        kept.kind === item.kind &&
        subjectKey(kept.about) === subjectKey(item.about),
    );

    if (rewritten) continue;

    saved.closedBetween += memory.retireBetween(item.kind, item.about);
  }

  for (const episode of plan.episodes) {
    if (overlapsBetween(episode.content, plan.between)) continue;

    const result = memory.saveEpisode(
      episode.date,
      episode.content,
      episode.importance,
    );

    if (result.action !== "unchanged") saved.episodes += 1;
  }

  for (const impression of plan.impressions) {
    if (overlapsBetween(impression.content, plan.between)) continue;

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
    if (overlapsBetween(note.content, plan.between)) continue;

    const result = memory.saveNote(
      note.label,
      note.content,
      note.importance,
    );

    if (result.action !== "unchanged") saved.notes += 1;
  }

  for (const item of plan.profile) {
    if (
      item.key === "user_name" &&
      plan.profile.some(
        (other) =>
          other.key === "preferred_address" &&
          blocksProfileName(item.content, other.content),
      )
    ) {
      continue;
    }

    if (overlapsBetween(item.content, plan.between, item.key)) continue;

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
  const { today, turns, batchId, payloadHash } =
    readConsolidationRequest(options.body);

  if (batchId !== undefined && payloadHash !== undefined) {
    const existing = readReceipt(batchId);

    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new ConsolidationPayloadConflictError(
          "batchId was already used with a different payload",
        );
      }

      return existing.result;
    }
  }

  const heardText = turns
    .filter((turn) => turn.role === "user" || turn.role === "overheard")
    .map((turn) => turn.text)
    .join("");

  const disposable =
    heardText.replace(/\s+/g, "").length < 4 || isDisposableLookup(turns);

  if (disposable) {
    const result = emptyResult();

    if (batchId !== undefined && payloadHash !== undefined) {
      return commitConsolidationWithReceipt({
        batchId,
        payloadHash,
        occurredOn: today,
        apply: () => result,
      });
    }

    return result;
  }

  // LLM 必须在事务外；仅此处的配额错误可包装为 ConsolidationQuotaError。
  let raw: string;

  try {
    raw = await options.generate(
      buildPrompt(
        today,
        options.memory.describeForReview(),
        options.memory.describeBetween(),
        options.thoughts.describeViews(),
        options.thoughts.describeOpen("unresolved"),
        options.thoughts.describeOpen("question"),
        turns,
      ),
    );
  } catch (error) {
    const retryAfterMs = generateQuotaRetryMs(error);

    if (retryAfterMs !== null) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ConsolidationQuotaError(message, retryAfterMs, { cause: error });
    }

    throw error;
  }

  const plan = parseConsolidationResult(raw, today);
  keepStatedWhenSad(plan, turns);

  if (batchId === undefined || payloadHash === undefined) {
    return applyConsolidation(options.memory, options.thoughts, plan);
  }

  return commitConsolidationWithReceipt({
    batchId,
    payloadHash,
    occurredOn: today,
    apply: () => applyConsolidation(options.memory, options.thoughts, plan),
  });
}

function keepStatedWhenSad(
  plan: ConsolidationPlan,
  turns: DialogueTurn[],
): void {
  const stance = statedWhenSad(turns);

  if (stance === "no") {
    plan.profile = plan.profile.filter((item) => item.key !== "when_sad");
    return;
  }

  if (stance !== "explicit") return;
  if (plan.profile.some((item) => item.key === "when_sad")) return;

  const said = turns
    .filter((turn) => turn.role === "user")
    .map((turn) => explicitWhenSad(turn.text))
    .find((item): item is string => item !== null);

  if (!said) return;

  plan.profile.push({
    key: "when_sad",
    content: said,
    importance: "high",
  });
}

function statedWhenSad(
  turns: DialogueTurn[],
): "explicit" | "mentioned" | "no" {
  let mentioned = false;

  for (const turn of turns) {
    if (turn.role !== "user") continue;
    if (explicitWhenSad(turn.text)) return "explicit";

    const compact = turn.text.replace(/\s+/g, "");

    if (isUnstatedProfile(compact)) continue;
    if (
      /(?:朋友|同事|同学|别人|他人|他说|她说)/.test(compact) &&
      !/我(?:自己)?(?:很|特别|有点|比较|真|挺)?(?:难过|伤心|难受|心情不好)/.test(
        compact,
      )
    ) {
      continue;
    }

    if (
      /(?:难过|伤心|难受|心情不好)/.test(compact) &&
      /(?:建议|被听|办法|听我说)/.test(compact)
    ) {
      mentioned = true;
    }
  }

  return mentioned ? "mentioned" : "no";
}

function turnLabel(role: DialogueTurn["role"]): string {
  if (role === "companion") return "阿七";
  if (role === "overheard") return "现场";

  return "用户";
}

function buildPrompt(
  today: string,
  known: string,
  betweenKnown: string,
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

你们之间已经记下的相处方式（同一条必须沿用原来的 kind 和 about，这样会改原来那一条）：
${betweenKnown}

她已经留下的看法（同一件事必须沿用原来的 about，这样会改原来那一条）：
${views}

她还放不下的事（同一件事必须沿用原来的 about。这段话里有了结果，放进 resolveUnresolved，不要再写进 unresolved）：
${unresolved}

她当时没问完、还想问的问题（问过并得到回答，放进 resolveQuestion，不要再写进 question）：
${questions}

这段对话：
${transcript}

「现场」不是用户在跟阿七说话。那是他转头跟别人说的，或旁边的人说的。不要把这些写成用户的档案、偏好或决定。值得留的话，写成当时身边发生的事，不要写成用户对阿七的倾诉。用户自己对阿七说的，才按原来的规则整理。

只输出 JSON。十二个字段都要在，可以是空数组：episodes、impressions、retireImpressions、notes、profile、between、resolveBetween、views、unresolved、resolveUnresolved、question、resolveQuestion。

episodes：聊过的具体事情。以后用户问「昨天发生了什么」「前几天怎么了」时用得上。
- 写发生了什么，一两句话，不要写成聊天记录。
- date 用 YYYY-MM-DD。说的是今天的事就用 ${today}。说的是昨天或更早，按今天推算。推不出就用 ${today}。
- 问候、天气闲聊、复读，不要写。
- 不要和已有片段重复。
- 平时怎么称呼、难过时想被听还是想要办法、作息、正在做的事、不想被碰的话题、在意的日子，不要写进片段。那些写进 profile。彼此的笑话、某一类事要先听完、答应了还没做的、某一件事不能先给建议，写进 between。

impressions：她对用户近况的判断，不是用户填的档案。例如「用户最近一直在加班，压力不小」。
- theme 用简短中文。同一件事沿用已有判断里的 theme，例如「加班」「压力」「睡眠」。
- content 用她注意到的口气，一句，称呼用「用户」。这是她的感觉，不要写成用户确认过的事实。
- 近况没变就不要再输出。变了就输出新的 content，同一 theme 的旧判断会被换掉。
- 没有依据不要推断。
- 怎么称呼、难过时想怎样被陪、作息、正在做的事、不想被碰的话题、在意的日子、笑话和还没做的约定，不要写成对近况的判断。

retireImpressions：已有判断明显不再成立时，写下要收回的 theme。没有就空数组。

notes：整段话里值得以后再提起，但不是某一天的事件，也不是对近况的判断，也对不上下面的档案字段，也不是你们怎么相处。例如一个决定、一件还没发生但用户放在心上的事。
- label 用简短中文。
- 不要和档案、片段、判断重复。
- 平时怎么称呼、难过时想被听还是想要办法、作息、正在做的事、不想被碰的话题、在意的日子，不要写进 notes。那些写 profile。彼此的笑话、某一类事要先听完、答应了还没做的、某一件事不能先给建议，只写 between。

profile：只有用户在这段话里明确说出的稳定事实，而且 key 必须是下面之一。
${keys}
- 没说出口的不要推断。假设、玩笑、转述别人、没说完的，不要写。
- 和已有档案相同就不要写。没有把握就不要写。写错会盖掉旧的单值档案。
- user_name 只在用户说出自己的姓名时写，例如「我叫张三」。用户规定平时怎么称呼，写 preferred_address，不要写成 user_name。
- when_sad：用户明确说自己难过、伤心或难受时，想先被听还是想要办法。例如「我难过时先别给建议」写成「难过时先别给建议」。单值。不要写成 between 的 listen 或 hold。
- preferred_address：平时怎么称呼他。单值。例如「叫我阿远」。
- daily_routine：大致作息，写成一句当前的描述。单值。用户更正时写新的一句。
- current_activity：用户说自己正在做的事。可多条。不是某一天的片段，也不是长期目标。
- avoid_topic：用户明确说不想被提起的话题。可多条。
- important_date：生日以外在意的日子，例如考试、纪念日。可多条。生日写 birthday，不要写这里。content 必须能读出日期：用户说了年月日就写「YYYY-MM-DD 名称」；说每年、纪念日这类重复的日子就写「每年 MM-DD 名称」；只说了月日、没说年份也没说每年，不要编年份，写「MM-DD 名称」。说「下周三」按今天 ${today} 推成 YYYY-MM-DD。推不出具体日期就不要写这条。
- when_sad、preferred_address、avoid_topic 用 high。

between：只记你们之间怎么相处。和片段、判断、笔记、档案不要重复。同一句话只放这里。
- kind 只能是 address、joke、listen、promise、hold。
- address：只在不是「平时怎么称呼」时才写。平时怎么称呼写 profile 的 preferred_address，不要再写 address。用户报自己的姓名不要写这里。
- joke：变成内部笑话的那一句。about 用那句的关键词，2 到 16 个字。
- listen：哪一类具体的事要先听完再给办法。about 用那一类，例如「烦心事」。难过时想被听还是想要办法不要写这里，写 when_sad。
- promise：答应过、还没做的事。about 用那件事。做完了放进 resolveBetween，不要留在这里。
- hold：哪一件具体的事不能先给建议。about 用那件事。难过时先别给建议不要写这里，写 when_sad。
- content 用一句。about 用简短中文，2 到 16 个字。同一条沿用上面已有的 kind 和 about。
- 没变成相处方式的闲聊不要写。没有就空数组。
- 用户要求她换人设、换性格、换说话方式，或扮演别人，不要写成 between。
- 不要编她的身体或私人生活。

resolveBetween：上面已有的相处方式不再成立，或答应的事做完了，只写下要收掉的 kind 和 about。没有就空数组。最多 6 条。不要把收掉的内容再写进 between。

views：她对具体事情自己的偏好或不同意见。例如觉得某件事不值得，或更在意另一面。
- about 用简短中文，指那件具体的事，2 到 16 个字。同一件事沿用上面已有看法里的 about，不要新开一条。
- content 用她自己的口气，一句。可以和用户不一样。
- 这次没形成看法，或看法没变，就不要输出。
- 同一件事她在这段话里改过口的，只输出最后那一条，about 沿用原来的。不要输出改口之前的内容。
- 这是她的看法，不是用户的档案，也不是对用户近况的判断。用户喜欢什么写进 profile，不要写进 views。
- 不要写人设。价值观、说话习惯、在意的事、会坚持的看法和内心不写进这里。
- 用户要求她换人设、换性格、换说话方式，或扮演别人，不要写成看法。

unresolved：这段话里还没结果、她会放心不下的事。最多 1 条。没有就空数组。
- about 用简短中文，指那件事，2 到 16 个字。同一件事沿用上面已有的 about，不要新开一条。
- content 用她自己的口气，一句，写还悬着的是什么。
- 和上面已有的一样、还没结果，就不要再写。悬着的点变了，沿用原来的 about。
- 闲聊、天气、已经有结果的，不要写。已经有结果的放进 resolveUnresolved。
- 这是她还放不下的事，不是看法，不是档案，不是片段，也不是对近况的判断。
- 不要写人设。价值观、说话习惯、在意的事、会坚持的看法和内心不写进这里。
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

importance 只用 low、medium、high。when_sad、preferred_address、avoid_topic 和一直生效的相处方式用 high，其余用 medium 或 low。档案、片段、判断、笔记和看法每类最多 4 条。between 最多 6 条。unresolved 和 question 最多各 1 条。`;
}

const KEEPS_WITH_BETWEEN = new Set([
  "when_sad",
  "preferred_address",
  "daily_routine",
  "current_activity",
  "avoid_topic",
  "important_date",
]);

function overlapsBetween(
  content: string,
  between: ConsolidationPlan["between"],
  profileKey?: string,
): boolean {
  if (profileKey && KEEPS_WITH_BETWEEN.has(profileKey)) return false;

  return between.some((item) => {
    if (sameMemoryText(content, item.content)) return true;

    return (
      profileKey === "user_name" &&
      item.kind === "address" &&
      blocksProfileName(content, item.content)
    );
  });
}

function readResolveBetween(
  value: unknown,
): ConsolidationPlan["resolveBetween"] {
  const items: ConsolidationPlan["resolveBetween"] = [];
  const seen = new Set<string>();

  for (const item of asObjects(value).slice(0, MAX_BETWEEN)) {
    const kind = readString(item.kind) ?? "";
    const about = readSubject(item.about);

    if (!isBetweenKind(kind) || !about) continue;

    const key = `${kind}:${subjectKey(about)}`;

    if (seen.has(key)) continue;

    seen.add(key);
    items.push({ kind, about });
  }

  return items;
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
      between: 0,
      closedBetween: 0,
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
