import assert from "node:assert/strict";
import {
  applyTranscriptFragment,
  callsNeedFactGrounding,
  createTranscriptStream,
  noteForDiscardedPreToolSpeech,
  noteForFactQueryFailure,
  noteForRecallSuccess,
  resetTranscriptStream,
  retractCompanionSuffix,
} from "../src/realtime/turnTranscript.ts";

// --- 增量片段：依次追加 ---
{
  const stream = createTranscriptStream();
  assert.equal(applyTranscriptFragment(stream, "你"), "你");
  assert.equal(applyTranscriptFragment(stream, "好"), "好");
  assert.equal(stream.emitted, "你好");
}

// --- 完全相同的重复事件：不二次发出 ---
{
  const stream = createTranscriptStream();
  assert.equal(applyTranscriptFragment(stream, "你好"), "你好");
  assert.equal(applyTranscriptFragment(stream, "你好"), null);
  assert.equal(stream.emitted, "你好");
}

// --- 累积快照：只发新增后缀 ---
{
  const stream = createTranscriptStream();
  assert.equal(applyTranscriptFragment(stream, "你"), "你");
  assert.equal(applyTranscriptFragment(stream, "你好"), "好");
  assert.equal(applyTranscriptFragment(stream, "你好啊"), "啊");
  assert.equal(stream.emitted, "你好啊");
}

// --- 过期的更短累积快照：忽略 ---
{
  const stream = createTranscriptStream();
  assert.equal(applyTranscriptFragment(stream, "你好啊"), "你好啊");
  assert.equal(applyTranscriptFragment(stream, "你好"), null);
  assert.equal(stream.emitted, "你好啊");
}

// --- 空串不发出 ---
{
  const stream = createTranscriptStream();
  assert.equal(applyTranscriptFragment(stream, ""), null);
}

// --- reset 后允许同一句话再次出现（用户合理重复，非全局去重） ---
{
  const stream = createTranscriptStream();
  assert.equal(applyTranscriptFragment(stream, "嗯"), "嗯");
  resetTranscriptStream(stream);
  assert.equal(applyTranscriptFragment(stream, "嗯"), "嗯");
  assert.equal(stream.emitted, "嗯");
}

// --- 两个独立 stream 互不影响（不是全局文本去重） ---
{
  const a = createTranscriptStream();
  const b = createTranscriptStream();
  assert.equal(applyTranscriptFragment(a, "你好"), "你好");
  assert.equal(applyTranscriptFragment(b, "你好"), "你好");
  assert.equal(a.emitted, "你好");
  assert.equal(b.emitted, "你好");
}

// --- 已知局限：标点/用词修正的非加长累积快照会误追加 ---
{
  const stream = createTranscriptStream();
  assert.equal(applyTranscriptFragment(stream, "你好。"), "你好。");
  // 当前实现无法把「你好。」替换成「你好！」，会当成新增量
  assert.equal(applyTranscriptFragment(stream, "你好！"), "你好！");
  assert.equal(stream.emitted, "你好。你好！");
}

// --- 已知局限：同轮连续两个相同增量会被 lastRaw 去重吃掉 ---
{
  const stream = createTranscriptStream();
  assert.equal(applyTranscriptFragment(stream, "嗯"), "嗯");
  assert.equal(applyTranscriptFragment(stream, "嗯"), null);
  assert.equal(stream.emitted, "嗯");
}

// --- 事实查询工具识别 ---
assert.equal(callsNeedFactGrounding([{ name: "recall_memory" }]), true);
assert.equal(callsNeedFactGrounding([{ name: "list_tasks" }]), true);
assert.equal(callsNeedFactGrounding([{ name: "get_weather" }]), true);
assert.equal(callsNeedFactGrounding([{ name: "web_search" }]), true);
assert.equal(callsNeedFactGrounding([{ name: "create_task" }]), false);
assert.equal(callsNeedFactGrounding([{ name: "hold_view" }]), false);
assert.equal(
  callsNeedFactGrounding([{ name: "create_task" }, { name: "list_tasks" }]),
  true,
);

// --- 查询失败说明不得暗示「没有记录」 ---
{
  const note = noteForFactQueryFailure();
  assert.match(note, /查询失败/);
  assert.match(note, /不要说成没有/);
  assert.doesNotMatch(note, /没有记录。$/);
}

// --- recall_memory 成功 note：空 / 仅 current / 含 historical ---
{
  const empty = noteForRecallSuccess([]);
  assert.match(empty, /没有对得上的记忆/);
  assert.doesNotMatch(empty, /历史记录/);

  const currentOnly = noteForRecallSuccess([
    { status: "current" },
    { status: "current" },
  ]);
  assert.match(currentOnly, /只用和问题对得上的这几条/);
  assert.doesNotMatch(currentOnly, /历史记录/);
  assert.doesNotMatch(currentOnly, /不得据此覆盖/);

  const mixed = noteForRecallSuccess([
    { status: "current" },
    { status: "historical" },
  ]);
  assert.match(mixed, /只用和问题对得上的这几条/);
  assert.match(mixed, /历史记录/);
  assert.match(mixed, /不代表当前事实/);
  assert.match(mixed, /不得据此覆盖用户当前说法/);
}

{
  const note = noteForDiscardedPreToolSpeech();
  assert.match(note, /作废/);
  assert.match(note, /工具结果/);
}

// --- 撤回 companion 行后缀 ---
{
  const lines = [
    { id: 1, speaker: "你", text: "我喜欢什么？", fromCompanion: false },
    { id: 2, speaker: "小七", text: "我想想你喜欢可乐", fromCompanion: true },
  ];
  const next = retractCompanionSuffix(lines, "你喜欢可乐");
  assert.equal(next.length, 2);
  assert.equal(next[1]?.text, "我想想");
}

{
  const lines = [
    { id: 1, speaker: "小七", text: "你喜欢可乐", fromCompanion: true },
  ];
  const next = retractCompanionSuffix(lines, "你喜欢可乐");
  assert.equal(next.length, 0);
}

// --- 后缀对不上：不改（含新内容已接上、旧撤回迟到） ---
{
  const lines = [
    { id: 1, speaker: "你", text: "你好", fromCompanion: false },
    { id: 2, speaker: "小七", text: "嗯，查到了", fromCompanion: true },
  ];
  const same = retractCompanionSuffix(lines, "你喜欢可乐");
  assert.equal(same, lines);
}

// --- 空后缀 / 空列表：不改 ---
{
  const lines = [{ id: 1, speaker: "小七", text: "嗯", fromCompanion: true }];
  assert.equal(retractCompanionSuffix(lines, ""), lines);
  assert.deepEqual(retractCompanionSuffix([], "嗯"), []);
}

// --- 最后一行不是 companion：不改 ---
{
  const lines = [
    { id: 1, speaker: "小七", text: "你喜欢可乐", fromCompanion: true },
    { id: 2, speaker: "你", text: "你喜欢可乐", fromCompanion: false },
  ];
  assert.equal(retractCompanionSuffix(lines, "你喜欢可乐"), lines);
}

// --- 重复撤回：第二次无匹配，保持稳定 ---
{
  const once = retractCompanionSuffix(
    [{ id: 1, speaker: "小七", text: "你喜欢可乐", fromCompanion: true }],
    "你喜欢可乐",
  );
  assert.equal(once.length, 0);
  const twice = retractCompanionSuffix(once, "你喜欢可乐");
  assert.equal(twice, once);
}

// --- 单轮：重复转写事件 + 工具前作废 + 失败说明（串联场景） ---
{
  const stream = createTranscriptStream();
  let ui = "";

  const emit = (raw: string) => {
    const delta = applyTranscriptFragment(stream, raw);
    if (delta) ui += delta;
  };

  emit("记得");
  emit("记得"); // 重复事件
  emit("记得你喜欢茶"); // 累积
  assert.equal(ui, "记得你喜欢茶");

  assert.equal(callsNeedFactGrounding([{ name: "recall_memory" }]), true);

  const retracted = retractCompanionSuffix(
    [{ id: 1, speaker: "小七", text: ui, fromCompanion: true }],
    ui,
  );
  assert.equal(retracted.length, 0);

  resetTranscriptStream(stream);
  const afterTool = applyTranscriptFragment(stream, "我这边暂时查不到");
  assert.equal(afterTool, "我这边暂时查不到");

  const failureNote = noteForFactQueryFailure();
  assert.match(failureNote, /查不到/);
  assert.doesNotMatch(failureNote, /^没有/);
}

console.log("turn-transcript.check: ok");
