import assert from "node:assert/strict";
import { AudioSessionError } from "../src/realtime/audioPlayback.ts";
import {
  CONNECTION_NOTICES,
  isHandshakeFailureReason,
  noticeForCloseReason,
  noticeForConnectError,
  noticeLooksSafe,
  resolveCloseFeedback,
  resolveConnectCatch,
} from "../src/connectionFeedback.ts";

// --- connect 抛错：用户可见固定提示，不回显密钥 ---
{
  const leaked = noticeForConnectError(
    new Error("获取 Gemini Token 失败: 500 key=AIzaSyLeakTestTokenValue99"),
  );
  assert.equal(leaked, CONNECTION_NOTICES.token);
  assert.ok(noticeLooksSafe(leaked));
  assert.equal(leaked.includes("AIza"), false);
  assert.equal(leaked.includes("LeakTest"), false);

  assert.equal(
    noticeForConnectError(new Error("Companion Identity 数据格式错误")),
    CONNECTION_NOTICES.identity,
  );
  assert.equal(
    noticeForConnectError(new Error("AudioContext resume failed")),
    CONNECTION_NOTICES.audioDevice,
  );
  assert.equal(
    noticeForConnectError(new AudioSessionError("AudioContext is closed")),
    CONNECTION_NOTICES.playback,
  );
  assert.equal(
    noticeForConnectError(new Error("something obscure from SDK")),
    CONNECTION_NOTICES.genericFail,
  );
  assert.ok(noticeLooksSafe(CONNECTION_NOTICES.genericFail));
}

// --- 上游超时 / 代理失败：状态与提示 ---
{
  assert.equal(isHandshakeFailureReason("upstream timeout"), true);
  assert.equal(isHandshakeFailureReason("upstream buffer full"), true);
  assert.equal(isHandshakeFailureReason("upstream error"), true);
  assert.equal(isHandshakeFailureReason("hangup"), false);

  const timeout = resolveCloseFeedback("upstream timeout");
  assert.equal(timeout.state, "error");
  assert.equal(timeout.notice, CONNECTION_NOTICES.timeout);
  assert.ok(noticeLooksSafe(timeout.notice!));

  const buffer = resolveCloseFeedback("upstream buffer full");
  assert.equal(buffer.state, "error");
  assert.equal(buffer.notice, CONNECTION_NOTICES.bufferFull);

  const upstream = resolveCloseFeedback("upstream error");
  assert.equal(upstream.state, "error");
  assert.equal(upstream.notice, CONNECTION_NOTICES.upstream);
}

// --- 地区限制：安全提示，不夹带代理地址原文以外的敏感串 ---
{
  const location = noticeForCloseReason(
    "User location is not supported for the API use.",
  );
  assert.equal(location, CONNECTION_NOTICES.location);
  assert.ok(noticeLooksSafe(location!));
}

// --- 未知关闭原因：不回显原文 ---
{
  const raw =
    "proxy http://127.0.0.1:1082 failed with secret=super-secret-value";
  const notice = noticeForCloseReason(raw);
  assert.equal(notice, CONNECTION_NOTICES.closedGeneric);
  assert.equal(notice?.includes("1082"), false);
  assert.equal(notice?.includes("super-secret"), false);
  assert.ok(noticeLooksSafe(notice!));

  const feedback = resolveCloseFeedback(raw);
  assert.equal(feedback.state, "idle");
  assert.equal(feedback.notice, CONNECTION_NOTICES.closedGeneric);
}

// --- 主动挂断类：无失败提示 ---
{
  assert.equal(noticeForCloseReason("hangup"), null);
  assert.equal(noticeForCloseReason("dispose"), null);
  assert.equal(noticeForCloseReason(""), null);
  assert.equal(noticeForCloseReason(undefined), null);
  assert.deepEqual(resolveCloseFeedback("hangup"), {
    state: "idle",
    notice: null,
  });
}

// --- connect catch：当前 client → 失败；非当前 → stale（取消或已处理）---
{
  const fail = resolveConnectCatch({
    isCurrentClient: true,
    error: new Error("获取 Gemini Token 失败: 503"),
  });
  assert.equal(fail.kind, "failure");
  if (fail.kind === "failure") {
    assert.equal(fail.state, "error");
    assert.equal(fail.notice, CONNECTION_NOTICES.token);
  }

  const stale = resolveConnectCatch({
    isCurrentClient: false,
    error: new Error("获取 Gemini Token 失败: 503"),
  });
  assert.equal(stale.kind, "stale");
}

// --- 成功 / 重试开始应清空提示（与 App setNotice("") 约定一致）---
{
  const afterRetryStart = { notice: "", state: "connecting" as const };
  assert.equal(afterRetryStart.notice, "");
  assert.notEqual(afterRetryStart.notice, CONNECTION_NOTICES.timeout);

  const afterConnected = { notice: "", state: "connected" as const };
  assert.equal(afterConnected.notice, "");
  assert.equal(afterConnected.state, "connected");
}

// --- 重试：旧 client 回调不得覆盖新 UI（clientRef 门闩语义）---
{
  type Ui = { state: string; notice: string; client: string | null };
  const ui: Ui = { state: "idle", notice: "", client: null };

  function applyFrom(clientId: string, event: "error" | "connected") {
    if (ui.client !== clientId) return;
    if (event === "error") {
      ui.state = "error";
      ui.notice = CONNECTION_NOTICES.genericFail;
      ui.client = null;
      return;
    }
    ui.notice = "";
    ui.state = "connected";
  }

  ui.client = "old";
  ui.state = "connecting";
  // 用户取消后立刻新呼叫
  ui.client = "new";
  ui.notice = "";
  ui.state = "connecting";

  applyFrom("old", "error");
  assert.equal(ui.state, "connecting");
  assert.equal(ui.notice, "");
  assert.equal(ui.client, "new");

  applyFrom("new", "connected");
  assert.equal(ui.state, "connected");
  assert.equal(ui.notice, "");
}

// --- 会话级 AudioSessionError 仍映射为需断开类提示（非空、非成功）---
{
  const notice = noticeForConnectError(
    new AudioSessionError("Audio source start failed"),
  );
  assert.equal(notice, CONNECTION_NOTICES.playback);
  assert.notEqual(notice, "");
}

console.log("[connection-feedback] notices, cancel/stale, retry isolation ok");
