/**
 * 音频块解码与播放故障分类（可离线测试）。
 *
 * 三类故障：
 * 1. 单块数据错误 — 丢弃该块，会话继续
 * 2. 播放资源故障 — AudioContext 关闭等，升级为会话级
 * 3. 会话级故障 — 由调用方 emit error / 断开，不得吞掉
 */

export type PcmDecodeFailureCode =
  | "invalid_base64"
  | "odd_length"
  | "empty";

export type PcmDecodeResult =
  | { ok: true; samples: Int16Array }
  | { ok: false; code: PcmDecodeFailureCode };

/** 将 Base64 PCM16 LE 解成采样；失败返回可隔离的块错误，不抛出。 */
export function decodePcm16LeBase64(base64: string): PcmDecodeResult {
  let binary: string;

  try {
    binary = atob(base64);
  } catch {
    return { ok: false, code: "invalid_base64" };
  }

  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  if (bytes.length === 0) {
    return { ok: false, code: "empty" };
  }

  if (bytes.length % 2 !== 0) {
    return { ok: false, code: "odd_length" };
  }

  return { ok: true, samples: new Int16Array(bytes.buffer) };
}

export type PlaybackFaultKind = "chunk" | "session";

export class AudioSessionError extends Error {
  readonly fault = "session" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AudioSessionError";
  }
}

export function isAudioSessionError(error: unknown): boolean {
  return (
    error instanceof AudioSessionError ||
    (typeof error === "object" &&
      error !== null &&
      "fault" in error &&
      (error as { fault?: unknown }).fault === "session" &&
      error instanceof Error)
  );
}

function errorName(error: unknown): string {
  if (typeof error === "object" && error !== null && "name" in error) {
    const name = (error as { name?: unknown }).name;
    return typeof name === "string" ? name : "";
  }
  return "";
}

/**
 * 区分可跳过的块级故障与必须上报的会话级故障。
 * contextState 为 AudioContext.state；未知时偏保守（资源类 InvalidState → session）。
 */
export function classifyAudioPlaybackFault(input: {
  error: unknown;
  contextState?: string;
}): PlaybackFaultKind {
  if (isAudioSessionError(input.error)) {
    return "session";
  }

  if (input.contextState === "closed") {
    return "session";
  }

  const name = errorName(input.error);

  // AudioContext 已关闭或节点状态不可用：后续块也无法可靠播放。
  if (name === "InvalidStateError" || name === "NotAllowedError") {
    return "session";
  }

  // 其余单次 start/解码周边异常视为块级，可跳过。
  return "chunk";
}

export type PreparedChunk =
  | { action: "play"; samples: Int16Array }
  | { action: "skip"; code: PcmDecodeFailureCode };

/** playAudio 解码阶段：只产生 play 或 skip，不抛会话错误。 */
export function preparePlaybackChunk(base64: string): PreparedChunk {
  const decoded = decodePcm16LeBase64(base64);

  if (!decoded.ok) {
    return { action: "skip", code: decoded.code };
  }

  if (decoded.samples.length === 0) {
    return { action: "skip", code: "empty" };
  }

  return { action: "play", samples: decoded.samples };
}

/** source.start / 资源操作失败后的处置。 */
export function resolveStartFailure(
  error: unknown,
  contextState: string | undefined,
): "skip" | "abort_session" {
  return classifyAudioPlaybackFault({ error, contextState }) === "chunk"
    ? "skip"
    : "abort_session";
}

/** 限频 warn，避免逐块刷屏；不记录音频内容。 */
export function createChunkFaultWarner(
  write: (message: string) => void,
  minIntervalMs = 2000,
  now: () => number = () => Date.now(),
): (code: string) => void {
  let lastAt = Number.NEGATIVE_INFINITY;
  let suppressed = 0;

  return (code: string) => {
    const t = now();

    if (Number.isFinite(lastAt) && t - lastAt < minIntervalMs) {
      suppressed += 1;
      return;
    }

    const extra =
      suppressed > 0 ? ` (suppressed ${suppressed} similar)` : "";
    suppressed = 0;
    lastAt = t;
    write(`[Audio] skipped bad chunk: ${code}${extra}`);
  };
}

/**
 * 模拟串行播放队列：块级 skip 不中断后续；会话级 abort 停止并抛出。
 * 供测试证明队列不会因坏块永久卡住。
 */
export async function runSerialPlaybackQueue(
  chunks: readonly string[],
  startSamples: (
    samples: Int16Array,
  ) => void | Promise<void>,
  contextState: () => string | undefined,
): Promise<{ played: number; skipped: number }> {
  let played = 0;
  let skipped = 0;

  for (const chunk of chunks) {
    const prepared = preparePlaybackChunk(chunk);

    if (prepared.action === "skip") {
      skipped += 1;
      continue;
    }

    try {
      await startSamples(prepared.samples);
      played += 1;
    } catch (error) {
      if (resolveStartFailure(error, contextState()) === "skip") {
        skipped += 1;
        continue;
      }

      throw error instanceof Error
        ? error
        : new AudioSessionError("playback session fault", { cause: error });
    }
  }

  return { played, skipped };
}

/** 测试辅助：PCM16 LE 采样 → Base64（不依赖浏览器专用 API 以外的 atob/btoa）。 */
export function encodePcm16LeBase64(samples: ArrayLike<number>): string {
  const bytes = new Uint8Array(samples.length * 2);

  for (let i = 0; i < samples.length; i++) {
    const value = samples[i]! | 0;
    bytes[i * 2] = value & 0xff;
    bytes[i * 2 + 1] = (value >> 8) & 0xff;
  }

  let binary = "";

  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }

  return btoa(binary);
}
