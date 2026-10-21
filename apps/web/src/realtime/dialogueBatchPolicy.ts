/**
 * 对话批次是否值得整理（与历史 RealtimeClient 规则一致）。
 * 抽出以便 handoff 测试与客户端共用，避免语义漂移。
 */

export type DialogueBatchTurn = {
  role: "user" | "companion" | "overheard";
  text: string;
};

export function dialogueWorthKeeping(batch: readonly DialogueBatchTurn[]): boolean {
  const heard = batch.filter(
    (turn) => turn.role === "user" || turn.role === "overheard",
  );
  const heardText = heard.map((turn) => turn.text).join("");

  if (heardText.replace(/\s+/g, "").length < 4) return false;
  if (heard.some((turn) => turn.role === "overheard")) return true;

  return !heard.every((turn) => isShortLookup(turn.text));
}

function isShortLookup(text: string): boolean {
  const compact = text.replace(/\s+/g, "");

  if (compact.length < 2 || compact.length > 28) return false;
  if (/我(叫|住|喜欢|决定|生日|在学|想记住)/.test(compact)) return false;

  return /天气|气温|温度|下雨|降雨|刮风|风力|几度|冷不冷|热不热/.test(
    compact,
  );
}
