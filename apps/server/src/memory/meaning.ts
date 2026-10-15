import { createHash } from "node:crypto";

import { GoogleGenAI } from "@google/genai";

import { db } from "../db";
import {
  betweenLabel,
  isStandingKind,
  parseBetweenKey,
} from "./between";
import type { Memory, MemoryStatus } from "./MemoryTypes";
import { isOpenCategory, openId } from "./openMemory";

/** 低于这条的，当作没对上，不用最近的一条来顶。 */
const MIN_SCORE = 0.67;

/** 只留和最相近的那条挨着的，避免把主题相近的另一件事带上。 */
const CLUSTER = 0.055;

const SHORTLIST = 6;
const RESULT_LIMIT = 4;
const RESULT_TTL_MS = 30_000;

const PROFILE_LABEL: Record<string, string> = {
  user_name: "姓名",
  birthday: "生日",
  preferred_address: "平时怎么称呼",
  city: "所在城市",
  occupation: "职业",
  education: "教育",
  favorite_food: "喜欢的食物",
  favorite_drink: "喜欢的饮料",
  hobby: "爱好",
  interest: "感兴趣的事",
  favorite_music: "喜欢的音乐",
  favorite_movie: "喜欢的电影",
  pet: "宠物",
  important_person: "重要的人",
  important_goal: "长期目标",
  habit: "习惯",
  daily_routine: "作息",
  when_sad: "难过时想被怎样陪",
  avoid_topic: "不想被提起的话题",
  current_activity: "正在做的事",
  important_date: "在意的日子",
};

const KIND_LABEL = {
  profile: "档案",
  episode: "片段",
  impression: "判断",
  note: "笔记",
  between: "我们之间",
  view: "看法",
} as const;

export type RecallKind = keyof typeof KIND_LABEL;

export type RecallCandidate = {
  id: string;
  kind: RecallKind;
  content: string;
  detail: string;
  status: MemoryStatus;
  standing: boolean;
  text: string;
};

export type RecalledMemory = {
  kind: string;
  detail: string;
  content: string;
  status: MemoryStatus;
};

export type MeaningDeps = {
  embed: (
    texts: string[],
    purpose: "query" | "document",
  ) => Promise<number[][]>;
  judge: (
    utterance: string,
    lines: Array<{ id: number; text: string }>,
  ) => Promise<number[]>;
};

const remembered = new Map<
  string,
  { at: number; hits: RecallCandidate[] }
>();

export function clearMeaningCache(): void {
  remembered.clear();
}

export function cosine(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index++) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }

  if (leftNorm === 0 || rightNorm === 0) return 0;

  return dot / Math.sqrt(leftNorm * rightNorm);
}

export function isTrivialUtterance(text: string): boolean {
  const compact = text.replace(/\s+/g, "");

  if (compact.length < 2) return true;

  return /^(?:嗯+|啊+|哦+|噢+|唔+|好|好的|好呀|对+|是|是的|哈哈+|呵呵+|行|ok|okay)[。.!！啊呀]?$/i.test(
    compact,
  );
}

export function candidateFromMemory(memory: Memory): RecallCandidate | null {
  const content = memory.content.trim();

  if (!content) return null;

  if (memory.category === "episode") {
    return finishCandidate({
      id: memory.id,
      kind: "episode",
      content,
      detail: openId("episode", memory.key),
      status: memory.status,
      standing: false,
    });
  }

  if (memory.category === "impression") {
    return finishCandidate({
      id: memory.id,
      kind: "impression",
      content,
      detail: openId("impression", memory.key),
      status: memory.status,
      standing: false,
    });
  }

  if (memory.category === "note") {
    return finishCandidate({
      id: memory.id,
      kind: "note",
      content,
      detail: openId("note", memory.key),
      status: memory.status,
      standing: false,
    });
  }

  if (memory.category === "between") {
    const parsed = parseBetweenKey(memory.key);

    return finishCandidate({
      id: memory.id,
      kind: "between",
      content,
      detail: parsed ? betweenLabel(parsed.kind) : "",
      status: memory.status,
      standing: parsed ? isStandingKind(parsed.kind) : false,
    });
  }

  if (isOpenCategory(memory.category) || !memory.key.trim()) return null;

  const label = PROFILE_LABEL[memory.key] ?? memory.key;

  return finishCandidate({
    id: memory.id,
    kind: "profile",
    content,
    detail: label,
    status: memory.status,
    standing: false,
  });
}

export function candidateFromView(view: {
  id: string;
  about: string;
  content: string;
}): RecallCandidate | null {
  const content = view.content.trim();

  if (!content) return null;

  return finishCandidate({
    id: view.id,
    kind: "view",
    content,
    detail: view.about.trim(),
    status: "current",
    standing: false,
  });
}

export function renderCandidateLine(candidate: RecallCandidate): string {
  const kind = `${candidate.status === "historical" ? "以前的" : ""}${KIND_LABEL[candidate.kind]}`;
  const head = candidate.detail ? `${kind} ${candidate.detail}` : kind;

  return `- ${head}：${candidate.content}`;
}

export function toRecalled(candidate: RecallCandidate): RecalledMemory {
  return {
    kind: `${candidate.status === "historical" ? "以前的" : ""}${KIND_LABEL[candidate.kind]}`,
    detail: candidate.detail,
    content: candidate.content,
    status: candidate.status,
  };
}

export function literalMatches(
  candidates: readonly RecallCandidate[],
  query: string,
): RecallCandidate[] {
  const normalized = query.trim().toLowerCase();

  if (normalized.length < 2) return [];

  return candidates.filter((candidate) => {
    const text = candidate.text.toLowerCase();
    const content = candidate.content.toLowerCase();

    return text.includes(normalized) || content.includes(normalized);
  });
}

export function parseJudgeIds(
  raw: string,
  count: number,
  limit = RESULT_LIMIT,
): number[] {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return [];

  let parsed: { ids?: unknown };

  try {
    parsed = JSON.parse(match[0]) as { ids?: unknown };
  } catch {
    return [];
  }

  if (!Array.isArray(parsed.ids)) return [];

  const ids: number[] = [];

  for (const value of parsed.ids) {
    const id =
      typeof value === "number"
        ? value
        : typeof value === "string" && /^\d+$/.test(value)
          ? Number(value)
          : null;

    if (id === null || !Number.isInteger(id)) continue;
    if (id < 1 || id > count || ids.includes(id)) continue;

    ids.push(id);
    if (ids.length >= limit) break;
  }

  return ids;
}

export async function selectByMeaning(
  candidates: readonly RecallCandidate[],
  query: string,
  deps: MeaningDeps,
  limit = RESULT_LIMIT,
): Promise<RecallCandidate[]> {
  const utterance = query.trim();

  if (utterance.length < 2 || candidates.length === 0) return [];

  const cacheKey = `${utterance}\n${candidates.map((item) => `${item.id}:${item.text}`).join("\n")}`;
  const cached = readRemembered(cacheKey);

  if (cached) return cached.slice(0, limit);

  let shortlist: RecallCandidate[];
  let fromEmbedding = true;

  try {
    shortlist = await semanticShortlist(candidates, utterance, deps.embed);
  } catch (error) {
    fromEmbedding = false;
    console.warn("[Memory] embedding failed:", error);
    shortlist = literalMatches(candidates, utterance);
  }

  if (shortlist.length === 0) {
    writeRemembered(cacheKey, []);
    return [];
  }

  let picked: RecallCandidate[];

  try {
    const ids = await deps.judge(
      utterance,
      shortlist.map((item, index) => ({
        id: index + 1,
        text: item.text,
      })),
    );
    const allowed = new Set(ids);
    picked = shortlist
      .filter((_, index) => allowed.has(index + 1))
      .slice(0, limit);
  } catch (error) {
    console.warn("[Memory] meaning check failed:", error);
    picked = fromEmbedding
      ? shortlist.slice(0, limit)
      : literalMatches(shortlist, utterance).slice(0, limit);
  }

  writeRemembered(cacheKey, picked);
  return picked;
}

export function createGeminiMeaning(
  apiKey: string,
  judgeAi: GoogleGenAI,
): MeaningDeps {
  const embedAi = new GoogleGenAI({
    apiKey,
    httpOptions: { apiVersion: "v1beta" },
  });

  return {
    embed: (texts, purpose) => embedTexts(embedAi, texts, purpose),
    judge: (utterance, lines) => judgeLines(judgeAi, utterance, lines),
  };
}

function finishCandidate(
  input: Omit<RecallCandidate, "text">,
): RecallCandidate {
  const candidate = { ...input, text: "" };
  candidate.text = describeCandidate(candidate);
  return candidate;
}

function describeCandidate(candidate: RecallCandidate): string {
  const kind = `${candidate.status === "historical" ? "以前的" : ""}${KIND_LABEL[candidate.kind]}`;

  return candidate.detail
    ? `${kind} ${candidate.detail}：${candidate.content}`
    : `${kind}：${candidate.content}`;
}

async function semanticShortlist(
  candidates: readonly RecallCandidate[],
  query: string,
  embed: MeaningDeps["embed"],
): Promise<RecallCandidate[]> {
  const documents = await embed(
    candidates.map((item) => item.text),
    "document",
  );
  const queries = await embed([query], "query");
  const queryVector = queries[0] ?? [];
  const scored = candidates.map((item, index) => ({
    item,
    score: cosine(queryVector, documents[index] ?? []),
  }));
  const best = scored.reduce(
    (highest, item) => Math.max(highest, item.score),
    0,
  );

  if (best < MIN_SCORE) return [];

  const cutoff = Math.max(MIN_SCORE, best - CLUSTER);

  return scored
    .filter((item) => item.score >= cutoff)
    .sort((a, b) => b.score - a.score)
    .slice(0, SHORTLIST)
    .map((item) => item.item);
}

function readRemembered(key: string): RecallCandidate[] | null {
  const hit = remembered.get(key);

  if (!hit) return null;

  if (Date.now() - hit.at > RESULT_TTL_MS) {
    remembered.delete(key);
    return null;
  }

  return hit.hits;
}

function writeRemembered(key: string, hits: RecallCandidate[]): void {
  if (remembered.size > 32) remembered.clear();

  remembered.set(key, { at: Date.now(), hits });
}

const EMBED_MODEL = "gemini-embedding-001";
// 每句话都可能查一次，用轻量模型。查不了时退回已经按距离筛过的那几条。
const JUDGE_MODEL = "gemini-flash-lite-latest";

let vectorTableReady = false;

async function embedTexts(
  ai: GoogleGenAI,
  texts: string[],
  purpose: "query" | "document",
): Promise<number[][]> {
  if (texts.length === 0) return [];

  ensureVectorTable();

  const hashes = texts.map((text) => textHash(purpose, text));
  const vectors: Array<number[] | null> = hashes.map((hash) => readVector(hash));
  const missing: string[] = [];
  const missingAt: number[] = [];

  texts.forEach((text, index) => {
    if (vectors[index]) return;
    missing.push(text);
    missingAt.push(index);
  });

  for (let start = 0; start < missing.length; start += 64) {
    const slice = missing.slice(start, start + 64);
    const fresh = await embedRemote(ai, slice, purpose);

    fresh.forEach((vector, offset) => {
      const index = missingAt[start + offset];

      if (index === undefined) return;

      vectors[index] = vector;
      writeVector(hashes[index] ?? "", vector);
    });
  }

  return vectors.map((vector) => {
    if (!vector || vector.length === 0) {
      throw new Error("Embedding response was incomplete");
    }

    return vector;
  });
}

async function embedRemote(
  ai: GoogleGenAI,
  texts: string[],
  purpose: "query" | "document",
): Promise<number[][]> {
  const response = await ai.models.embedContent({
    model: EMBED_MODEL,
    contents: texts,
    config: {
      taskType: purpose === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
      outputDimensionality: 768,
    },
  });
  const embeddings = response.embeddings ?? [];

  if (embeddings.length !== texts.length) {
    throw new Error("Embedding response was incomplete");
  }

  return embeddings.map((item) => {
    const values = item.values ?? [];

    if (values.length === 0) {
      throw new Error("Embedding response was incomplete");
    }

    return values;
  });
}

async function judgeLines(
  ai: GoogleGenAI,
  utterance: string,
  lines: Array<{ id: number; text: string }>,
): Promise<number[]> {
  if (lines.length === 0) return [];

  const response = await ai.models.generateContent({
    model: JUDGE_MODEL,
    contents: judgePrompt(utterance, lines),
    config: {
      temperature: 0,
      abortSignal: AbortSignal.timeout(12_000),
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "integer" },
          },
        },
        required: ["ids"],
      },
    },
  });

  return parseJudgeIds(response.text ?? "", lines.length);
}

function judgePrompt(
  utterance: string,
  lines: Array<{ id: number; text: string }>,
): string {
  const listed = lines.map((line) => `${line.id}. ${line.text}`).join("\n");

  return `这句话是在说下面哪几条已经记下的事。用词不一样也算同一件。

要对上的例子：
- 「加班」对得上「这周一直在赶项目」
- 「赶上截止，连夜干活」对得上「样本失效，熬夜赶工交出数据」
- 「你答应提醒我交材料」对得上「答应周末提醒交报告」

不要选的例子：
- 问某一次通宵交数据，不要选爬山、吃的、住哪，也不要选另一件只是都在忙的事
- 「今天天气怎么样」一条都不要选

记下的这几条已经按意思筛过。其中有对得上的，就要把它的编号放进 ids，不要返回空。只有确实对不上，ids 才是空数组。

这句话：
${utterance}

记下的：
${listed}

按相关程度把编号放进 ids，最多 4 个。`;
}

function textHash(purpose: string, text: string): string {
  return createHash("sha256").update(`${purpose}\n${text}`).digest("hex");
}

function sqlite() {
  return (db as unknown as { $client: import("better-sqlite3").Database }).$client;
}

function ensureVectorTable(): void {
  if (vectorTableReady) return;

  sqlite().exec(`
    CREATE TABLE IF NOT EXISTS memory_vectors (
      text_hash TEXT PRIMARY KEY,
      vector TEXT NOT NULL
    );
  `);
  vectorTableReady = true;
}

function readVector(hash: string): number[] | null {
  const row = sqlite()
    .prepare("SELECT vector FROM memory_vectors WHERE text_hash = ?")
    .get(hash) as { vector: string } | undefined;

  if (!row) return null;

  try {
    const parsed = JSON.parse(row.vector) as unknown;

    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    if (!parsed.every((value) => typeof value === "number")) return null;

    return parsed;
  } catch {
    return null;
  }
}

function writeVector(hash: string, vector: number[]): void {
  if (!hash) return;

  sqlite()
    .prepare(
      `INSERT INTO memory_vectors (text_hash, vector)
       VALUES (?, ?)
       ON CONFLICT(text_hash) DO UPDATE SET vector = excluded.vector`,
    )
    .run(hash, JSON.stringify(vector));
}
