/**
 * P1-C supervisor。只管理自己 spawn 的那一个直接子进程。
 * 收到该 ChildProcess 的 exit 事件，且信号状态不是 error 或 refused 时，
 * 向 fd 3 写一行确认，再以 0 退出。没有这个 exit 事件时不以 0 退出，也不写成功确认。
 * 父进程只从这条管道读取确认。
 * stderr 上的相同字节不是确认。
 * 这一行只说明这个直接子进程已退出。
 * Vite 或其他程序自行创建、且本进程没有句柄的后代不在此列，本文件不会清理它们。
 * 不扫描进程表，也不向进程组或负 PID 发信号。
 */

import fs from "node:fs";
import { spawn } from "node:child_process";

const IPC_FD = 3;

const PROTECTED_PIDS = new Set([56873, 56890]);
const TERM_WAIT_MS = 3_000;
const KILL_WAIT_MS = 1_000;
const marker = process.argv.indexOf("--");
const command = marker >= 0 ? process.argv.slice(marker + 1) : [];

function refuse(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (process.platform !== "darwin" && process.platform !== "linux") {
  refuse("P1-C supervisor refuses to run without POSIX child signals");
}

if (command.length === 0 || command[0] !== process.execPath) {
  refuse("P1-C supervisor only starts the current node binary");
}

const childEnv = {};

for (const key of ["PATH", "HOME", "TMPDIR", "P1C_API_ORIGIN", "P1C_VITE_PORT"]) {
  const value = process.env[key];

  if (typeof value === "string" && value.length > 0) childEnv[key] = value;
}

// 子进程 fd 3 是单独打开的 /dev/null。blockingIpcFd 与 doStop 共用同一模块级绑定。
let child;
let childSink = null;
let blockingIpcFd = null;

try {
  childSink = fs.openSync("/dev/null", "w");

  if (childSink === IPC_FD) {
    blockingIpcFd = childSink;
    childSink = fs.openSync("/dev/null", "w");

    if (childSink === IPC_FD) {
      throw new Error("direct-child sink collided with confirmation fd");
    }

    fs.closeSync(blockingIpcFd);
    blockingIpcFd = null;
  }

  child = spawn(command[0], command.slice(1), {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ["ignore", "inherit", "inherit", childSink],
  });
} catch (error) {
  if (blockingIpcFd !== null) {
    try {
      fs.closeSync(blockingIpcFd);
      blockingIpcFd = null;
    } catch (closeError) {
      const closeText = closeError instanceof Error ? closeError.message : String(closeError);

      error.message += `; closing temporary fd 3 failed: ${closeText}`;
    }
  }

  throw error;
} finally {
  if (childSink !== null && childSink !== IPC_FD) {
    try {
      fs.closeSync(childSink);
    } catch {
      // 关闭独立的 /dev/null 失败时不掩盖原始异常，也不打断已经启动的子进程。
    }
  }
}

let childExit = null;
let stopping = false;
let sentTerm = false;
let sentKill = false;
let signaledGone = false;

function directChildAlive() {
  return (
    !signaledGone &&
    childExit === null &&
    child.exitCode === null &&
    child.signalCode === null
  );
}

let signalProblem = null;
let signalDetail = null;

function signalDirectChild(signal) {
  if (!directChildAlive()) return "inactive";

  if (signal === "SIGTERM" && sentTerm) return "already-sent";

  if (signal === "SIGKILL" && sentKill) return "already-sent";

  const pid = child.pid;

  if (!Number.isInteger(pid) || pid <= 1 || PROTECTED_PIDS.has(pid)) return "refused";

  if (signal === "SIGTERM") sentTerm = true;

  if (signal === "SIGKILL") sentKill = true;

  try {
    const delivered = child.kill(signal);

    if (!directChildAlive()) return "inactive";

    if (!delivered) return "not-delivered";

    return "delivered";
  } catch (error) {
    if (error && error.code === "ESRCH") {
      signaledGone = true;
      return "esrch";
    }

    if (!signalDetail) {
      const code = error && error.code ? String(error.code) : "signal failed";
      signalDetail = /token|gemini|authorization|secret/i.test(code) ? "signal failed" : code.slice(0, 80);
    }

    return "error";
  }
}

function waitForChildExit(ms) {
  if (childExit) return Promise.resolve(true);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(childExit !== null);
    }, ms);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };

    child.once("exit", onExit);
  });
}

function writeThenExit(text, code) {
  let exited = false;
  const done = () => {
    if (exited) return;

    exited = true;
    process.exit(code);
  };

  process.stderr.write(text.endsWith("\n") ? text : `${text}\n`, () => done());
  setTimeout(done, 200);
}

function rememberProblem(result) {
  if (result === "error" || result === "refused") {
    signalProblem = result;
    return;
  }

  if (
    (result === "not-delivered" || result === "esrch") &&
    signalProblem !== "error" &&
    signalProblem !== "refused"
  ) {
    signalProblem = signalProblem ?? result;
  }
}

function unknownExitReason() {
  if (signalProblem === "refused") return "signal refused";
  if (signalProblem === "error") return signalDetail ? `signal error: ${signalDetail}` : "signal error";
  if (signalProblem === "not-delivered") return "signal not delivered";
  if (signalProblem === "esrch") return "pid was not found; exit was not observed";

  return "timed out after a bounded stop attempt";
}

function finishUnconfirmed() {
  writeThenExit(
    `P1-C supervisor could not confirm its direct child exited; state unknown (${unknownExitReason()})\n`,
    1,
  );
}

function finishBlockedConfirmation() {
  const detail = signalDetail ? `${signalProblem}:${signalDetail}` : signalProblem;

  writeThenExit(
    `P1-C supervisor observed its direct child exit but will not confirm success (${detail})\n`,
    1,
  );
}

async function doStop() {
  const termed = directChildAlive() ? signalDirectChild("SIGTERM") : "inactive";

  rememberProblem(termed);

  if (!childExit) await waitForChildExit(TERM_WAIT_MS);

  if (termed !== "refused" && directChildAlive()) {
    const killed = signalDirectChild("SIGKILL");

    rememberProblem(killed);

    if (!childExit) await waitForChildExit(KILL_WAIT_MS);
  } else if (termed !== "refused" && !childExit && signaledGone) {
    await waitForChildExit(KILL_WAIT_MS);
  }

  if (!childExit) {
    finishUnconfirmed();
    return;
  }

  if (signalProblem === "error" || signalProblem === "refused") {
    finishBlockedConfirmation();
    return;
  }

  const code = childExit.code === null ? "null" : String(childExit.code);
  const signal = childExit.signal === null ? "null" : childExit.signal;

  if (blockingIpcFd !== null) {
    writeThenExit("P1-C supervisor could not write direct-child exit confirmation\n", 1);
    return;
  }

  try {
    fs.writeSync(IPC_FD, `P1C_CHILD_EXITED code=${code} signal=${signal}\n`);
  } catch {
    writeThenExit("P1-C supervisor could not write direct-child exit confirmation\n", 1);
    return;
  }

  if (!childExit) {
    finishUnconfirmed();
    return;
  }

  process.exit(0);
}

function stop() {
  if (stopping) return;

  stopping = true;
  void doStop().catch((error) => {
    const raw = error instanceof Error ? error.message : "stop failed";
    const safe = /token|gemini|authorization|secret/i.test(raw) ? "stop failed" : raw.slice(0, 200);

    if (!childExit) {
      writeThenExit(
        `P1-C supervisor could not confirm its direct child exited; state unknown (${safe})\n`,
        1,
      );
      return;
    }

    writeThenExit(
      `P1-C supervisor observed its direct child exit but will not confirm success (${safe})\n`,
      1,
    );
  });
}

child.on("exit", (code, signal) => {
  childExit = { code, signal };
  stop();
});
child.on("error", stop);
process.stdin.resume();
process.stdin.on("end", stop);
process.stdin.on("close", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
