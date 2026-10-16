import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  LIVE_PROXY_CLOSE_REASON,
  LIVE_PROXY_MAX_PENDING,
  bindLiveProxyPair,
  closeSocketQuietly,
  createVoiceSessionCounter,
  type LiveProxySocket,
} from "../gemini/liveProxyBridge.ts";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

class MockSocket extends EventEmitter {
  readyState = CONNECTING;
  sent: Array<{ data: unknown; binary?: boolean }> = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];

  send(data: unknown, options?: { binary?: boolean }): void {
    this.sent.push({ data, binary: options?.binary });
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.closeCalls.push({ code, reason });
    this.emit("close", code ?? 1000, Buffer.from(reason ?? "", "utf8"));
  }

  open(): void {
    this.readyState = OPEN;
    this.emit("open");
  }
}

function asSocket(socket: MockSocket): LiveProxySocket {
  return socket as unknown as LiveProxySocket;
}

function pair(timeoutMs = 50) {
  const voice = createVoiceSessionCounter();
  const client = new MockSocket();
  const upstream = new MockSocket();
  const closed: string[] = [];

  client.readyState = OPEN;

  const handle = bindLiveProxyPair({
    client: asSocket(client),
    upstream: asSocket(upstream),
    voice,
    closeQuietly: closeSocketQuietly,
    maxPending: 4,
    upstreamTimeoutMs: timeoutMs,
    onClosed: (reason) => {
      closed.push(reason);
    },
  });

  return { voice, client, upstream, handle, closed };
}

// --- 正常连接与关闭（客户端先关）---
{
  const { voice, client, upstream, handle } = pair(1_000);
  assert.equal(voice.count(), 0);
  assert.equal(handle.voiceCounted(), false);

  client.emit("message", "setup-1", false);
  assert.equal(handle.pendingCount(), 1);

  upstream.open();
  assert.equal(voice.count(), 1);
  assert.equal(handle.voiceCounted(), true);
  assert.equal(handle.pendingCount(), 0);
  assert.equal(upstream.sent.length, 1);

  client.emit("message", "audio-2", true);
  assert.equal(upstream.sent.at(-1)?.data, "audio-2");

  upstream.emit("message", "reply", true);
  assert.equal(client.sent.at(-1)?.data, "reply");

  client.close(1000, "hangup");
  assert.equal(voice.count(), 0);
  assert.equal(upstream.readyState, CLOSED);
  assert.equal(handle.voiceCounted(), false);
}

// --- 上游先关闭 ---
{
  const { voice, client, upstream } = pair(1_000);
  upstream.open();
  assert.equal(voice.count(), 1);
  upstream.close(1011, "gemini gone");
  assert.equal(voice.count(), 0);
  assert.equal(client.readyState, CLOSED);
}

// --- 缓冲未满：上游就绪后全部刷出 ---
{
  const { upstream, client, handle } = pair(1_000);
  client.emit("message", "a", false);
  client.emit("message", "b", false);
  client.emit("message", "c", false);
  assert.equal(handle.pendingCount(), 3);
  upstream.open();
  assert.deepEqual(
    upstream.sent.map((item) => item.data),
    ["a", "b", "c"],
  );
  assert.equal(handle.pendingCount(), 0);
}

// --- 缓冲达到上限：确定性关闭，不得静默丢包后继续 ---
{
  const { voice, client, upstream, handle, closed } = pair(1_000);
  client.emit("message", "1", false);
  client.emit("message", "2", false);
  client.emit("message", "3", false);
  client.emit("message", "4", false);
  assert.equal(handle.pendingCount(), 4);

  client.emit("message", "overflow", false);

  assert.equal(client.readyState, CLOSED);
  assert.equal(upstream.readyState, CLOSED);
  assert.equal(voice.count(), 0);
  assert.equal(handle.pendingCount(), 0);
  assert.ok(
    closed.some((reason) => reason.includes(LIVE_PROXY_CLOSE_REASON.bufferFull)),
  );
  assert.ok(
    client.closeCalls.some(
      (call) => call.reason === LIVE_PROXY_CLOSE_REASON.bufferFull,
    ),
  );
}

// --- 上游超时：未就绪则关闭且不计 voice ---
{
  const timers: Array<{ id: number; fn: () => void; ms: number }> = [];
  let nextId = 1;
  const voice = createVoiceSessionCounter();
  const client = new MockSocket();
  const upstream = new MockSocket();
  client.readyState = OPEN;

  bindLiveProxyPair({
    client: asSocket(client),
    upstream: asSocket(upstream),
    voice,
    closeQuietly: closeSocketQuietly,
    upstreamTimeoutMs: 15,
    setTimer: (fn, ms) => {
      const id = nextId++ as unknown as ReturnType<typeof setTimeout>;
      timers.push({ id: nextId - 1, fn, ms });
      return id;
    },
    clearTimer: (id) => {
      const numeric = id as unknown as number;
      const index = timers.findIndex((item) => item.id === numeric);
      if (index >= 0) timers.splice(index, 1);
    },
  });

  assert.equal(timers.length, 1);
  assert.equal(timers[0]?.ms, 15);
  timers[0]?.fn();

  assert.equal(client.readyState, CLOSED);
  assert.equal(upstream.readyState, CLOSED);
  assert.equal(voice.count(), 0);
  assert.ok(
    client.closeCalls.some(
      (call) => call.reason === LIVE_PROXY_CLOSE_REASON.timeout,
    ),
  );
}

// --- 超时前上游就绪：定时器取消，会话保持 ---
{
  const timers: Array<{ id: number; fn: () => void }> = [];
  let nextId = 1;
  const voice = createVoiceSessionCounter();
  const client = new MockSocket();
  const upstream = new MockSocket();
  client.readyState = OPEN;

  bindLiveProxyPair({
    client: asSocket(client),
    upstream: asSocket(upstream),
    voice,
    closeQuietly: closeSocketQuietly,
    upstreamTimeoutMs: 15,
    setTimer: (fn) => {
      const id = nextId++ as unknown as ReturnType<typeof setTimeout>;
      timers.push({ id: nextId - 1, fn });
      return id;
    },
    clearTimer: (id) => {
      const numeric = id as unknown as number;
      const index = timers.findIndex((item) => item.id === numeric);
      if (index >= 0) timers.splice(index, 1);
    },
  });

  upstream.open();
  assert.equal(timers.length, 0);
  assert.equal(voice.count(), 1);
  assert.equal(client.readyState, OPEN);
}

// --- 客户端在上游就绪前关闭：不计 voice，无泄漏 ---
{
  const { voice, client, upstream } = pair(1_000);
  client.emit("message", "early", false);
  client.close(1000, "cancel");
  assert.equal(voice.count(), 0);
  assert.equal(upstream.readyState, CLOSED);
}

// --- 连接失败（upstream error）：关闭配对，计数归零 ---
{
  const voice = createVoiceSessionCounter();
  const client = new MockSocket();
  const upstream = new MockSocket();
  client.readyState = OPEN;
  bindLiveProxyPair({
    client: asSocket(client),
    upstream: asSocket(upstream),
    voice,
    closeQuietly: closeSocketQuietly,
    upstreamTimeoutMs: 1_000,
    logError: () => undefined,
  });
  upstream.open();
  assert.equal(voice.count(), 1);
  upstream.emit("error", new Error("boom"));
  assert.equal(voice.count(), 0);
  assert.equal(client.readyState, CLOSED);
}

// --- 重复关闭 / dispose 幂等 ---
{
  const { voice, upstream, handle } = pair(1_000);
  upstream.open();
  assert.equal(voice.count(), 1);
  handle.dispose(1000, "dispose");
  handle.dispose(1000, "dispose-again");
  assert.equal(voice.count(), 0);
}

// --- 连续两路：旧路关闭不影响新路计数 ---
{
  const voice = createVoiceSessionCounter();

  const make = () => {
    const client = new MockSocket();
    const upstream = new MockSocket();
    client.readyState = OPEN;
    const handle = bindLiveProxyPair({
      client: asSocket(client),
      upstream: asSocket(upstream),
      voice,
      closeQuietly: closeSocketQuietly,
      upstreamTimeoutMs: 1_000,
    });
    return { client, upstream, handle };
  };

  const first = make();
  first.upstream.open();
  assert.equal(voice.count(), 1);

  const second = make();
  second.upstream.open();
  assert.equal(voice.count(), 2);

  first.client.close(1000, "old");
  assert.equal(voice.count(), 1);
  assert.equal(second.handle.voiceCounted(), true);
  assert.equal(second.client.readyState, OPEN);

  second.upstream.emit("message", "only-new", false);
  assert.equal(second.client.sent.at(-1)?.data, "only-new");
  assert.equal(first.client.sent.length, 0);

  second.client.close(1000, "new-done");
  assert.equal(voice.count(), 0);
}

// --- 默认缓冲上限常量与生产一致 ---
assert.equal(LIVE_PROXY_MAX_PENDING, 32);

console.log("[live-proxy] bridge lifecycle, buffer, timeout, voiceSessions ok");
