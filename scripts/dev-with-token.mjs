/**
 * Local-only launcher: load Companion access token from `.local/companion-token`
 * (or COMPANION_TOKEN_FILE), inject COMPANION_ACCESS_TOKEN into child env, spawn
 * server and/or Vite. Never print the token or pass it on argv.
 *
 * Process cleanup (macOS/Linux): recursively SIGTERM/SIGKILL the pnpm PID and
 * descendants via `pgrep -P` so tsx/Vite grandchildren exit. Windows tree-kill
 * is best-effort (`taskkill /T`) and not the supported local-dev path.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const COMPANION_ACCESS_TOKEN_ENV = "COMPANION_ACCESS_TOKEN";
export const MIN_COMPANION_ACCESS_TOKEN_LENGTH = 32;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const MODES = new Set(["server", "web", "all"]);

/** Resolve token file path; COMPANION_TOKEN_FILE is for tests / explicit override. */
export function resolveTokenFilePath(
  env = process.env,
  root = ROOT,
) {
  const override = env.COMPANION_TOKEN_FILE?.trim();
  if (override) {
    return isAbsolute(override) ? override : resolve(root, override);
  }
  return join(root, ".local", "companion-token");
}

/**
 * Read token file: strip trailing newlines, require length >= 32.
 * Never logs the token value.
 */
export function loadCompanionTokenFromFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(
      `Companion token file is missing: ${filePath}\n` +
        `Create it (e.g. openssl rand -hex 32) and chmod 600. Do not commit it.`,
    );
  }

  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    throw new Error(`Companion token file could not be read: ${filePath}`);
  }

  const token = raw.replace(/\r?\n$/, "").trimEnd();
  if (!token) {
    throw new Error(`Companion token file is empty: ${filePath}`);
  }
  if (token.length < MIN_COMPANION_ACCESS_TOKEN_LENGTH) {
    throw new Error(
      `Companion token must be at least ${MIN_COMPANION_ACCESS_TOKEN_LENGTH} characters (${filePath})`,
    );
  }

  return token;
}

/** Inherit process.env; only set COMPANION_ACCESS_TOKEN from the file. */
export function createChildEnv(token, baseEnv = process.env) {
  return {
    ...baseEnv,
    [COMPANION_ACCESS_TOKEN_ENV]: token,
  };
}

/** Direct children of `pid` (macOS/Linux via pgrep). */
export function listChildPids(pid, run = spawnSync) {
  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) {
    return [];
  }

  if (process.platform === "win32") {
    return [];
  }

  const result = run("pgrep", ["-P", String(pid)], {
    encoding: "utf8",
  });

  if (result.status !== 0 || !result.stdout) {
    return [];
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * Terminate a process and its descendants.
 * Unix: recurse with `pgrep -P` then `process.kill`.
 * Windows: `taskkill /T` best-effort (not the supported path for this project).
 */
export function killProcessTree(
  pid,
  signal = "SIGTERM",
  deps = {},
) {
  const run = deps.spawnSync ?? spawnSync;
  const killPid = deps.kill ?? ((target, sig) => process.kill(target, sig));

  if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) {
    return;
  }

  if (process.platform === "win32") {
    run(
      "taskkill",
      ["/PID", String(pid), "/T", signal === "SIGKILL" ? "/F" : "/F"],
      { stdio: "ignore" },
    );
    return;
  }

  for (const childPid of listChildPids(pid, run)) {
    killProcessTree(childPid, signal, deps);
  }

  try {
    killPid(pid, signal);
  } catch {
    // ESRCH: already gone
  }
}

/** Wait until the child has actually exited — never treat `killed` as done. */
export function waitForChildExit(child) {
  return new Promise((resolveWait) => {
    let settled = false;

    const settle = (code) => {
      if (settled) return;
      settled = true;
      child.removeListener("exit", onExit);
      resolveWait(code);
    };

    const onExit = (code) => {
      settle(code);
    };

    if (child.exitCode !== null) {
      settle(child.exitCode);
      return;
    }

    child.once("exit", onExit);

    // Re-check after subscribe: exit may have fired between the null check and once().
    if (child.exitCode !== null) {
      settle(child.exitCode);
    }
  });
}

function parseMode(argv) {
  const mode = argv[2];
  if (!mode || !MODES.has(mode)) {
    console.error(
      "Usage: node scripts/dev-with-token.mjs <server|web|all>\n" +
        "Reads .local/companion-token (or COMPANION_TOKEN_FILE) and starts pnpm dev filters.",
    );
    process.exit(2);
  }
  return mode;
}

/**
 * Start server and/or web filters. Injectable deps for tests.
 * @returns {{ shutdown: (code?: number) => Promise<void>, children: unknown[] }}
 */
export function runDevProcesses(mode, env, deps = {}) {
  const spawnImpl = deps.spawn ?? spawn;
  const killTree = deps.killProcessTree ?? killProcessTree;
  const exitProcess =
    deps.exit ??
    ((code) => {
      process.exit(code);
    });
  const forceKillMs = deps.forceKillMs ?? 5_000;
  const root = deps.root ?? ROOT;
  const bindSignals = deps.bindSignals !== false;

  /** @type {import("node:child_process").ChildProcess[]} */
  const children = [];
  let shuttingDown = false;
  let exitCode = 0;
  /** @type {Promise<void> | null} */
  let shutdownPromise = null;

  function signalChildTree(child, signal) {
    if (child.exitCode !== null) return;
    if (typeof child.pid === "number") {
      killTree(child.pid, signal);
      return;
    }
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
  }

  async function shutdown(code = 0) {
    if (shutdownPromise) return shutdownPromise;

    shuttingDown = true;
    exitCode = code;

    shutdownPromise = (async () => {
      for (const child of children) {
        signalChildTree(child, "SIGTERM");
      }

      const forceTimer = setTimeout(() => {
        for (const child of children) {
          if (child.exitCode === null) {
            signalChildTree(child, "SIGKILL");
          }
        }
      }, forceKillMs);
      forceTimer.unref?.();

      await Promise.all(children.map((child) => waitForChildExit(child)));
      clearTimeout(forceTimer);
      exitProcess(exitCode);
    })();

    return shutdownPromise;
  }

  function track(child) {
    children.push(child);

    child.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[dev-with-token] child spawn/error: ${message}`);
      void shutdown(1);
    });

    child.on("exit", (code, signal) => {
      if (shuttingDown) return;
      if (signal) {
        exitCode = exitCode || 1;
      } else if (typeof code === "number" && code !== 0) {
        exitCode = code;
      }
      void shutdown(exitCode);
    });
  }

  function spawnDev(filter) {
    return spawnImpl("pnpm", ["--filter", filter, "dev"], {
      cwd: root,
      env,
      stdio: "inherit",
    });
  }

  if (bindSignals) {
    const onSignal = (signal) => {
      void shutdown(signal === "SIGINT" ? 130 : 143);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }

  if (mode === "server" || mode === "all") {
    track(spawnDev("server"));
  }
  if (mode === "web" || mode === "all") {
    track(spawnDev("web"));
  }

  return { shutdown, children, getExitCode: () => exitCode };
}

function main() {
  const mode = parseMode(process.argv);
  const tokenFile = resolveTokenFilePath(process.env, ROOT);
  let token;
  try {
    token = loadCompanionTokenFromFile(tokenFile);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }

  const env = createChildEnv(token, process.env);

  // Test-only: validate load + env inject without starting Vite/server.
  if (process.env.DEV_WITH_TOKEN_DRY_RUN === "1") {
    const injected = env[COMPANION_ACCESS_TOKEN_ENV];
    if (
      typeof injected !== "string" ||
      injected.length < MIN_COMPANION_ACCESS_TOKEN_LENGTH
    ) {
      console.error("DEV_WITH_TOKEN_DRY_RUN: token inject failed");
      process.exit(1);
    }
    console.log("DEV_WITH_TOKEN_READY");
    process.exit(0);
  }

  runDevProcesses(mode, env);
}

const isDirectRun =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main();
}
