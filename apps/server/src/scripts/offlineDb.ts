import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  REAL_COMPANION_DB,
  canonicalOwnedTempDir,
  isSameDatabaseFile,
  offlineDatabaseRefusal,
} from "../db/offlineGuard.ts";

export { REAL_COMPANION_DB };

const ownedTempDirs = new Set<string>();
let exitHooked = false;

/**
 * 在导入任何会加载 db/index.ts 的模块之前调用。
 * ESM 静态导入早于模块正文，因此依赖 db 的检查脚本必须先走这里，再动态 import。
 */
export function prepareOfflineDb(prefix = "offline-"): string {
  const dir = createTrackedTempDir(prefix);
  const file = join(dir, "companion.db");

  process.env.COMPANION_DB = file;
  process.env.COMPANION_OFFLINE_TEST = "1";

  const refusal = offlineDatabaseRefusal(file);

  if (refusal) throw new Error(refusal);

  return file;
}

/** 登记本次测试创建的临时目录。清理时只认这份登记。 */
export function createTrackedTempDir(prefix: string): string {
  return trackTempDir(mkdtempSync(join(tmpdir(), prefix)));
}

export function trackTempDir(dir: string): string {
  const owned = canonicalOwnedTempDir(dir);

  if ("refusal" in owned) throw new Error(owned.refusal);

  ownedTempDirs.add(owned.dir);
  hookExitCleanup();

  return owned.dir;
}

export function isRealCompanionDb(path: string): boolean {
  return isSameDatabaseFile(path, REAL_COMPANION_DB);
}

/** 确认当前进程里的 SQLite 连接已经落在临时库，而不是开发用 companion.db。 */
export async function assertOfflineDbIsolated(expectedPath?: string): Promise<string> {
  const configured = process.env.COMPANION_DB?.trim();

  assert.equal(process.env.COMPANION_OFFLINE_TEST, "1");
  assert.ok(
    configured,
    "COMPANION_DB must be set before importing modules that open SQLite",
  );

  const refusal = offlineDatabaseRefusal(configured);

  if (refusal) throw new Error(refusal);

  const { dbFile } = await import("../db/index.ts");
  const opened = resolve(dbFile);
  const openedRefusal = offlineDatabaseRefusal(opened);

  if (openedRefusal) {
    throw new Error(`offline test connected to a refused database: ${openedRefusal}`);
  }

  if (expectedPath) {
    assert.equal(opened, resolve(expectedPath));
  } else {
    assert.equal(opened, resolve(configured));
  }

  return opened;
}

/** 只删除本进程登记过的临时目录。未登记的路径，包括开发库，直接跳过。 */
export function cleanupOfflineDb(file: string): void {
  removeOwnedTempDir(dirname(resolve(file)));
}

export function removeOwnedTempDir(dir: string): void {
  const owned = canonicalOwnedTempDir(dir);

  if ("refusal" in owned) {
    ownedTempDirs.delete(dir);
    return;
  }

  if (!ownedTempDirs.has(owned.dir)) return;

  try {
    rmSync(owned.dir, { recursive: true, force: true });
  } catch {
    // 删不掉就留在登记里，进程退出时再试一次。失败不能改掉原来的退出码。
    return;
  }

  ownedTempDirs.delete(owned.dir);
}

function hookExitCleanup(): void {
  if (exitHooked) return;

  exitHooked = true;
  process.on("exit", () => {
    for (const dir of [...ownedTempDirs]) {
      removeOwnedTempDir(dir);
    }
  });
}
