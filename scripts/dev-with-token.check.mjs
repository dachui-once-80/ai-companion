/**
 * Fail-closed + no-leak + process-lifecycle checks for scripts/dev-with-token.mjs.
 * Uses synthetic tokens, temp files, and mock/fake processes only.
 * Never prints token values. Does not start real server/Vite or call Gemini.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "dev-with-token.mjs");
const SYNTHETIC =
  "s1b-local-dev-with-token-check-token-0001";
assert.ok(SYNTHETIC.length >= 32);

const {
  loadCompanionTokenFromFile,
  createChildEnv,
  resolveTokenFilePath,
  waitForChildExit,
  runDevProcesses,
  killProcessTree,
  listChildPids,
  COMPANION_ACCESS_TOKEN_ENV,
  MIN_COMPANION_ACCESS_TOKEN_LENGTH,
} = await import(pathToFileURL(SCRIPT).href);

assert.equal(MIN_COMPANION_ACCESS_TOKEN_LENGTH, 32);
assert.equal(COMPANION_ACCESS_TOKEN_ENV, "COMPANION_ACCESS_TOKEN");

const tempRoot = mkdtempSync(join(tmpdir(), "dev-with-token-check-"));
const cleanupDirs = [tempRoot];

function assertOutputSafe(combined, label) {
  assert.equal(
    combined.includes(SYNTHETIC),
    false,
    `${label} must not print the synthetic token`,
  );
  assert.equal(
    /VITE_COMPANION_ACCESS_TOKEN/.test(combined),
    false,
    `${label} must not mention VITE_COMPANION_ACCESS_TOKEN`,
  );
}

function createMockChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.exitCode = null;
  child.kill = (signal) => {
    child.killed = true;
    child.emit("_kill", signal);
  };
  child.finish = (code = 0) => {
    child.exitCode = code;
    child.emit("exit", code, null);
  };
  return child;
}

try {
  // --- unit: missing file ---
  const missingPath = join(tempRoot, "missing-token");
  assert.throws(
    () => loadCompanionTokenFromFile(missingPath),
    /missing/i,
  );

  // --- unit: too short ---
  const shortPath = join(tempRoot, "short-token");
  writeFileSync(shortPath, "too-short\n", "utf8");
  assert.throws(
    () => loadCompanionTokenFromFile(shortPath),
    /at least 32/,
  );

  // --- unit: trailing newline stripped, length ok ---
  const okPath = join(tempRoot, "ok-token");
  writeFileSync(okPath, `${SYNTHETIC}\n`, "utf8");
  const loaded = loadCompanionTokenFromFile(okPath);
  assert.equal(loaded, SYNTHETIC);

  // --- unit: createChildEnv only sets token; preserves other keys ---
  const base = {
    PATH: "/usr/bin",
    COMPANION_DB: "/tmp/example-isolation.db",
    COMPANION_OFFLINE_TEST: "1",
    HTTP_PROXY: "off",
    GEMINI_API_KEY: "placeholder-not-a-real-key",
  };
  const childEnv = createChildEnv(loaded, base);
  assert.equal(childEnv[COMPANION_ACCESS_TOKEN_ENV], SYNTHETIC);
  assert.equal(childEnv.COMPANION_DB, base.COMPANION_DB);
  assert.equal(childEnv.COMPANION_OFFLINE_TEST, "1");
  assert.equal(childEnv.HTTP_PROXY, "off");
  assert.equal(childEnv.GEMINI_API_KEY, base.GEMINI_API_KEY);

  // --- unit: resolveTokenFilePath ---
  assert.equal(
    resolveTokenFilePath({}, ROOT),
    join(ROOT, ".local", "companion-token"),
  );
  assert.equal(
    resolveTokenFilePath({ COMPANION_TOKEN_FILE: okPath }, ROOT),
    okPath,
  );

  // --- waitForChildExit: killed=true must NOT resolve early ---
  {
    const child = createMockChild(4242);
    child.killed = true;
    let resolved = false;
    const waitPromise = waitForChildExit(child).then((code) => {
      resolved = true;
      return code;
    });

    await new Promise((r) => setTimeout(r, 30));
    assert.equal(
      resolved,
      false,
      "waitForChildExit must ignore child.killed until exit",
    );

    child.finish(7);
    const code = await waitPromise;
    assert.equal(code, 7);
    assert.equal(resolved, true);
  }

  // --- spawn failure: non-zero exit, sibling tree kill ---
  {
    const killedTrees = [];
    const exitCodes = [];
    let spawnCount = 0;
    const childrenByFilter = new Map();

    const spawnImpl = (_cmd, args) => {
      spawnCount += 1;
      const filter = args[1];
      const child = createMockChild(5000 + spawnCount);
      childrenByFilter.set(filter, child);
      if (filter === "server") {
        queueMicrotask(() => {
          child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
        });
      }
      return child;
    };

    runDevProcesses(
      "all",
      { PATH: "/usr/bin" },
      {
        spawn: spawnImpl,
        killProcessTree: (pid, signal) => {
          killedTrees.push({ pid, signal });
          const match = [...childrenByFilter.values()].find((c) => c.pid === pid);
          if (match && match.exitCode === null) {
            queueMicrotask(() => match.finish(1));
          }
        },
        exit: (code) => {
          exitCodes.push(code);
        },
        bindSignals: false,
        forceKillMs: 50,
      },
    );

    assert.equal(spawnCount, 2);
    await new Promise((r) => setTimeout(r, 80));

    assert.ok(exitCodes.length >= 1, "spawn error must call exit");
    assert.notEqual(exitCodes[0], 0);
    assert.ok(
      killedTrees.some((k) => k.pid === childrenByFilter.get("web").pid),
      "all-mode spawn failure must kill the other child tree",
    );
  }

  // --- all mode: one exit cleans the other via killProcessTree ---
  {
    const killedTrees = [];
    const exitCodes = [];
    const childrenByFilter = new Map();

    const spawnImpl = (_cmd, args) => {
      const filter = args[1];
      const child = createMockChild(filter === "server" ? 6001 : 6002);
      childrenByFilter.set(filter, child);
      return child;
    };

    runDevProcesses(
      "all",
      { PATH: "/usr/bin" },
      {
        spawn: spawnImpl,
        killProcessTree: (pid, signal) => {
          killedTrees.push({ pid, signal });
          const match = [...childrenByFilter.values()].find((c) => c.pid === pid);
          if (match && match.exitCode === null) {
            queueMicrotask(() => match.finish(0));
          }
        },
        exit: (code) => {
          exitCodes.push(code);
        },
        bindSignals: false,
        forceKillMs: 50,
      },
    );

    childrenByFilter.get("server").finish(1);
    await new Promise((r) => setTimeout(r, 80));

    assert.ok(exitCodes.includes(1));
    assert.ok(
      killedTrees.some((k) => k.pid === 6002 && k.signal === "SIGTERM"),
      "exiting server must SIGTERM web tree",
    );
  }

  // --- real fake process tree: killProcessTree reaches grandchild (macOS/Linux) ---
  if (process.platform !== "win32") {
    const marker = join(tempRoot, "grandchild-alive");
    const childScript = join(tempRoot, "tree-child.mjs");
    writeFileSync(
      childScript,
      `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const marker = process.argv[2];
const grand = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
writeFileSync(marker, String(grand.pid), "utf8");
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    let parent = null;
    let grandPid = null;

    try {
      parent = spawn(process.execPath, [childScript, marker], {
        stdio: "ignore",
      });
      assert.ok(parent.pid);

      for (let i = 0; i < 50; i += 1) {
        try {
          grandPid = Number(readFileSync(marker, "utf8").trim());
          if (Number.isFinite(grandPid) && grandPid > 0) break;
        } catch {
          // not written yet
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.ok(grandPid, "grandchild pid marker");

      const kids = listChildPids(parent.pid);
      assert.ok(kids.includes(grandPid), "listChildPids should see grandchild");

      killProcessTree(parent.pid, "SIGTERM");
      await waitForChildExit(parent);

      await new Promise((r) => setTimeout(r, 100));
      const still = spawnSync("kill", ["-0", String(grandPid)], {
        encoding: "utf8",
      });
      assert.notEqual(
        still.status,
        0,
        "grandchild must be gone after killProcessTree",
      );
    } finally {
      // Best-effort cleanup; never throw — preserve the original test failure.
      try {
        if (parent?.pid) {
          killProcessTree(parent.pid, "SIGKILL");
        }
      } catch {
        // ignore
      }
      try {
        if (typeof grandPid === "number" && grandPid > 0) {
          killProcessTree(grandPid, "SIGKILL");
        }
      } catch {
        // ignore
      }
      try {
        if (parent && parent.exitCode === null) {
          await Promise.race([
            waitForChildExit(parent),
            new Promise((r) => setTimeout(r, 500)),
          ]);
        }
      } catch {
        // ignore
      }
    }
  }

  // --- CLI: missing file fail-closed, no token in output ---
  {
    const result = spawnSync(process.execPath, [SCRIPT, "server"], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        COMPANION_TOKEN_FILE: missingPath,
        DEV_WITH_TOKEN_DRY_RUN: "1",
      },
    });
    assert.notEqual(result.status, 0);
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.match(combined, /missing/i);
    assertOutputSafe(combined, "missing-file CLI");
  }

  // --- CLI: short file fail-closed ---
  {
    const result = spawnSync(process.execPath, [SCRIPT, "web"], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        COMPANION_TOKEN_FILE: shortPath,
        DEV_WITH_TOKEN_DRY_RUN: "1",
      },
    });
    assert.notEqual(result.status, 0);
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.match(combined, /at least 32/);
    assertOutputSafe(combined, "short-file CLI");
  }

  // --- CLI: dry-run ready marker, no token leaked ---
  {
    const result = spawnSync(process.execPath, [SCRIPT, "all"], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        COMPANION_TOKEN_FILE: okPath,
        DEV_WITH_TOKEN_DRY_RUN: "1",
        COMPANION_DB: base.COMPANION_DB,
        COMPANION_OFFLINE_TEST: "1",
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /DEV_WITH_TOKEN_READY/);
    const combined = `${result.stdout}\n${result.stderr}`;
    assertOutputSafe(combined, "dry-run CLI");
  }

  // --- CLI: bad mode ---
  {
    const result = spawnSync(process.execPath, [SCRIPT, "nope"], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        COMPANION_TOKEN_FILE: okPath,
      },
    });
    assert.equal(result.status, 2);
    assertOutputSafe(`${result.stdout}\n${result.stderr}`, "bad-mode CLI");
  }

  // --- source hygiene: launcher must not introduce browser env prefix ---
  {
    const source = readFileSync(SCRIPT, "utf8");
    assert.equal(source.includes("VITE_COMPANION_ACCESS_TOKEN"), false);
    assert.equal(/\bdefine\s*:/.test(source), false);
    assert.equal(source.includes("child.killed"), false);
    assert.equal(
      source.includes("console.log(token)") ||
        source.includes("console.log(loaded)"),
      false,
    );
  }

  console.log("[dev-with-token.check] OK");
} finally {
  for (const dir of cleanupDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
