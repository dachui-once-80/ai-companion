import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import {
  WebSocket,
  type ClientOptions,
  type WebSocketServer,
} from "ws";
import {
  authorizeLiveProxyUpgrade,
  rejectUnauthorizedUpgrade,
} from "../auth/accessToken";
import {
  bindLiveProxyPair,
  closeSocketQuietly,
  type LiveProxySocket,
  type VoiceSessionCounter,
} from "./liveProxyBridge";

/** 浏览器经此前缀转发 Live WebSocket，由服务端走代理连 Gemini */
export const LIVE_PROXY_PREFIX = "/api/gemini/live-proxy";
export const GEMINI_WS_ORIGIN = "wss://generativelanguage.googleapis.com";

export type OpenUpstream = (upstreamUrl: string) => LiveProxySocket;

export type AttachLiveProxyUpgradeOptions = {
  server: HttpServer;
  wss: WebSocketServer;
  accessToken: string;
  voice: VoiceSessionCounter;
  liveProxyPrefix?: string;
  geminiWsOrigin?: string;
  /** Passed to default `WebSocket` constructor when `openUpstream` is omitted. */
  agent?: ClientOptions["agent"];
  /**
   * Create the upstream socket after auth + handleUpgrade.
   * Default opens a real WebSocket to `geminiWsOrigin + path` (production).
   * Tests inject a mock / local echo here — never call real Gemini in checks.
   */
  openUpstream?: OpenUpstream;
  onUpstreamOpen?: () => void;
  onClosed?: (reason: string) => void;
};

/**
 * Attach the production Live proxy Upgrade handler.
 * Auth runs before handleUpgrade and before any upstream socket is created.
 */
export function attachLiveProxyUpgrade(
  options: AttachLiveProxyUpgradeOptions,
): void {
  const prefix = options.liveProxyPrefix ?? LIVE_PROXY_PREFIX;
  const origin = options.geminiWsOrigin ?? GEMINI_WS_ORIGIN;
  const openUpstream: OpenUpstream =
    options.openUpstream ??
    ((upstreamUrl) =>
      new WebSocket(upstreamUrl, {
        agent: options.agent,
      }) as unknown as LiveProxySocket);

  options.server.on(
    "upgrade",
    (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const requestUrl = request.url ?? "";

      if (!requestUrl.startsWith(`${prefix}/`)) {
        socket.destroy();
        return;
      }

      if (!authorizeLiveProxyUpgrade(request, options.accessToken)) {
        rejectUnauthorizedUpgrade(socket);
        return;
      }

      const upstreamPath = requestUrl.slice(prefix.length);
      const upstreamUrl = `${origin}${upstreamPath}`;

      options.wss.handleUpgrade(request, socket, head, (client) => {
        const upstream = openUpstream(upstreamUrl);

        bindLiveProxyPair({
          client,
          upstream,
          voice: options.voice,
          closeQuietly: closeSocketQuietly,
          onUpstreamOpen: options.onUpstreamOpen,
          onClosed: options.onClosed,
        });
      });
    },
  );
}
