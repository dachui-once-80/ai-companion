/**
 * 标签：生产 handler 绑定验证（attachLiveProxyUpgrade）+ 本地 mock upstream。
 * 不连接真实 Gemini；不 import apps/server/src/index.ts。
 */
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { MIN_COMPANION_ACCESS_TOKEN_LENGTH } from "../auth/accessToken.ts";
import {
  createVoiceSessionCounter,
  type LiveProxySocket,
} from "../gemini/liveProxyBridge.ts";
import {
  LIVE_PROXY_PREFIX,
  attachLiveProxyUpgrade,
} from "../gemini/liveProxyUpgrade.ts";

/** Synthetic test token only — not a user secret. */
const SYNTHETIC_TOKEN = "s1b-test-companion-access-token-0001";
const WRONG_TOKEN = "s1b-test-companion-access-token-BAD!";
assert.ok(SYNTHETIC_TOKEN.length >= MIN_COMPANION_ACCESS_TOKEN_LENGTH);

async function listenProxy(connectEcho: () => WebSocket): Promise<{
  baseHttp: string;
  voice: ReturnType<typeof createVoiceSessionCounter>;
  upstreamCreates: { count: number };
  upstreamUrls: string[];
  close: () => Promise<void>;
}> {
  const voice = createVoiceSessionCounter();
  const upstreamCreates = { count: 0 };
  const upstreamUrls: string[] = [];
  const liveProxyWss = new WebSocketServer({ noServer: true });
  const server = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.end("no http");
  });

  attachLiveProxyUpgrade({
    server,
    wss: liveProxyWss,
    accessToken: SYNTHETIC_TOKEN,
    voice,
    openUpstream: (upstreamUrl) => {
      upstreamCreates.count += 1;
      upstreamUrls.push(upstreamUrl);
      return connectEcho() as unknown as LiveProxySocket;
    },
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");

  return {
    baseHttp: `http://127.0.0.1:${addr.port}`,
    voice,
    upstreamCreates,
    upstreamUrls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        liveProxyWss.close();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function upgradeDenied(
  baseHttp: string,
  headers?: Record<string, string>,
): Promise<number> {
  const url =
    baseHttp.replace(/^http/, "ws") + `${LIVE_PROXY_PREFIX}/v1alpha/mock-live`;

  return await new Promise<number>((resolve, reject) => {
    const client = new WebSocket(url, { headers });
    const timer = setTimeout(() => {
      client.terminate();
      reject(new Error("upgrade deny timeout"));
    }, 3_000);

    client.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      const status = res.statusCode ?? 0;
      res.resume();
      client.terminate();
      resolve(status);
    });
    client.on("open", () => {
      clearTimeout(timer);
      client.close();
      reject(new Error("upgrade unexpectedly opened"));
    });
    client.on("error", () => {
      // may race with unexpected-response
    });
  });
}

async function upgradeAllowed(baseHttp: string): Promise<WebSocket> {
  const url =
    baseHttp.replace(/^http/, "ws") + `${LIVE_PROXY_PREFIX}/v1alpha/mock-live`;

  return await new Promise<WebSocket>((resolve, reject) => {
    const client = new WebSocket(url, {
      headers: { Authorization: `Bearer ${SYNTHETIC_TOKEN}` },
    });
    const timer = setTimeout(() => {
      client.terminate();
      reject(new Error("upgrade allow timeout"));
    }, 3_000);

    client.on("open", () => {
      clearTimeout(timer);
      resolve(client);
    });
    client.on("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      reject(new Error(`upgrade denied with ${res.statusCode}`));
    });
    client.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout waiting for ${label}`);
}

// Local echo upstream (not Gemini).
const upstreamServer = http.createServer();
const upstreamWss = new WebSocketServer({ server: upstreamServer });
await new Promise<void>((resolve) => {
  upstreamServer.listen(0, "127.0.0.1", () => resolve());
});
const upstreamAddr = upstreamServer.address();
assert.ok(upstreamAddr && typeof upstreamAddr !== "string");
const echoUrl = `ws://127.0.0.1:${upstreamAddr.port}`;

const proxy = await listenProxy(() => new WebSocket(echoUrl));

try {
  assert.equal(await upgradeDenied(proxy.baseHttp), 401);
  assert.equal(proxy.upstreamCreates.count, 0);
  assert.equal(proxy.voice.count(), 0);
  assert.equal(proxy.upstreamUrls.length, 0);

  assert.equal(
    await upgradeDenied(proxy.baseHttp, {
      Authorization: `Bearer ${WRONG_TOKEN}`,
    }),
    401,
  );
  assert.equal(proxy.upstreamCreates.count, 0);
  assert.equal(proxy.voice.count(), 0);

  // Wrong path: destroyed without creating upstream.
  {
    const bad = new WebSocket(
      proxy.baseHttp.replace(/^http/, "ws") + "/not-live-proxy",
    );
    await Promise.race([
      once(bad, "error"),
      once(bad, "unexpected-response"),
      once(bad, "close"),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
    bad.terminate();
    assert.equal(proxy.upstreamCreates.count, 0);
    assert.equal(proxy.voice.count(), 0);
  }

  const client = await upgradeAllowed(proxy.baseHttp);
  assert.equal(proxy.upstreamCreates.count, 1);
  assert.equal(proxy.upstreamUrls.length, 1);
  assert.match(
    proxy.upstreamUrls[0]!,
    /^wss:\/\/generativelanguage\.googleapis\.com\/v1alpha\/mock-live$/,
  );

  await waitFor(() => proxy.voice.count() === 1, "voice begin");
  assert.equal(proxy.voice.count(), 1);

  client.close();
  client.close(); // repeat close must not leak / panic
  await once(client, "close");

  await waitFor(() => proxy.voice.count() === 0, "voice end");
  assert.equal(proxy.voice.count(), 0);

  // Second authorized session still cleans up after terminate.
  const client2 = await upgradeAllowed(proxy.baseHttp);
  assert.equal(proxy.upstreamCreates.count, 2);
  await waitFor(() => proxy.voice.count() === 1, "voice begin #2");
  client2.terminate();
  await once(client2, "close");
  await waitFor(() => proxy.voice.count() === 0, "voice end #2");
  assert.equal(proxy.voice.count(), 0);
} finally {
  await proxy.close();
  await new Promise<void>((resolve, reject) => {
    upstreamWss.close();
    upstreamServer.close((error) => (error ? reject(error) : resolve()));
  });
}

console.log(
  "[access-upgrade] PRODUCTION_HANDLER_OK deny/allow, upstream inject, voiceSessions ok",
);
