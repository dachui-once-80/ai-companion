import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareOfflineDb } from "./offlineDb.ts";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const offlineDb = prepareOfflineDb("live-precondition-");
const scripts = [
  "src/scripts/prompt.live.ts",
  "src/scripts/persona.live.ts",
  "src/scripts/meaning.live.ts",
  "src/scripts/between.live.ts",
];
const env = {
  ...process.env,
  COMPANION_DB: offlineDb,
  COMPANION_OFFLINE_TEST: "1",
  COMPANION_LIVE_SKIP_DOTENV: "1",
  GEMINI_API_KEY: "",
};

for (const script of scripts) {
  const result = spawnSync("pnpm", ["exec", "tsx", script], {
    cwd: serverRoot,
    encoding: "utf8",
    env,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

  console.log("[live-precondition]", script, "status", result.status);
  assert.notEqual(result.status, 0, output);
  assert.match(output, /live precondition not met: GEMINI_API_KEY is missing/);
  assert.doesNotMatch(output, /\[(prompt|persona|meaning|between)\] live ok/);
  // 密钥检查在动态导入 *.check 之前：缺密钥时不应跑离线正文，也不应发起生成请求。
  assert.doesNotMatch(output, /\[prompt\] new connection/);
  assert.doesNotMatch(output, /\[meaning\] offline ok/);
  assert.doesNotMatch(output, /\[persona\] fixed tastes/);
  assert.doesNotMatch(output, /\[between\] pipeline ok/);
  assert.doesNotMatch(output, /generateContent|Empty consolidation response|429|RESOURCE_EXHAUSTED/);
}

console.log("[live-precondition] missing key exits non-zero before check import / Gemini");
