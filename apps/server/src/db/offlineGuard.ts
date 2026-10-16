import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** 开发库的绝对路径。离线测试只能把它当作拒绝目标，不能打开。 */
export const REAL_COMPANION_DB = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../companion.db",
);

/**
 * 离线测试在 `new Database` 之前调用。
 * 返回拒绝原因；允许打开时返回 null。未开启离线测试时不检查。
 */
export function offlineDatabaseRefusal(candidate: string): string | null {
  if (process.env.COMPANION_OFFLINE_TEST !== "1") return null;

  const resolved = resolve(candidate);
  const effective = symlinkChainTarget(resolved) ?? resolved;

  if (isSameDatabaseFile(effective, REAL_COMPANION_DB)) {
    return `offline test refused real database: ${resolved}`;
  }

  if (!isTempDatabasePath(effective)) {
    return `offline test refused database outside its temp directory: ${resolved}`;
  }

  return null;
}

/**
 * 清理登记前调用。目录必须是临时目录的子目录，且不能是开发库所在目录。
 * 允许时返回规范化后的目录；否则返回拒绝原因。
 */
export function canonicalOwnedTempDir(dir: string): { dir: string } | { refusal: string } {
  const canonical = realpathIfExists(dir);

  if (!canonical) return { refusal: `temp dir missing: ${dir}` };

  const tempRoot = realpathIfExists(resolve(tmpdir()));

  if (!tempRoot || !isInside(tempRoot, canonical)) {
    return { refusal: `refusing to track a directory outside the temp dir: ${canonical}` };
  }

  const realDir = realpathIfExists(dirname(REAL_COMPANION_DB)) ?? dirname(REAL_COMPANION_DB);

  if (equalPath(canonical, realDir)) {
    return { refusal: `refusing to track the real database directory: ${canonical}` };
  }

  return { dir: canonical };
}

/** 路径字符串、符号链接、大小写和硬链接都算同一个文件。 */
export function isSameDatabaseFile(candidate: string, realDb: string): boolean {
  const left = resolve(candidate);
  const right = resolve(realDb);

  if (equalPath(left, right)) return true;

  const leftReal = realpathIfExists(left);
  const rightReal = realpathIfExists(right);

  if (leftReal && rightReal && equalPath(leftReal, rightReal)) return true;

  const leftStat = statIfExists(left);
  const rightStat = statIfExists(right);

  if (
    leftStat &&
    rightStat &&
    leftStat.dev === rightStat.dev &&
    leftStat.ino === rightStat.ino
  ) {
    return true;
  }

  const leftParent = realpathIfExists(dirname(left));
  const rightParent = realpathIfExists(dirname(right));

  return Boolean(
    leftParent &&
      rightParent &&
      equalPath(leftParent, rightParent) &&
      equalPath(basename(left), basename(right)),
  );
}

function isTempDatabasePath(candidate: string): boolean {
  const tempRoot = realpathIfExists(resolve(tmpdir()));

  if (!tempRoot) return false;

  const parent = realpathIfExists(dirname(candidate));

  if (!parent || !isInside(tempRoot, parent)) return false;

  const file = realpathIfExists(candidate);

  return !file || isInside(tempRoot, file);
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);

  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

function equalPath(left: string, right: string): boolean {
  if (left === right) return true;

  if (process.platform === "darwin" || process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }

  return false;
}

function symlinkChainTarget(path: string): string | undefined {
  let current = path;
  let followed = false;

  for (let hop = 0; hop < 8; hop += 1) {
    try {
      const stat = lstatSync(current);

      if (!stat.isSymbolicLink()) return followed ? current : undefined;

      followed = true;
      current = resolve(dirname(current), readlinkSync(current));
    } catch {
      return followed ? current : undefined;
    }
  }

  return current;
}

function realpathIfExists(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function statIfExists(path: string): { dev: number; ino: number } | undefined {
  try {
    const stat = statSync(path);

    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return undefined;
  }
}
