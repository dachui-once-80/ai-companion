/**
 * Live Session 生命周期辅助。
 *
 * 已核实 @google/genai@2.24.0：
 * - `ai.live.connect()` 在浏览器 WebSocket onopen 之后才 resolve Session
 * - `Session.close()` 仅调用底层 `conn.close()`，关闭浏览器→代理的 WS
 * - 代理接受客户端 ≠ Gemini 上游就绪（上游就绪由服务端 bridge 负责）
 *
 * close 可能因 SDK 包装在未连接时抛错，故统一经本模块释放。
 */

export type CloseableLiveSession = {
  close(): void;
};

/** 安全关闭 Live Session；可重复调用；不抛出。 */
export function releaseLiveSession(
  session: CloseableLiveSession | null | undefined,
): void {
  if (!session) return;

  try {
    session.close();
  } catch {
    // 已关闭、或 BrowserWebSocket 在 ws 未就绪时抛错。
  }
}

/**
 * connect 返回 Session 后：若代次仍有效则接管，否则立即释放迟到连接。
 * @returns 是否已接管
 */
export function adoptOrReleaseLiveSession(input: {
  session: CloseableLiveSession;
  isCurrent: boolean;
  assign: (session: CloseableLiveSession) => void;
}): boolean {
  if (!input.isCurrent) {
    releaseLiveSession(input.session);
    return false;
  }

  input.assign(input.session);
  return true;
}
