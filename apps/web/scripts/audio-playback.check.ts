import assert from "node:assert/strict";
import {
  AudioSessionError,
  classifyAudioPlaybackFault,
  createChunkFaultWarner,
  decodePcm16LeBase64,
  encodePcm16LeBase64,
  isAudioSessionError,
  preparePlaybackChunk,
  resolveStartFailure,
  runSerialPlaybackQueue,
} from "../src/realtime/audioPlayback.ts";

// --- 正常 Base64 / PCM ---
{
  const encoded = encodePcm16LeBase64([0, 1000, -1000, 32767]);
  const decoded = decodePcm16LeBase64(encoded);
  assert.equal(decoded.ok, true);
  if (decoded.ok) {
    assert.equal(decoded.samples.length, 4);
    assert.equal(decoded.samples[0], 0);
    assert.equal(decoded.samples[1], 1000);
    assert.equal(decoded.samples[2], -1000);
    assert.equal(decoded.samples[3], 32767);
  }

  const prepared = preparePlaybackChunk(encoded);
  assert.equal(prepared.action, "play");
}

// --- 奇数长度 PCM ---
{
  const odd = btoa(String.fromCharCode(1, 2, 3));
  const decoded = decodePcm16LeBase64(odd);
  assert.deepEqual(decoded, { ok: false, code: "odd_length" });
  assert.deepEqual(preparePlaybackChunk(odd), {
    action: "skip",
    code: "odd_length",
  });
}

// --- 非法 Base64 ---
{
  const decoded = decodePcm16LeBase64("@@@not-base64@@@");
  assert.deepEqual(decoded, { ok: false, code: "invalid_base64" });
  assert.deepEqual(preparePlaybackChunk("@@@not-base64@@@"), {
    action: "skip",
    code: "invalid_base64",
  });
}

// --- 空载荷 ---
{
  assert.deepEqual(decodePcm16LeBase64(btoa("")), {
    ok: false,
    code: "empty",
  });
}

// --- 故障分类：会话级 vs 块级 ---
{
  assert.equal(
    classifyAudioPlaybackFault({
      error: new AudioSessionError("closed"),
      contextState: "running",
    }),
    "session",
  );
  assert.equal(
    classifyAudioPlaybackFault({
      error: new Error("boom"),
      contextState: "closed",
    }),
    "session",
  );

  const invalidState = new Error("state");
  invalidState.name = "InvalidStateError";
  assert.equal(
    classifyAudioPlaybackFault({
      error: invalidState,
      contextState: "running",
    }),
    "session",
  );

  assert.equal(
    classifyAudioPlaybackFault({
      error: new Error("transient start glitch"),
      contextState: "running",
    }),
    "chunk",
  );

  assert.equal(
    resolveStartFailure(new Error("glitch"), "running"),
    "skip",
  );
  assert.equal(
    resolveStartFailure(invalidState, "running"),
    "abort_session",
  );
  assert.ok(isAudioSessionError(new AudioSessionError("x")));
  assert.equal(isAudioSessionError(new Error("x")), false);
}

// --- 坏块之后仍可播放正常块；队列不永久卡住 ---
{
  const good = encodePcm16LeBase64([1, 2, 3, 4]);
  const odd = btoa(String.fromCharCode(9));
  const badBase64 = "%%%%";
  const playedLengths: number[] = [];

  const summary = await runSerialPlaybackQueue(
    [good, odd, badBase64, good],
    (samples) => {
      playedLengths.push(samples.length);
    },
    () => "running",
  );

  assert.deepEqual(summary, { played: 2, skipped: 2 });
  assert.deepEqual(playedLengths, [4, 4]);
}

// --- 单块 start 失败（可恢复）后会话队列仍可用 ---
{
  const good = encodePcm16LeBase64([5, 6]);
  let attempts = 0;

  const summary = await runSerialPlaybackQueue(
    [good, good, good],
    async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("single source start failed");
      }
    },
    () => "running",
  );

  assert.deepEqual(summary, { played: 2, skipped: 1 });
  assert.equal(attempts, 3);
}

// --- AudioContext 关闭：必须 abort，不得当 skip 吞掉 ---
{
  const good = encodePcm16LeBase64([7, 8]);
  let starts = 0;

  await assert.rejects(
    () =>
      runSerialPlaybackQueue(
        [good, good],
        () => {
          starts += 1;
          const err = new Error("AudioContext is closed");
          err.name = "InvalidStateError";
          throw err;
        },
        () => "closed",
      ),
    (error: unknown) =>
      error instanceof Error && error.name === "InvalidStateError",
  );

  // 首块会话失败即停止，不会对第二块再 start
  assert.equal(starts, 1);
}

// --- 显式会话错误不被分类成 chunk ---
{
  const good = encodePcm16LeBase64([1, 1]);

  await assert.rejects(
    () =>
      runSerialPlaybackQueue(
        [good],
        () => {
          throw new AudioSessionError("device gone");
        },
        () => "running",
      ),
    (error: unknown) => isAudioSessionError(error),
  );
}

// --- 限频 warn：不逐块刷屏，不包含音频内容 ---
{
  const lines: string[] = [];
  let t = 0;
  const warn = createChunkFaultWarner(
    (message) => {
      lines.push(message);
    },
    1000,
    () => t,
  );

  warn("odd_length");
  t += 100;
  warn("odd_length");
  t += 100;
  warn("invalid_base64");
  t += 1000;
  warn("odd_length");

  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /odd_length/);
  assert.match(lines[1]!, /suppressed 2/);
  for (const line of lines) {
    assert.equal(line.includes("PCM"), false);
    assert.equal(line.includes(encodePcm16LeBase64([42, 43])), false);
  }
}

console.log("[audio-playback] decode, classify, queue isolation ok");
