import type { RecallScope } from "./MemoryStore";

/**
 * 从用户这句话判断相关记忆注入该用哪档 scope。
 *
 * 默认 current：纠正/撤销后的 historical 不得当当前事实注入。
 * 仅在明确问往事时用 all：可带上 historical，但仍靠「以前的」标注区分时态；
 * 同时保留仍为 current 的经历片段。
 *
 * 原则：不因「过去」「之前」等单字就无条件打开历史池；拿不准时保持 current，
 * 由明确的 recall_memory（scope=historical|all）补充。
 *
 * 数据模型局限：historical 同时覆盖「真实往事」与「已被纠正的错误记忆」，
 * 目前无法在库内区分；问过去时两者都可能出现，须靠标注与工具查询约束。
 */

const PRESENT_FOCUS = /(现在|目前|如今|眼下|当前)/;

/** 「过去一周」「这几天」这类近况时间窗，不是在查已归档记忆。 */
function hasRecentDurationCue(text: string): boolean {
  return (
    /(过去|近|这)(一|两|三|几|\d+)?(周|天|日|个?月|年)/.test(text) ||
    /这一周|这一阵|最近/.test(text)
  );
}

/**
 * 明确的往事询问（整句形态，而非单个关键词）。
 * 「之前跟你说过」单独出现不够；须像「以前喜欢什么」「小时候…」等。
 */
function hasClearPastRecall(text: string): boolean {
  if (
    /小时候|上次|那时候|那年|当年|早先|旧时|从前|曾经/.test(text)
  ) {
    return true;
  }

  // 「以前」几乎总是在问往事（以前喜欢 / 我以前住哪）
  if (/以前/.test(text)) return true;

  // 「过去」：排除「过去一周」后，须像回忆偏好/事实的问法
  if (/过去/.test(text) && !hasRecentDurationCue(text)) {
    if (/过去.{0,12}(喜欢|住|是|叫|做|用|吃|喝|去过)/.test(text)) {
      return true;
    }
    if (/过去.{0,16}(什么|哪|吗|呢|谁)/.test(text)) return true;
  }

  // 「之前」：仅当像在问旧偏好/旧事实，不把「之前提过」当回忆请求
  if (/之前(喜欢|住|是|叫|做|用|吃|喝)/.test(text)) return true;
  if (/之前的(偏好|住址|名字|工作|学校|习惯)/.test(text)) return true;
  if (/之前.{0,10}(喜欢|住).{0,8}(什么|哪)/.test(text)) return true;

  return false;
}

export function utteranceRequestsPastMemory(utterance: string): boolean {
  const text = utterance.replace(/\s+/g, "");

  if (text.length < 2) return false;

  // 「现在怎么办」「目前住哪」：以现在为准（含「之前…现在…」混合句）
  if (PRESENT_FOCUS.test(text)) return false;

  // 「过去一周怎么样」：近况时间窗，不打开归档池
  if (hasRecentDurationCue(text) && !/以前|小时候|上次|曾经|从前/.test(text)) {
    return false;
  }

  return hasClearPastRecall(text);
}

export function relevantScopeForUtterance(utterance: string): RecallScope {
  return utteranceRequestsPastMemory(utterance) ? "all" : "current";
}

/** 工具/API 未指定 scope 时的默认：只查当前成立的记忆。 */
export const DEFAULT_RECALL_SCOPE: RecallScope = "current";
