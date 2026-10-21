/**
 * consolidate 正文规范化与 canonical JSON（web／server 共用契约）。
 * 不含系统时间；日期必须以显式 todayLocal 传入。
 * 不含 SHA-256：Node 与浏览器 hash API 不同，由各端对同一 canonical 字符串取摘要。
 */

export const CONSOLIDATION_MAX_TURN_CHARS = 2_000;

export type ConsolidationPayloadTurn = {
  role: "user" | "companion" | "overheard";
  text: string;
};

/**
 * 与历史 resolveConversationDate 相同规则，但 todayLocal 必须由调用方提供。
 * - 缺省／非 YYYY-MM-DD → todayLocal
 * - 解析失败或与 todayLocal 相差超过约 2 天 → todayLocal
 * - 否则返回原始 input
 */
export function normalizeConsolidationOccurredOn(
  input: string | undefined,
  todayLocal: string,
): string {
  if (!input || !/^\d{4}-\d{2}-\d{2}$/.test(input)) return todayLocal;

  const requested = Date.parse(`${input}T00:00:00`);
  const current = Date.parse(`${todayLocal}T00:00:00`);

  if (
    Number.isNaN(requested) ||
    Math.abs(requested - current) > 2 * 24 * 60 * 60 * 1000
  ) {
    return todayLocal;
  }

  return input;
}

/**
 * 单条 turn 文本：trim、截断；空或含「内部状态」→ null（调用方跳过该 turn）。
 * 已规范化的 text 不得再次传入此函数做第二次处理。
 */
export function normalizeConsolidationTurnText(text: string): string | null {
  const normalized = text.trim().slice(0, CONSOLIDATION_MAX_TURN_CHARS);

  if (!normalized || normalized.includes("内部状态")) return null;

  return normalized;
}

/**
 * 严格键序：occurredOn，再 turns[{ role, text }]。
 * 假定 occurredOn 与 turns 已是最终持久化／hash 用值；不再 trim 或过滤。
 */
export function canonicalConsolidationPayloadJson(
  occurredOn: string,
  turns: readonly ConsolidationPayloadTurn[],
): string {
  return JSON.stringify({
    occurredOn,
    turns: turns.map((turn) => ({ role: turn.role, text: turn.text })),
  });
}
