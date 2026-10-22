/**
 * P1-C mock 服务入口。只在被当作脚本执行时监听。
 * 不导入正式 server 入口或数据库模块。
 */

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertP1cListenPort,
  decideP1cRequest,
  type P1cMode,
} from "./p1cMockApi.ts";

const entry = fileURLToPath(import.meta.url);

function invokedDirectly(): boolean {
  return process.argv.some((arg) => {
    if (arg === entry) return true;

    return arg.endsWith(`${path.sep}p1cMockServe.ts`) || arg.endsWith("/p1cMockServe.ts");
  });
}

function readMode(argv: readonly string[]): P1cMode {
  const arg = argv.find((item) => item.startsWith("--mode="));
  const mode = arg?.slice("--mode=".length);

  if (mode === "success" || mode === "disconnect") return mode;

  throw new Error("P1-C mock mode must be success or disconnect");
}

function readListenPort(argv: readonly string[]): number {
  const arg = argv.find((item) => item.startsWith("--port="));
  const raw = arg?.slice("--port=".length);

  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new Error("P1-C mock port is required before bind");
  }

  const port = Number(raw);

  assertP1cListenPort(port);

  return port;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;

      if (size > 262_144) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function startP1cMockProcess(mode: P1cMode, port: number): http.Server {
  assertP1cListenPort(port);

  const server = http.createServer((req, res) => {
    void (async () => {
      const enteredAt = new Date().toISOString();
      const host = req.headers.host ?? "127.0.0.1";
      const url = `http://${host}${req.url ?? "/"}`;
      let body = "";

      try {
        body = await readBody(req);
      } catch {
        body = "x".repeat(262_145);
      }

      const decision = decideP1cRequest({
        method: req.method ?? "GET",
        url,
        body,
        mode,
        enteredAt,
        receivedAt: new Date().toISOString(),
      });

      if (decision.kind === "disconnect") {
        const closedAt = new Date().toISOString();
        const entry = { ...decision.consolidate, closedAt };

        process.stdout.write(
          `P1C_LOG ${JSON.stringify({ type: "consolidate", entry })}\n`,
        );
        req.socket.destroy();
        return;
      }

      if (decision.consolidate) {
        process.stdout.write(
          `P1C_LOG ${JSON.stringify({ type: "consolidate", entry: decision.consolidate })}\n`,
        );
      }

      if (decision.unexpected) {
        process.stdout.write(
          `P1C_LOG ${JSON.stringify({ type: "unexpected", entry: decision.unexpected })}\n`,
        );
      }

      res.writeHead(decision.status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(decision.body));
    })().catch(() => {
      if (!res.headersSent) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "p1c_unexpected_request" }));
      }
    });
  });

  server.on("upgrade", (req, socket) => {
    const pathName = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    process.stdout.write(
      `P1C_LOG ${JSON.stringify({
        type: "unexpected",
        entry: { method: "UPGRADE", path: pathName, status: 404 },
      })}\n`,
    );
    socket.destroy();
  });

  const onListenError = () => {
    console.error("P1-C mock failed to bind the reserved port");
    process.exit(1);
  };

  server.once("error", onListenError);
  server.listen(port, "127.0.0.1", () => {
    server.off("error", onListenError);
    const address = server.address();

    if (!address || typeof address === "string" || address.port !== port) {
      console.error("P1-C mock bound a different port");
      server.close(() => {
        process.exit(1);
      });
      return;
    }

    try {
      assertP1cListenPort(address.port);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      server.close(() => {
        process.exit(1);
      });
      return;
    }

    process.stdout.write(`P1C_READY ${address.port}\n`);
  });

  return server;
}

if (invokedDirectly()) {
  try {
    startP1cMockProcess(readMode(process.argv), readListenPort(process.argv));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
