/**
 * 连接失败 / 断开时的用户可见提示。
 * 只映射到固定文案，不回传原始上游错误、token 或密钥。
 */

import { isAudioSessionError } from "./realtime/audioPlayback";

export const CONNECTION_NOTICES = {
  genericFail: "连接没有成功，请再试一次。",
  token: "暂时拿不到通话凭证。请确认服务已启动后重试。",
  identity: "暂时读不到同伴身份，请稍后重试。",
  audioDevice: "无法使用扬声器或麦克风，请检查系统权限后重试。",
  playback: "声音播放出了问题，通话已结束。请重新呼叫。",
  timeout: "连接超时了。请检查网络或代理后重试。",
  bufferFull: "连接建立过慢，开场没能完成。请再试一次。",
  upstream: "和同伴的连接中断了，请再试一次。",
  location:
    "当前网络出口不被 Gemini 接受。请更换代理节点，确认健康检查可用后再呼叫。",
  closedGeneric: "连接已断开。需要的话可以再呼叫一次。",
} as const;

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "";
}

/** 将 connect / error 事件映射为安全提示（永不回显原始密钥或长错误串）。 */
export function noticeForConnectError(error: unknown): string {
  if (isAudioSessionError(error)) {
    return CONNECTION_NOTICES.playback;
  }

  const text = errorText(error);

  if (/token|凭证/i.test(text)) {
    return CONNECTION_NOTICES.token;
  }

  if (/identity|身份/i.test(text)) {
    return CONNECTION_NOTICES.identity;
  }

  if (
    /AudioContext|getUserMedia|microphone|麦克风|扬声器|NotAllowedError/i.test(
      text,
    )
  ) {
    return CONNECTION_NOTICES.audioDevice;
  }

  return CONNECTION_NOTICES.genericFail;
}

function normalizeReason(reason: string): string {
  return reason.trim().toLowerCase();
}

/** 握手阶段失败（超时、缓冲满、上游错误）→ UI 用 error，便于一眼看到可重试。 */
export function isHandshakeFailureReason(
  reason: string | undefined,
): boolean {
  if (!reason) return false;
  const r = normalizeReason(reason);
  return (
    r.includes("upstream timeout") ||
    r.includes("upstream buffer full") ||
    r.includes("upstream error") ||
    r.includes("client error")
  );
}

/**
 * 关闭原因 → 用户提示。
 * 未知原因不回显原文，避免泄露代理/内部信息。
 * 主动挂断类原因返回 null（不提示失败）。
 */
export function noticeForCloseReason(
  reason: string | undefined,
): string | null {
  if (!reason || !reason.trim()) return null;

  const r = normalizeReason(reason);

  if (
    r === "hangup" ||
    r === "dispose" ||
    r === "client closed" ||
    r === "normal closure" ||
    r.includes("user hangup")
  ) {
    return null;
  }

  if (r.includes("user location is not supported")) {
    return CONNECTION_NOTICES.location;
  }

  if (r.includes("upstream timeout")) {
    return CONNECTION_NOTICES.timeout;
  }

  if (r.includes("upstream buffer full") || r.includes("buffer full")) {
    return CONNECTION_NOTICES.bufferFull;
  }

  if (r.includes("upstream error") || r.includes("client error")) {
    return CONNECTION_NOTICES.upstream;
  }

  return CONNECTION_NOTICES.closedGeneric;
}

export type ConnectCatchResult =
  | {
      kind: "failure";
      state: "error";
      notice: string;
    }
  | {
      /** clientRef 已不是该实例：用户取消，或 error/closed 已处理过 UI。 */
      kind: "stale";
    };

/**
 * connect() 的 catch：仅当前 client 仍被 App 持有时才算失败。
 * stale 时不改 UI（避免清掉 error 事件刚写上的提示，也不把取消报成失败）。
 */
export function resolveConnectCatch(input: {
  isCurrentClient: boolean;
  error: unknown;
}): ConnectCatchResult {
  if (!input.isCurrentClient) {
    return { kind: "stale" };
  }

  return {
    kind: "failure",
    state: "error",
    notice: noticeForConnectError(input.error),
  };
}

export type CloseUiResult = {
  state: "idle" | "error";
  notice: string | null;
};

export function resolveCloseFeedback(
  reason: string | undefined,
): CloseUiResult {
  const notice = noticeForCloseReason(reason);

  if (isHandshakeFailureReason(reason)) {
    return {
      state: "error",
      notice: notice ?? CONNECTION_NOTICES.genericFail,
    };
  }

  return { state: "idle", notice };
}

/** 测试辅助：断言文案不含敏感形态。 */
export function noticeLooksSafe(notice: string): boolean {
  if (!notice) return true;
  if (/AIza[0-9A-Za-z_-]{10,}/.test(notice)) return false;
  if (/Bearer\s+\S+/i.test(notice)) return false;
  if (/api[_-]?key\s*[:=]/i.test(notice)) return false;
  if (/sk-[a-zA-Z0-9]{10,}/.test(notice)) return false;
  if (notice.length > 160) return false;
  return true;
}
