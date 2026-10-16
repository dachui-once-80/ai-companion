import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTrackedTempDir, removeOwnedTempDir } from "./offlineDb.ts";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const scripts = [
  "src/scripts/offline-db-isolation.check.ts",
  "src/scripts/closeness.check.ts",
  "src/scripts/reunion.check.ts",
  "src/scripts/aside.check.ts",
  "src/scripts/profile.check.ts",
  "src/scripts/meaning.check.ts",
  "src/scripts/prompt.check.ts",
  "src/scripts/persona.check.ts",
  "src/scripts/between.check.ts",
  "src/scripts/live-precondition.check.ts",
  "src/scripts/offline-negative.check.ts",
  "src/scripts/rename.check.ts",
];

let failed = 0;

for (const script of scripts) {
  // 每个子进程独立临时库：即使脚本里仍有危险静态导入，spawn 环境也会先于模块求值生效。
  // 这里覆盖父进程可能继承来的 COMPANION_DB，避免子进程沿用开发库。
  const dir = createTrackedTempDir("offline-run-");
  const file = join(dir, "companion.db");
  const result = spawnSync("pnpm", ["exec", "tsx", script], {
    cwd: serverRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      COMPANION_DB: file,
      COMPANION_OFFLINE_TEST: "1",
    },
  });

  removeOwnedTempDir(dir);

  if (result.status !== 0) {
    failed += 1;
    console.error(`[offline] ${script} exited ${result.status}`);
  }
}

if (failed > 0) {
  process.exit(1);
}

console.log("[offline] all checks passed");
