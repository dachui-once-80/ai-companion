/**
 * 启动本次 P1-C 的 mock 与 Vite。
 * 测试进程直接持有这两个 ChildProcess。
 * 某个直接子进程的 exit 只证明该进程已退出，不证明 loader、Vite 后代或浏览器已退出。
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertBoundPort,
  assertNavigationPorts,
  assertSignalAllowed,
  buildP1cChildEnv,
  buildP1cViteCliArgs,
  parseViteLocalPort,
  reserveLoopbackPort,
} from "./p1cApiOrigin.ts";
import type { P1cConsolidateLog, P1cMode, P1cUnexpectedLog } from "./p1cMockApi.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const liveDisposers = new Set<() => Promise<void>>();
const heldChildren = new Set<DirectChild>();

const STOP_WAIT_MS = 8_000;
const MOCK_READY_MS = 15_000;
const VITE_READY_MS = 30_000;

/**
 * absent 用 null 表示，不进入此类型。
 * held：句柄已保存，尚未发出 SIGTERM。
 * stop-requested：已对该句柄调用一次 kill("SIGTERM")。
 * exited：已观察到 exit 事件，或退出字段已经可读。
 * unknown：有界等待结束时仍没有退出证据。一旦进入就不再改成 exited。
 */
type DirectPhase = "held" | "stop-requested" | "exited" | "unknown";

type DirectChild = {
  role: "mock" | "vite";
  child: ChildProcess;
  phase: DirectPhase;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  errorText?: string;
  termSent: boolean;
  stopAttempted: boolean;
  diagnostic: string;
  onLog?: (line: string) => void;
  onExit?: () => void;
  onObservedError?: () => void;
};

export const P1C_PROFILE_ROOT = path.join(
  webRoot,
  ".playwright",
  "profiles",
  "p1c-startup-drain",
);

type Waiter = (log: P1cConsolidateLog) => void;

export type P1cPage = {
  goto(url: string, options: { waitUntil: "domcontentloaded" }): Promise<unknown>;
  evaluate<T, A>(pageFunction: (arg: A) => T, arg: A): Promise<T>;
};

export type P1cSession = {
  readonly origin: string;
  readonly apiPort: number;
  readonly vitePort: number;
  readonly profileDir: string;
  readonly mode: P1cMode;
  readonly consolidateLogs: readonly P1cConsolidateLog[];
  readonly unexpectedLogs: readonly P1cUnexpectedLog[];
  waitForConsolidate(batchId: string, timeoutMs: number): Promise<P1cConsolidateLog>;
  gotoApp(page: P1cPage): Promise<void>;
  dispose(options?: { retainProfile?: boolean }): Promise<void>;
};

function safeText(error: unknown): string {
  const raw = error instanceof Error ? error.message : "signal failed";

  if (/token|gemini|authorization|secret/i.test(raw)) return "signal failed";

  return raw.slice(0, 200);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;

  return typeof error.code === "string" ? error.code : undefined;
}

function rememberDiagnostic(record: DirectChild, line: string): void {
  const trimmed = line.trim();

  if (trimmed.length === 0 || /token|gemini|authorization|secret/i.test(trimmed)) return;

  record.diagnostic = `${record.diagnostic}${trimmed}\n`.slice(-1_500);
}

function observeExit(
  record: DirectChild,
  code: number | null,
  signal: NodeJS.Signals | null,
): void {
  if (code === null && signal === null) return;

  if (record.exitCode === null && record.signalCode === null) {
    record.exitCode = code;
    record.signalCode = signal;
  }

  heldChildren.delete(record);

  if (record.phase === "unknown" || record.phase === "exited") return;

  record.phase = "exited";
  const notify = record.onExit;
  record.onExit = undefined;
  notify?.();
}

function noteExitFromFields(record: DirectChild): void {
  observeExit(record, record.child.exitCode, record.child.signalCode);
}

function bindOutput(record: DirectChild): void {
  let stdoutPending = "";
  let stderrPending = "";

  const take = (pending: string, chunk: Buffer, stream: "stdout" | "stderr"): string => {
    const lines = `${pending}${chunk.toString("utf8")}`.split("\n");
    const rest = lines.pop() ?? "";

    for (const line of lines) {
      if (stream === "stderr") rememberDiagnostic(record, line);

      record.onLog?.(line);
    }

    return rest;
  };

  record.child.stdout?.on("data", (chunk: Buffer) => {
    stdoutPending = take(stdoutPending, chunk, "stdout");
  });
  record.child.stderr?.on("data", (chunk: Buffer) => {
    stderrPending = take(stderrPending, chunk, "stderr");
  });
}

function spawnDirect(
  role: DirectChild["role"],
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): DirectChild {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("P1-C refuses to spawn without POSIX child signals");
  }

  const child = spawn(process.execPath, args, {
    cwd: webRoot,
    env,
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record: DirectChild = {
    role,
    child,
    phase: "held",
    exitCode: null,
    signalCode: null,
    termSent: false,
    stopAttempted: false,
    diagnostic: "",
  };

  heldChildren.add(record);
  child.on("exit", (code, signal) => {
    observeExit(record, code, signal);
  });
  child.on("error", (error: Error) => {
    record.errorText = record.errorText ?? safeText(error);
    record.onObservedError?.();
  });
  bindOutput(record);
  noteExitFromFields(record);

  return record;
}

function assertHeldPid(record: DirectChild): void {
  const pid = record.child.pid;

  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) {
    throw new Error(`P1-C ${record.role} pid is missing; cleanup state is unknown`);
  }

  assertSignalAllowed(pid);
}

function requestStop(record: DirectChild): void {
  if (record.stopAttempted || record.phase === "exited" || record.phase === "unknown") return;

  noteExitFromFields(record);

  if (record.phase === "exited") return;

  record.stopAttempted = true;
  const pid = record.child.pid;

  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) {
    record.errorText = record.errorText ?? "pid missing";
    return;
  }

  try {
    assertSignalAllowed(pid);
  } catch {
    record.errorText = record.errorText ?? "pid is not signalable";
    return;
  }

  record.termSent = true;

  try {
    const delivered = record.child.kill("SIGTERM");

    if (record.phase === "held") record.phase = "stop-requested";

    noteExitFromFields(record);

    if (record.phase !== "exited" && !delivered) {
      record.errorText = record.errorText ?? "child.kill SIGTERM returned false";
    }
  } catch (error) {
    const code = errorCode(error);

    record.errorText =
      record.errorText ??
      (code === "ESRCH"
        ? "SIGTERM returned ESRCH; exit was not observed"
        : safeText(error));
  }
}

process.once("exit", () => {
  // 外部 SIGKILL 不会进入这个钩子。这里不能等待，信号发送也不是退出证据。
  for (const record of heldChildren) {
    try {
      requestStop(record);
    } catch {
      // 一个直接子进程无法发信号时，继续处理另一个已持有的句柄。
    }
  }
});

function waitForRecordedExit(record: DirectChild, timeoutMs: number): Promise<void> {
  noteExitFromFields(record);

  if (record.phase === "exited" || record.phase === "unknown") return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);

      if (record.onExit === finish) record.onExit = undefined;

      resolve();
    };

    timer = setTimeout(() => {
      noteExitFromFields(record);
      finish();
    }, timeoutMs);
    record.onExit = finish;
    noteExitFromFields(record);

    if (record.phase === "exited") finish();
  });
}

function requireEntry(relative: string): string {
  const absolute = path.join(webRoot, relative);

  if (!fs.existsSync(absolute)) {
    throw new Error(`P1-C missing entry ${relative}`);
  }

  return absolute;
}

function assertOwnedProfile(dir: string): void {
  const resolved = path.resolve(dir);
  const root = path.resolve(P1C_PROFILE_ROOT);
  const relative = path.relative(root, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("refusing to delete a profile outside p1c-startup-drain");
  }

  if (!/^run-[A-Za-z0-9_-]+$/.test(path.basename(resolved))) {
    throw new Error("refusing to delete a profile that is not a p1c run directory");
  }
}

function parseReadyPort(line: string): number | null {
  const match = /^P1C_READY (\d+)$/.exec(line.trim());

  if (!match?.[1]) return null;

  return Number(match[1]);
}

function redact(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/token|gemini|authorization|secret/i.test(line))
    .join("\n")
    .slice(0, 500);
}

function childFailure(record: DirectChild, headline: string): Error {
  const extra = [record.errorText, record.diagnostic.trim()].filter(
    (part): part is string => Boolean(part && part.length > 0),
  );

  return new Error(redact(extra.length > 0 ? `${headline}\n${extra.join("\n")}` : headline));
}

function waitForReady(
  record: DirectChild,
  read: (line: string) => number | null,
  timeoutMs: number,
): Promise<number> {
  noteExitFromFields(record);

  if (record.phase === "exited") {
    return Promise.reject(childFailure(record, `P1-C ${record.role} exited before ready`));
  }

  if (record.errorText) {
    return Promise.reject(childFailure(record, `P1-C ${record.role} failed to start`));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutPending = "";
    let stderrPending = "";
    let timer: ReturnType<typeof setTimeout>;

    const finish = (settle: () => void) => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);
      record.child.stdout?.off("data", onStdout);
      record.child.stderr?.off("data", onStderr);

      if (record.onExit === onExit) record.onExit = undefined;

      if (record.onObservedError === onError) record.onObservedError = undefined;

      settle();
    };
    const onExit = () => {
      finish(() => reject(childFailure(record, `P1-C ${record.role} exited before ready`)));
    };
    const onError = () => {
      noteExitFromFields(record);

      if (record.phase === "exited") {
        finish(() => reject(childFailure(record, `P1-C ${record.role} exited before ready`)));
        return;
      }

      finish(() => reject(childFailure(record, `P1-C ${record.role} failed to start`)));
    };
    const take = (pending: string, chunk: Buffer): string => {
      const lines = `${pending}${chunk.toString("utf8")}`.split("\n");
      const rest = lines.pop() ?? "";

      for (const line of lines) {
        const port = read(line);

        if (port === null) continue;

        finish(() => resolve(port));
        return rest;
      }

      return rest;
    };
    const onStdout = (chunk: Buffer) => {
      stdoutPending = take(stdoutPending, chunk);
    };
    const onStderr = (chunk: Buffer) => {
      stderrPending = take(stderrPending, chunk);
    };

    timer = setTimeout(() => {
      noteExitFromFields(record);

      if (record.phase === "exited") {
        finish(() => reject(childFailure(record, `P1-C ${record.role} exited before ready`)));
        return;
      }

      finish(() => reject(childFailure(record, `P1-C ${record.role} did not become ready`)));
    }, timeoutMs);
    record.onExit = onExit;
    record.onObservedError = onError;
    record.child.stdout?.on("data", onStdout);
    record.child.stderr?.on("data", onStderr);
    noteExitFromFields(record);

    if (record.phase === "exited") onExit();
    else if (record.errorText) onError();
  });
}

export async function startP1cSession(mode: P1cMode): Promise<P1cSession> {
  fs.mkdirSync(P1C_PROFILE_ROOT, { recursive: true });
  const profileDir = fs.mkdtempSync(path.join(P1C_PROFILE_ROOT, "run-"));
  const consolidateLogs: P1cConsolidateLog[] = [];
  const unexpectedLogs: P1cUnexpectedLog[] = [];
  const waiters: Waiter[] = [];
  let apiRecord: DirectChild | null = null;
  let viteRecord: DirectChild | null = null;
  let apiPort = 0;
  let vitePort = 0;
  let ready = false;
  let disposing: Promise<void> | null = null;
  let resolveDispose: () => void = () => undefined;
  let rejectDispose: (error: unknown) => void = () => undefined;

  const noteLine = (line: string) => {
    if (!line.startsWith("P1C_LOG ")) return;

    try {
      const parsed = JSON.parse(line.slice("P1C_LOG ".length)) as
        | { type: "consolidate"; entry: P1cConsolidateLog }
        | { type: "unexpected"; entry: P1cUnexpectedLog };

      if (parsed.type === "consolidate") {
        consolidateLogs.push(parsed.entry);

        for (const waiter of [...waiters]) waiter(parsed.entry);
      } else {
        unexpectedLogs.push(parsed.entry);
      }
    } catch {
      unexpectedLogs.push({
        method: "LOG",
        path: "malformed",
        status: 404,
      });
    }
  };

  async function stopOne(record: DirectChild | null, failures: string[]): Promise<void> {
    if (record === null) return;

    try {
      noteExitFromFields(record);

      if (record.phase === "unknown") {
        throw childFailure(record, `P1-C ${record.role} cleanup state is unknown`);
      }

      if (record.phase !== "exited") {
        requestStop(record);

        if (record.phase !== "exited") await waitForRecordedExit(record, STOP_WAIT_MS);

        if (record.phase !== "exited") {
          throw childFailure(record, `P1-C ${record.role} cleanup state is unknown`);
        }
      }
    } catch (error) {
      if (record.phase !== "exited") record.phase = "unknown";

      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  async function cleanupSession(retainProfile: boolean): Promise<void> {
    ready = false;
    const failures: string[] = [];

    await stopOne(viteRecord, failures);
    await stopOne(apiRecord, failures);

    const bothExited = apiRecord?.phase === "exited" && viteRecord?.phase === "exited";

    // 只删除本次 profileDir。只有 retainProfile 为 false 且两个直接子进程都已 exited 才删除。
    // 这不证明 loader、Vite 后代或浏览器进程已经退出。
    if (bothExited && !retainProfile) {
      try {
        assertOwnedProfile(profileDir);
        fs.rmSync(profileDir, { recursive: true, force: true });
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }

    if (failures.length > 0) {
      if (!bothExited) failures.push("profile retained");

      throw new Error(failures.join("; "));
    }

    liveDisposers.delete(dispose);
  }

  function dispose(options?: { retainProfile?: boolean }): Promise<void> {
    if (disposing) return disposing;

    const retainProfile = options?.retainProfile === false ? false : true;

    disposing = new Promise<void>((resolve, reject) => {
      resolveDispose = resolve;
      rejectDispose = reject;
    });
    void cleanupSession(retainProfile).then(
      () => resolveDispose(),
      (error: unknown) => rejectDispose(error),
    );

    return disposing;
  }

  liveDisposers.add(dispose);

  try {
    const loader = requireEntry("node_modules/tsx/dist/loader.mjs");
    const mockEntry = requireEntry("e2e/helpers/p1cMockServe.ts");
    const reservedApiPort = await reserveLoopbackPort();

    apiRecord = spawnDirect(
      "mock",
      ["--import", loader, mockEntry, `--mode=${mode}`, `--port=${reservedApiPort}`],
      buildP1cChildEnv({ source: process.env }),
    );
    apiRecord.onLog = noteLine;
    assertHeldPid(apiRecord);
    apiPort = await waitForReady(apiRecord, parseReadyPort, MOCK_READY_MS);

    if (apiPort !== reservedApiPort) {
      throw new Error("P1-C mock ready port does not match the reserved port");
    }

    assertBoundPort(apiPort, "api");

    const viteEntry = requireEntry("node_modules/vite/bin/vite.js");
    const reservedVitePort = await reserveLoopbackPort();
    const apiOrigin = `http://127.0.0.1:${apiPort}`;

    viteRecord = spawnDirect(
      "vite",
      [viteEntry, ...buildP1cViteCliArgs(reservedVitePort)],
      buildP1cChildEnv({
        source: process.env,
        apiOrigin,
        vitePort: reservedVitePort,
      }),
    );
    assertHeldPid(viteRecord);
    vitePort = await waitForReady(
      viteRecord,
      (line) => {
        const port = parseViteLocalPort(line);

        return port === reservedVitePort ? port : null;
      },
      VITE_READY_MS,
    );

    if (vitePort !== reservedVitePort) {
      throw new Error("P1-C Vite port does not match the reserved port");
    }

    assertNavigationPorts(apiPort, vitePort);
    ready = true;
  } catch (error) {
    let cleanup = "";

    try {
      await dispose({ retainProfile: false });
    } catch (cleanupError) {
      cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    }

    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(redact(cleanup.length > 0 ? `${detail}; ${cleanup}` : detail));
  }

  return {
    mode,
    profileDir,
    apiPort,
    vitePort,
    origin: `http://127.0.0.1:${vitePort}/`,
    get consolidateLogs() {
      return consolidateLogs;
    },
    get unexpectedLogs() {
      return unexpectedLogs;
    },
    waitForConsolidate(batchId, timeoutMs) {
      const existing = consolidateLogs.find((log) => log.batchId === batchId);

      if (existing) return Promise.resolve(existing);

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.indexOf(onLog);

          if (index >= 0) waiters.splice(index, 1);

          reject(new Error(`timed out waiting for consolidate batch ${batchId}`));
        }, timeoutMs);
        const onLog = (log: P1cConsolidateLog) => {
          if (log.batchId !== batchId) return;

          clearTimeout(timer);
          const index = waiters.indexOf(onLog);

          if (index >= 0) waiters.splice(index, 1);

          resolve(log);
        };

        waiters.push(onLog);
      });
    },
    async gotoApp(page) {
      if (!ready) throw new Error("P1-C ports are not ready for navigation");

      assertNavigationPorts(apiPort, vitePort);
      await page.goto(`http://127.0.0.1:${vitePort}/`, {
        waitUntil: "domcontentloaded",
      });
    },
    dispose,
  };
}

export function assertDeletableP1cProfile(dir: string): void {
  assertOwnedProfile(dir);
}

export async function disposeAllP1cSessions(): Promise<void> {
  const jobs = [...liveDisposers];

  await Promise.all(jobs.map((job) => job()));
}
