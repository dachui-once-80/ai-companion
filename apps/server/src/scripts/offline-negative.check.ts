import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const result = spawnSync(
  "pnpm",
  ["exec", "tsx", "src/scripts/offline-assert-fail.sample.ts"],
  {
    cwd: serverRoot,
    encoding: "utf8",
    env: process.env,
  },
);
const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

console.log("[offline-negative] child status", result.status);
assert.notEqual(result.status, 0);
assert.match(output, /deliberate offline assertion failure/);
console.log("[offline-negative] failing assertion exits non-zero");
