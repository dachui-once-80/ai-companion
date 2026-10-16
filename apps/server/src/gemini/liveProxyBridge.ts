/**
 * Gemini Live 代理桥：一对 client ↔ upstream WebSocket 的生命周期。
 *
 * 状态（对本桥而言）：
 * 1. 浏览器已连上代理（client OPEN / CONNECTING）
 * 2. 上游 Gemini 尚未就绪（upstream CONNECTING）— 客户端消息入有界缓冲
 * 3. 上游就绪（upstream OPEN）— 计入 voiceSessions，并刷新缓冲
 * 4. 关闭中 / 已关闭 — 清理定时器与缓冲，匹配退出 voiceSessions
 *
 * voiceSessions 只统计「上游已就绪」的会话，与 aside 的 voiceOpen 语义一致。
 */

export const LIVE_PROXY_MAX_PENDING = 32;

/** 经本地代理握手 Gemini 通常数秒内完成；15s 留足慢代理余量，避免健康路径误杀。 */
export const LIVE_PROXY_UPSTREAM_TIMEOUT_MS = 15_000;

export const LIVE_PROXY_CLOSE_REASON = {
  bufferFull: "upstream buffer full",
  timeout: "upstream timeout",
  upstreamError: "upstream error",
  clientError: "client error",
} as const;

export type LiveProxyCloseReason =
  (typeof LIVE_PROXY_CLOSE_REASON)[keyof typeof LIVE_PROXY_CLOSE_REASON];

/** 与 ws 兼容的最小 socket 面，便于离线 mock。 */
export type LiveProxySocket = {
  readyState: number;
  send(data: unknown, options?: { binary?: boolean }): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): void;
  on(
    event: "message",
    listener: (data: unknown, isBinary: boolean) => void,
  ): void;
  on(
    event: "close",
    listener: (code: number, reason: Buffer | string) => void,
  ): void;
  on(event: "error", listener: (error: Error) => void): void;
};

export type VoiceSessionCounter = {
  /** 上游就绪时调用一次。 */
  begin(): void;
  /** 会话结束时调用一次；仅在曾 begin 时减计数。 */
  end(): void;
  count(): number;
};

export function createVoiceSessionCounter(
  initial = 0,
): VoiceSessionCounter {
  let value = initial;

  return {
    begin() {
      value += 1;
    },
    end() {
      value = Math.max(0, value - 1);
    },
    count() {
      return value;
    },
  };
}

export type BindLiveProxyPairOptions = {
  client: LiveProxySocket;
  upstream: LiveProxySocket;
  voice: VoiceSessionCounter;
  closeQuietly: (
    socket: LiveProxySocket,
    code?: number,
    reason?: string,
  ) => void;
  maxPending?: number;
  upstreamTimeoutMs?: number;
  setTimer?: (handler: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
  /** 上游从 CONNECTING 变为可用时的 readyState 值，默认 1（WebSocket.OPEN）。 */
  openState?: number;
  connectingState?: number;
  onUpstreamOpen?: () => void;
  onClosed?: (reason: string) => void;
  logError?: (message: string, error: unknown) => void;
};

export type LiveProxyPairHandle = {
  /** 测试用：当前缓冲条数。 */
  pendingCount(): number;
  /** 是否已因上游就绪计入 voiceSessions。 */
  voiceCounted(): boolean;
  /** 主动拆除（幂等）。 */
  dispose(code?: number, reason?: string): void;
};

/**
 * 绑定一对代理 socket。调用方负责创建 upstream 实例。
 * 所有成功 begin 的 voice 计数都有匹配的 end（client/upstream 关闭、超时、缓冲满、dispose）。
 */
export function bindLiveProxyPair(
  options: BindLiveProxyPairOptions,
): LiveProxyPairHandle {
  const maxPending = options.maxPending ?? LIVE_PROXY_MAX_PENDING;
  const timeoutMs =
    options.upstreamTimeoutMs ?? LIVE_PROXY_UPSTREAM_TIMEOUT_MS;
  const openState = options.openState ?? 1;
  const connectingState = options.connectingState ?? 0;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const logError =
    options.logError ??
    ((message: string, error: unknown) => {
      console.error(message, error);
    });

  const pending: Array<{ data: unknown; isBinary: boolean }> = [];
  let settled = false;
  let counted = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearPending = () => {
    pending.length = 0;
  };

  const stopTimer = () => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };

  const endVoiceOnce = () => {
    if (!counted) return;
    counted = false;
    options.voice.end();
  };

  const closeBoth = (code?: number, reason?: string) => {
    const text = reason ?? "closed";
    stopTimer();
    clearPending();
    options.closeQuietly(options.client, code, reason);
    options.closeQuietly(options.upstream, code, reason);
    // 不依赖 close 事件异步到达；超时/缓冲满/error 必须立刻 settle 计数。
    settle(text);
  };

  const settle = (reason: string) => {
    if (settled) return;
    settled = true;
    stopTimer();
    clearPending();
    endVoiceOnce();
    options.onClosed?.(reason);
  };

  const flushPending = () => {
    for (const message of pending) {
      if (options.upstream.readyState === openState) {
        options.upstream.send(message.data, { binary: message.isBinary });
      }
    }
    clearPending();
  };

  timer = setTimer(() => {
    timer = null;
    if (settled) return;
    if (options.upstream.readyState === openState) return;
    closeBoth(1011, LIVE_PROXY_CLOSE_REASON.timeout);
  }, timeoutMs);

  options.client.on("message", (data, isBinary) => {
    if (settled) return;

    if (options.upstream.readyState === openState) {
      options.upstream.send(data, { binary: isBinary });
      return;
    }

    if (options.upstream.readyState === connectingState) {
      if (pending.length < maxPending) {
        pending.push({ data, isBinary });
        return;
      }

      // 缓冲满：确定性失败，不得静默丢包后假装仍正常。
      closeBoth(1011, LIVE_PROXY_CLOSE_REASON.bufferFull);
      return;
    }

    // 上游已非 CONNECTING/OPEN：不再接收，关闭配对。
    closeBoth(1011, LIVE_PROXY_CLOSE_REASON.upstreamError);
  });

  options.upstream.on("open", () => {
    if (settled) return;

    stopTimer();

    if (!counted) {
      counted = true;
      options.voice.begin();
    }

    flushPending();
    options.onUpstreamOpen?.();
  });

  options.upstream.on("message", (data, isBinary) => {
    if (settled) return;
    if (options.client.readyState === openState) {
      options.client.send(data, { binary: isBinary });
    }
  });

  options.client.on("close", (code, reason) => {
    const text =
      typeof reason === "string" ? reason : reason.toString();
    stopTimer();
    clearPending();
    options.closeQuietly(options.upstream, code, text);
    settle(text || "client closed");
  });

  options.upstream.on("close", (code, reason) => {
    const text =
      typeof reason === "string" ? reason : reason.toString();
    stopTimer();
    clearPending();
    options.closeQuietly(options.client, code, text);
    settle(text || "upstream closed");
  });

  options.client.on("error", (error) => {
    logError("[Gemini Live Proxy] client error:", error);
    closeBoth(1011, LIVE_PROXY_CLOSE_REASON.clientError);
  });

  options.upstream.on("error", (error) => {
    logError("[Gemini Live Proxy] upstream error:", error);
    closeBoth(1011, LIVE_PROXY_CLOSE_REASON.upstreamError);
  });

  return {
    pendingCount() {
      return pending.length;
    },
    voiceCounted() {
      return counted;
    },
    dispose(code = 1000, reason = "dispose") {
      closeBoth(code, reason);
    },
  };
}

/**
 * 安全关闭 WebSocket：忽略非法 code，reason 截断，不抛出。
 */
export function closeSocketQuietly(
  socket: LiveProxySocket,
  code?: number,
  reason?: string,
  openStates: readonly number[] = [0, 1],
): void {
  if (!openStates.includes(socket.readyState)) {
    return;
  }

  const safeCode =
    code !== undefined &&
    code >= 1000 &&
    code <= 4999 &&
    code !== 1004 &&
    code !== 1005 &&
    code !== 1006 &&
    code !== 1015
      ? code
      : 1000;

  try {
    socket.close(safeCode, (reason ?? "").slice(0, 120));
  } catch (error) {
    console.error("[Gemini Live Proxy] close failed:", error);
  }
}
