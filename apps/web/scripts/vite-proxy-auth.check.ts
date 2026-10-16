import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPANION_ACCESS_TOKEN_ENV,
  MIN_COMPANION_ACCESS_TOKEN_LENGTH,
  applyCompanionProxyAuthorization,
  companionBearerHeader,
  injectCompanionAuthorization,
  readCompanionAccessTokenFromEnv,
} from "../vite.companionAccess.ts";

/** Synthetic test token only — not a user secret. */
const SYNTHETIC_TOKEN = "s1b-test-companion-access-token-0001";
const CLIENT_WRONG = "s1b-test-companion-access-token-CLIENT";
assert.ok(SYNTHETIC_TOKEN.length >= MIN_COMPANION_ACCESS_TOKEN_LENGTH);

// --- fail-closed config helpers ---
{
  assert.throws(() => readCompanionAccessTokenFromEnv({}), /is not configured/);
  assert.throws(
    () =>
      readCompanionAccessTokenFromEnv({
        [COMPANION_ACCESS_TOKEN_ENV]: "short",
      }),
    /at least/,
  );
}

// --- overwrite client Authorization ---
{
  const headers: Record<string, string> = {
    Authorization: companionBearerHeader(CLIENT_WRONG),
  };
  injectCompanionAuthorization(
    {
      setHeader(name, value) {
        headers[name] = value;
      },
    },
    SYNTHETIC_TOKEN,
  );
  assert.equal(headers.Authorization, companionBearerHeader(SYNTHETIC_TOKEN));
  assert.equal(headers.Authorization.includes(CLIENT_WRONG), false);
}

// --- configure wires both HTTP and WS hooks ---
{
  const fakeProxy = {
    handlers: {
      proxyReq: [] as Array<
        (proxyReq: { setHeader(n: string, v: string): void }) => void
      >,
      proxyReqWs: [] as Array<
        (proxyReq: { setHeader(n: string, v: string): void }) => void
      >,
    },
    on(
      event: "proxyReq" | "proxyReqWs",
      listener: (proxyReq: { setHeader(n: string, v: string): void }) => void,
    ) {
      this.handlers[event].push(listener);
    },
  };
  applyCompanionProxyAuthorization(fakeProxy, SYNTHETIC_TOKEN);
  assert.equal(fakeProxy.handlers.proxyReq.length, 1);
  assert.equal(fakeProxy.handlers.proxyReqWs.length, 1);

  const httpHeaders: Record<string, string> = {
    Authorization: companionBearerHeader(CLIENT_WRONG),
  };
  fakeProxy.handlers.proxyReq[0]!({
    setHeader(name, value) {
      httpHeaders[name] = value;
    },
  });
  assert.equal(httpHeaders.Authorization, companionBearerHeader(SYNTHETIC_TOKEN));

  const wsHeaders: Record<string, string> = {
    Authorization: companionBearerHeader(CLIENT_WRONG),
  };
  fakeProxy.handlers.proxyReqWs[0]!({
    setHeader(name, value) {
      wsHeaders[name] = value;
    },
  });
  assert.equal(wsHeaders.Authorization, companionBearerHeader(SYNTHETIC_TOKEN));
}

type Captured = {
  httpAuthorization: string | undefined;
  wsAuthorization: string | undefined;
};

/**
 * 标签：Mock 验证（自建 Node 转发 + 同源 inject 辅助函数）。
 * 真实 Vite 开发代理见 vite-dev-proxy-auth.check.ts（REAL_VITE_PROXY）。
 */
await (async () => {
  const captured: Captured = {
    httpAuthorization: undefined,
    wsAuthorization: undefined,
  };

  const target = http.createServer((req, res) => {
    captured.httpAuthorization =
      typeof req.headers.authorization === "string"
        ? req.headers.authorization
        : undefined;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });

  target.on("upgrade", (req, socket, head) => {
    captured.wsAuthorization =
      typeof req.headers.authorization === "string"
        ? req.headers.authorization
        : undefined;
    void head;
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n" +
        "\r\n",
    );
    socket.end();
  });

  await new Promise<void>((resolve) => {
    target.listen(0, "127.0.0.1", () => resolve());
  });
  const targetAddr = target.address();
  assert.ok(targetAddr && typeof targetAddr !== "string");

  const proxyServer = http.createServer((clientReq, clientRes) => {
    const outbound = http.request(
      {
        hostname: "127.0.0.1",
        port: targetAddr.port,
        path: clientReq.url,
        method: clientReq.method,
        headers: { ...clientReq.headers, host: `127.0.0.1:${targetAddr.port}` },
      },
      (upstreamRes) => {
        clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
      },
    );
    injectCompanionAuthorization(outbound, SYNTHETIC_TOKEN);
    clientReq.pipe(outbound);
  });

  proxyServer.on("upgrade", (clientReq, clientSocket, clientHead) => {
    const outbound = http.request({
      hostname: "127.0.0.1",
      port: targetAddr.port,
      path: clientReq.url,
      method: "GET",
      headers: {
        ...clientReq.headers,
        host: `127.0.0.1:${targetAddr.port}`,
        connection: "Upgrade",
        upgrade: "websocket",
      },
    });
    injectCompanionAuthorization(outbound, SYNTHETIC_TOKEN);
    outbound.on("upgrade", (_upstreamRes, upstreamSocket, upstreamHead) => {
      clientSocket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n\r\n",
      );
      upstreamSocket.write(upstreamHead);
      clientSocket.write(clientHead);
      upstreamSocket.pipe(clientSocket).pipe(upstreamSocket);
    });
    outbound.on("error", () => clientSocket.destroy());
    outbound.end();
  });

  await new Promise<void>((resolve) => {
    proxyServer.listen(0, "127.0.0.1", () => resolve());
  });
  const proxyAddr = proxyServer.address();
  assert.ok(proxyAddr && typeof proxyAddr !== "string");

  try {
    const httpRes = await fetch(
      `http://127.0.0.1:${proxyAddr.port}/api/probe`,
      {
        headers: { Authorization: companionBearerHeader(CLIENT_WRONG) },
      },
    );
    assert.equal(httpRes.status, 200);
    assert.equal(
      captured.httpAuthorization,
      companionBearerHeader(SYNTHETIC_TOKEN),
    );

    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port: proxyAddr.port,
        path: "/api/gemini/live-proxy/v1alpha/mock",
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          Authorization: companionBearerHeader(CLIENT_WRONG),
        },
      });
      req.on("upgrade", (_res, socket) => {
        socket.destroy();
        resolve();
      });
      req.on("response", (res) => {
        reject(new Error(`expected upgrade, got HTTP ${res.statusCode}`));
      });
      req.on("error", reject);
      req.end();
    });

    assert.equal(
      captured.wsAuthorization,
      companionBearerHeader(SYNTHETIC_TOKEN),
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      proxyServer.close((error) => (error ? reject(error) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      target.close((error) => (error ? reject(error) : resolve()));
    });
  }
})();

// Fail-closed: vite resolveConfig("serve") without env.
{
  const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const env = { ...process.env };
  delete env[COMPANION_ACCESS_TOKEN_ENV];
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "tsx",
      "--eval",
      `
import { resolveConfig } from "vite";
resolveConfig({ configFile: "vite.config.ts" }, "serve").then(() => {
  console.error("EXPECTED_FAIL");
  process.exit(2);
}).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes(${JSON.stringify(COMPANION_ACCESS_TOKEN_ENV)})) {
    console.error(message);
    process.exit(3);
  }
  console.log("SERVE_FAIL_CLOSED_OK");
});
`,
    ],
    {
      cwd: webRoot,
      env,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /SERVE_FAIL_CLOSED_OK/);
  assert.equal(
    (result.stdout + result.stderr).includes(SYNTHETIC_TOKEN),
    false,
  );
}

console.log(
  "[vite-proxy-auth] MOCK_HELPER_PROXY_OK inject HTTP/WS + serve fail-closed ok",
);
