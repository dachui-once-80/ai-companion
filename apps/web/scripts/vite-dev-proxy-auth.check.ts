/**
 * 真实 Vite 开发代理验证（非自建转发、非仅辅助函数）。
 *
 * 流程：resolveConfig(vite.config.ts, "serve") → 仅改写 proxy target 到本地捕获端
 * → createServer(config) → 经 Vite 发 HTTP / WebSocket Upgrade，断言上游 Authorization。
 *
 * 标签：真实 Vite 代理验证
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, resolveConfig } from "vite";
import {
  COMPANION_ACCESS_TOKEN_ENV,
  MIN_COMPANION_ACCESS_TOKEN_LENGTH,
  companionBearerHeader,
} from "../vite.companionAccess.ts";

/** Synthetic test token only — not a user secret. */
const SYNTHETIC_TOKEN = "s1b-test-companion-access-token-0001";
const CLIENT_WRONG = "s1b-test-companion-access-token-CLIENT";
assert.ok(SYNTHETIC_TOKEN.length >= MIN_COMPANION_ACCESS_TOKEN_LENGTH);

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const previousToken = process.env[COMPANION_ACCESS_TOKEN_ENV];
process.env[COMPANION_ACCESS_TOKEN_ENV] = SYNTHETIC_TOKEN;

type Captured = {
  httpAuthorization: string | undefined;
  wsAuthorization: string | undefined;
};

function websocketAccept(key: string): string {
  return createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
}

const captured: Captured = {
  httpAuthorization: undefined,
  wsAuthorization: undefined,
};

const upstream = http.createServer((req, res) => {
  captured.httpAuthorization =
    typeof req.headers.authorization === "string"
      ? req.headers.authorization
      : undefined;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, via: "capture-upstream" }));
});

upstream.on("upgrade", (req, socket, head) => {
  captured.wsAuthorization =
    typeof req.headers.authorization === "string"
      ? req.headers.authorization
      : undefined;
  const key = req.headers["sec-websocket-key"];
  assert.equal(typeof key, "string");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${websocketAccept(key)}\r\n` +
      "\r\n",
  );
  void head;
  socket.end();
});

await new Promise<void>((resolve) => {
  upstream.listen(0, "127.0.0.1", () => resolve());
});
const upstreamAddr = upstream.address();
assert.ok(upstreamAddr && typeof upstreamAddr !== "string");
const upstreamBase = `http://127.0.0.1:${upstreamAddr.port}`;

let viteServer: Awaited<ReturnType<typeof createServer>> | undefined;

try {
  const config = await resolveConfig(
    {
      configFile: join(webRoot, "vite.config.ts"),
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
      },
    },
    "serve",
  );

  const proxyTable = config.server.proxy;
  assert.ok(proxyTable, "vite.config serve must define server.proxy");
  const apiProxy = proxyTable["/api"];
  assert.ok(
    apiProxy && typeof apiProxy === "object",
    "vite.config serve must define /api proxy object",
  );
  assert.equal(apiProxy.ws, true);
  assert.equal(typeof apiProxy.configure, "function");
  // Retarget only; keep production configure (Bearer inject) from vite.config.ts.
  apiProxy.target = upstreamBase;

  viteServer = await createServer(config);
  await viteServer.listen();

  const vitePort = viteServer.config.server.port;
  assert.ok(typeof vitePort === "number" && vitePort > 0);
  const viteBase = `http://127.0.0.1:${vitePort}`;

  const httpRes = await fetch(`${viteBase}/api/probe-http`, {
    headers: { Authorization: companionBearerHeader(CLIENT_WRONG) },
  });
  assert.equal(httpRes.status, 200);
  assert.equal(
    captured.httpAuthorization,
    companionBearerHeader(SYNTHETIC_TOKEN),
    "Vite HTTP proxy must overwrite client Authorization before upstream",
  );
  assert.equal(
    captured.httpAuthorization?.includes(CLIENT_WRONG) ?? false,
    false,
  );

  await new Promise<void>((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: vitePort,
      path: "/api/gemini/live-proxy/v1alpha/mock-live",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        Authorization: companionBearerHeader(CLIENT_WRONG),
      },
    });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error("Vite WS proxy upgrade timeout"));
    }, 5_000);
    req.on("upgrade", (_res, socket) => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    req.on("response", (res) => {
      clearTimeout(timer);
      reject(
        new Error(`expected Vite WS upgrade, got HTTP ${res.statusCode}`),
      );
    });
    req.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end();
  });

  assert.equal(
    captured.wsAuthorization,
    companionBearerHeader(SYNTHETIC_TOKEN),
    "Vite WS proxy must overwrite client Authorization before upstream",
  );
  assert.equal(
    captured.wsAuthorization?.includes(CLIENT_WRONG) ?? false,
    false,
  );

  console.log(
    "[vite-dev-proxy-auth] REAL_VITE_PROXY_OK http+ws Authorization injected",
  );
} finally {
  if (viteServer) {
    await viteServer.close();
  }
  await new Promise<void>((resolve, reject) => {
    upstream.close((error) => (error ? reject(error) : resolve()));
  });
  if (previousToken === undefined) {
    delete process.env[COMPANION_ACCESS_TOKEN_ENV];
  } else {
    process.env[COMPANION_ACCESS_TOKEN_ENV] = previousToken;
  }
}
