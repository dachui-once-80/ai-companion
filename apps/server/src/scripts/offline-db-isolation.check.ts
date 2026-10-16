import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalOwnedTempDir,
  isSameDatabaseFile,
  offlineDatabaseRefusal,
} from "../db/offlineGuard.ts";
import {
  REAL_COMPANION_DB,
  assertOfflineDbIsolated,
  cleanupOfflineDb,
  createTrackedTempDir,
  isRealCompanionDb,
  prepareOfflineDb,
  removeOwnedTempDir,
} from "./offlineDb.ts";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const dbModule = join(serverRoot, "src/db/index.ts");
const thoughtStore = join(serverRoot, "src/companion/ThoughtStore.ts");

// 先准备临时库并打开离线开关。这一步不导入 db/index.ts。
const localPath = prepareOfflineDb("offline-iso-");
const realExistedBefore = existsSync(REAL_COMPANION_DB);
const realBytesBefore = realExistedBefore ? lstatSync(REAL_COMPANION_DB).size : 0;
const realNlinkBefore = realExistedBefore ? lstatSync(REAL_COMPANION_DB).nlink : 0;

assert.match(offlineDatabaseRefusal(REAL_COMPANION_DB) ?? "", /refused real database/);
assert.match(
  offlineDatabaseRefusal(caseVariant(REAL_COMPANION_DB)) ?? "",
  /refused real database/,
);
assert.match(offlineDatabaseRefusal(`${REAL_COMPANION_DB}.bak`) ?? "", /refused/);

// 相对路径：只解析路径字符串，不打开数据库。
const relativeRealDb = relative(process.cwd(), REAL_COMPANION_DB) || "companion.db";
assert.match(offlineDatabaseRefusal(relativeRealDb) ?? "", /refused real database/);
assert.match(offlineDatabaseRefusal("./companion.db") ?? "", /refused real database/);
console.log("[offline-db-isolation] relative path refused");

const linkDir = createTrackedTempDir("offline-iso-link-");
const linkPath = join(linkDir, "companion.db");
symlinkSync(REAL_COMPANION_DB, linkPath);
assert.match(offlineDatabaseRefusal(linkPath) ?? "", /refused real database/);

// 多跳符号链接：临时目录内 A -> B -> 真实库；只做元数据拒绝，不打开库。
const hopDir = createTrackedTempDir("offline-iso-hop-");
const hopMid = join(hopDir, "mid.db");
const hopPath = join(hopDir, "companion.db");
symlinkSync(REAL_COMPANION_DB, hopMid);
symlinkSync(hopMid, hopPath);
assert.match(offlineDatabaseRefusal(hopPath) ?? "", /refused real database/);
console.log("[offline-db-isolation] multi-hop symlink refused");

// 相对目标的符号链接：link 文本是相对路径，仍须拒绝。
const relLinkDir = createTrackedTempDir("offline-iso-rellink-");
const relLinkPath = join(relLinkDir, "companion.db");
symlinkSync(relative(relLinkDir, REAL_COMPANION_DB), relLinkPath);
assert.match(offlineDatabaseRefusal(relLinkPath) ?? "", /refused real database/);
console.log("[offline-db-isolation] relative symlink refused");

// 临时目录中的硬链接指向真实库：只创建/删除本测试的目录项，不读不写真实库内容。
const hardDir = createTrackedTempDir("offline-iso-hard-");
const hardPath = join(hardDir, "companion.db");
let hardLinkToReal: "passed" | "skipped" = "skipped";

try {
  linkSync(REAL_COMPANION_DB, hardPath);
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  console.log(`[offline-db-isolation] hardlink to real db SKIPPED: ${reason}`);
}

if (existsSync(hardPath)) {
  assert.equal(lstatSync(hardPath).isFile(), true);
  assert.equal(isSameDatabaseFile(hardPath, REAL_COMPANION_DB), true);
  assert.match(offlineDatabaseRefusal(hardPath) ?? "", /refused real database/);
  hardLinkToReal = "passed";
  console.log("[offline-db-isolation] hardlink to real db refused");
}

assert.equal(existsSync(REAL_COMPANION_DB), realExistedBefore);
if (realExistedBefore) {
  assert.equal(lstatSync(REAL_COMPANION_DB).size, realBytesBefore);
}

const inodeDir = createTrackedTempDir("offline-iso-ino-");
const inodeFile = join(inodeDir, "original.db");
const inodeLink = join(inodeDir, "linked.db");
writeFileSync(inodeFile, "not-a-database");
linkSync(inodeFile, inodeLink);
assert.equal(isSameDatabaseFile(inodeLink, inodeFile), true);

const untrackedDir = mkdtempSync(join(tmpdir(), "offline-iso-untracked-"));
const untrackedFile = join(untrackedDir, "keep.txt");
writeFileSync(untrackedFile, "keep");
cleanupOfflineDb(untrackedFile);
cleanupOfflineDb(REAL_COMPANION_DB);
assert.equal(existsSync(untrackedFile), true, "cleanup removed an untracked temp file");
assert.equal(existsSync(REAL_COMPANION_DB), realExistedBefore);

// 纯检查通过后，才允许本进程导入 db。
const opened = await assertOfflineDbIsolated(localPath);
assert.equal(opened, localPath);
assert.equal(isRealCompanionDb(opened), false);
assert.notEqual(opened, REAL_COMPANION_DB);
console.log("[offline-db-isolation] local opened", opened);

// 父进程环境里即使写着开发库，子进程也只用 spawn 显式传入的临时库。
process.env.COMPANION_DB = REAL_COMPANION_DB;
const childDir = createTrackedTempDir("offline-iso-child-");
const childDb = join(childDir, "companion.db");
const child = spawnProbe(
  childDir,
  "static-import-probe.ts",
  `
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { inventsCompanionLife } from ${JSON.stringify(thoughtStore)};
import { dbFile } from ${JSON.stringify(dbModule)};

const expected = process.env.COMPANION_DB?.trim();
assert.ok(expected);
assert.equal(resolve(dbFile), resolve(expected));
assert.notEqual(resolve(dbFile), resolve(${JSON.stringify(REAL_COMPANION_DB)}));
assert.equal(typeof inventsCompanionLife, "function");
console.log("[offline-db-isolation] child opened", dbFile);
`,
  { COMPANION_DB: childDb, COMPANION_OFFLINE_TEST: "1" },
);
assert.equal(child.status, 0, `static-import child failed:\n${child.stdout}\n${child.stderr}`);
assert.ok((child.stdout ?? "").includes(childDb), child.stdout ?? "");
assert.doesNotMatch(child.stdout ?? "", new RegExp(escapeRegExp(REAL_COMPANION_DB)));

// 新鲜进程把开发库、指向开发库的符号链接，或只改了大小写的路径交给 db/index.ts。
// 纯函数已经拒绝过这些路径；这里确认模块在 new Database 之前退出。
assertRefused(childDir, "refuse-real.ts", REAL_COMPANION_DB, /refused real database/);
assertRefused(childDir, "refuse-symlink.ts", linkPath, /refused real database/);
assertRefused(childDir, "refuse-hop.ts", hopPath, /refused real database/);
assertRefused(childDir, "refuse-rellink.ts", relLinkPath, /refused real database/);
assertRefused(childDir, "refuse-relative.ts", relativeRealDb, /refused real database/);
assertRefused(childDir, "refuse-case.ts", caseVariant(REAL_COMPANION_DB), /refused/);
if (hardLinkToReal === "passed") {
  assertRefused(childDir, "refuse-hardlink.ts", hardPath, /refused real database/);
}
assert.equal(existsSync(REAL_COMPANION_DB), realExistedBefore);
if (realExistedBefore) {
  assert.equal(lstatSync(REAL_COMPANION_DB).size, realBytesBefore);
}

const failDir = createTrackedTempDir("offline-iso-fail-");
const failScript = join(failDir, "fail-cleanup.ts");
writeFileSync(
  failScript,
  `
import { prepareOfflineDb } from ${JSON.stringify(join(serverRoot, "src/scripts/offlineDb.ts"))};
const file = prepareOfflineDb("offline-fail-");
console.log(file);
throw new Error("boom-before-cleanup");
`,
);
const failed = spawnSync("pnpm", ["exec", "tsx", failScript], {
  cwd: serverRoot,
  encoding: "utf8",
  env: {
    ...process.env,
    COMPANION_DB: childDb,
    COMPANION_OFFLINE_TEST: "1",
  },
});
assert.notEqual(failed.status, 0);
assert.match(`${failed.stdout ?? ""}\n${failed.stderr ?? ""}`, /boom-before-cleanup/);
const failedPath = (failed.stdout ?? "").trim().split("\n").at(-1) ?? "";
assert.ok(failedPath.includes("offline-fail-"), failed.stdout ?? "");
assert.equal(existsSync(failedPath), false);
assert.equal(existsSync(dirname(failedPath)), false);

let refused = false;

try {
  process.env.COMPANION_DB = REAL_COMPANION_DB;
  await assertOfflineDbIsolated(REAL_COMPANION_DB);
} catch (error) {
  refused = true;
  assert.match(error instanceof Error ? error.message : String(error), /refused real database/);
}

assert.equal(refused, true);
assert.equal(existsSync(REAL_COMPANION_DB), realExistedBefore);

cleanupOfflineDb(localPath);
removeOwnedTempDir(linkDir);
removeOwnedTempDir(hopDir);
removeOwnedTempDir(relLinkDir);
if (existsSync(hardPath)) {
  // 只删本测试创建的硬链接目录项，绝不 unlink 真实库路径。
  unlinkSync(hardPath);
}
removeOwnedTempDir(hardDir);
removeOwnedTempDir(inodeDir);
removeOwnedTempDir(childDir);
removeOwnedTempDir(failDir);
removeProbeDir(untrackedDir);
assert.equal(existsSync(REAL_COMPANION_DB), realExistedBefore);
if (realExistedBefore) {
  assert.equal(lstatSync(REAL_COMPANION_DB).size, realBytesBefore);
  assert.equal(lstatSync(REAL_COMPANION_DB).nlink, realNlinkBefore);
}

console.log(
  "[offline-db-isolation] temp path enforced; real db refused",
  `hardlink=${hardLinkToReal}`,
);

function assertRefused(dir: string, name: string, databasePath: string, message: RegExp): void {
  const result = spawnProbe(
    dir,
    name,
    `
import { dbFile } from ${JSON.stringify(dbModule)};
console.log("UNEXPECTED OPEN", dbFile);
`,
    { COMPANION_DB: databasePath, COMPANION_OFFLINE_TEST: "1" },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

  assert.notEqual(result.status, 0, output);
  assert.match(output, message);
  assert.doesNotMatch(output, /\[offline-db\] open|UNEXPECTED OPEN/);
}

function spawnProbe(
  dir: string,
  name: string,
  source: string,
  env: { COMPANION_DB: string; COMPANION_OFFLINE_TEST: "1" },
) {
  const script = join(dir, name);

  writeFileSync(script, source);

  return spawnSync("pnpm", ["exec", "tsx", script], {
    cwd: serverRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
  });
}

function removeProbeDir(dir: string): void {
  const owned = canonicalOwnedTempDir(dir);

  if ("refusal" in owned) {
    throw new Error(owned.refusal);
  }

  rmSync(owned.dir, { recursive: true, force: true });
}

function caseVariant(path: string): string {
  const last = path.charAt(path.length - 1);
  const flipped = last === last.toLowerCase() ? last.toUpperCase() : last.toLowerCase();

  return path.slice(0, -1) + flipped;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
