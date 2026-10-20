/**
 * 同一轮 Gemini Live 转写的归一化与回退。
 * 不按全文全局去重：用户可以合理重复同一句话；只在同一 stream 内处理
 * 增量片段、累积快照、以及完全相同的重复事件。
 */

export type TranscriptStream = {
  /** 本轮已对外发出的文本 */
  emitted: string;
  /** 上一次原始事件文本（用于跳过完全重复的事件） */
  lastRaw: string;
};

export function createTranscriptStream(): TranscriptStream {
  return { emitted: "", lastRaw: "" };
}

export function resetTranscriptStream(stream: TranscriptStream): void {
  stream.emitted = "";
  stream.lastRaw = "";
}

/**
 * 把一次转写事件收成应对 UI 追加的增量（仅作用于传入的 stream，非全局去重）。
 * - 与 lastRaw 完全相同 → 丢弃（同一事件重放；同轮里连续两个相同增量也会被跳过）
 * - 以已发出文本为前缀的更长串 → 只发后缀（累积快照）
 * - 已发出文本的短前缀 → 丢弃（过期的累积快照）
 * - 其余 → 当作增量片段追加
 *
 * 局限：若服务端用「改写后的整句累积快照」修正标点/用词（非纯加长），
 * 会被当成新增量追加，无法在只支持 append 的 UI 上做替换。新一轮须 reset。
 */
export function applyTranscriptFragment(
  stream: TranscriptStream,
  raw: string,
): string | null {
  if (!raw) return null;

  if (raw === stream.lastRaw) return null;

  if (stream.emitted && raw.startsWith(stream.emitted)) {
    const delta = raw.slice(stream.emitted.length);
    stream.lastRaw = raw;

    if (!delta) return null;

    stream.emitted = raw;
    return delta;
  }

  if (
    stream.emitted &&
    stream.emitted.startsWith(raw) &&
    raw.length < stream.emitted.length
  ) {
    stream.lastRaw = raw;
    return null;
  }

  stream.lastRaw = raw;
  stream.emitted += raw;
  return raw;
}

/** 需要以工具结果为准的事实查询类工具 */
export const FACT_QUERY_TOOLS = new Set([
  "recall_memory",
  "list_tasks",
  "get_weather",
  "web_search",
]);

export function callsNeedFactGrounding(
  calls: ReadonlyArray<{ name?: string }>,
): boolean {
  return calls.some((call) => FACT_QUERY_TOOLS.has(call.name ?? ""));
}

/** 查询失败时给模型的内部说明：不得说成「没有记录」 */
export function noteForFactQueryFailure(): string {
  return "查询失败。如实告诉用户现在查不到，不要说成没有记录、没有待办或没有这件事。";
}

const RECALL_SUCCESS_BASE =
  "只用和问题对得上的这几条。不要把没返回的旧事一起讲。";

const RECALL_EMPTY =
  "没有对得上的记忆。直接说不记得，不要用别的旧事代替。";

const RECALL_HISTORICAL_CAUTION =
  "其中标成「以前的」的条目是历史记录，不代表当前事实；如果涉及用户已纠正的旧值，不得据此覆盖用户当前说法。";

/**
 * recall_memory 成功时的内部说明。
 * 空结果与仅 current 保持原语义；结果含 historical 时追加时态约束。
 */
export function noteForRecallSuccess(
  memories: ReadonlyArray<{ status?: string }>,
): string {
  if (memories.length === 0) return RECALL_EMPTY;

  const hasHistorical = memories.some(
    (item) => item.status === "historical",
  );

  if (!hasHistorical) return RECALL_SUCCESS_BASE;

  return `${RECALL_SUCCESS_BASE}${RECALL_HISTORICAL_CAUTION}`;
}

/** 工具结果返回后、且本轮查询前已说过话时的内部说明 */
export function noteForDiscardedPreToolSpeech(): string {
  return "你刚才在查询完成前说的那句已经作废，用户那边撤掉了。只根据本次工具结果说一句。不要把作废的那句再重复，也不要改口叠两句。";
}

/**
 * 从对话行末尾撤回 companion 刚说的一段（同一次工具前作废的回答）。
 * 只动最后一条 fromCompanion 行；后缀对不上则不改。
 */
export function retractCompanionSuffix<
  T extends { text: string; fromCompanion: boolean },
>(lines: T[], suffix: string): T[] {
  if (!suffix || lines.length === 0) return lines;

  const last = lines[lines.length - 1];

  if (!last?.fromCompanion || !last.text.endsWith(suffix)) return lines;

  const nextText = last.text.slice(0, -suffix.length);

  if (!nextText) return lines.slice(0, -1);

  return [...lines.slice(0, -1), { ...last, text: nextText }];
}
