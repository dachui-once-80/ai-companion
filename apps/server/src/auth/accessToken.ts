import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { NextFunction, Request, Response } from "express";

/** Shared env name for server and Vite Node proxy. Never expose via VITE_*. */
export const COMPANION_ACCESS_TOKEN_ENV = "COMPANION_ACCESS_TOKEN";

/** Minimum UTF-8 length; prefer `openssl rand -hex 32` (64 hex chars). */
export const MIN_COMPANION_ACCESS_TOKEN_LENGTH = 32;

export const UNAUTHORIZED_BODY = { error: "Unauthorized" } as const;

const UNAUTHORIZED_PLAIN = "Unauthorized";

export function readCompanionAccessTokenFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env[COMPANION_ACCESS_TOKEN_ENV];
  if (typeof raw !== "string") {
    throw new Error(`${COMPANION_ACCESS_TOKEN_ENV} is not configured`);
  }

  const token = raw.trim();
  if (!token) {
    throw new Error(`${COMPANION_ACCESS_TOKEN_ENV} is not configured`);
  }

  if (token.length < MIN_COMPANION_ACCESS_TOKEN_LENGTH) {
    throw new Error(
      `${COMPANION_ACCESS_TOKEN_ENV} must be at least ${MIN_COMPANION_ACCESS_TOKEN_LENGTH} characters`,
    );
  }

  return token;
}

export function extractBearerToken(
  authorizationHeader: string | string[] | undefined,
): string | null {
  if (typeof authorizationHeader !== "string") {
    return null;
  }

  const trimmed = authorizationHeader.trim();
  const match = /^Bearer\s+(\S+)$/i.exec(trimmed);
  if (!match) {
    return null;
  }

  return match[1] ?? null;
}

export function tokensEqual(expected: string, provided: string): boolean {
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(provided, "utf8");

  if (expectedBuf.length !== providedBuf.length) {
    timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }

  return timingSafeEqual(expectedBuf, providedBuf);
}

export function isAuthorizedBearer(
  authorizationHeader: string | string[] | undefined,
  expectedToken: string,
): boolean {
  const provided = extractBearerToken(authorizationHeader);
  if (provided === null) {
    return false;
  }

  return tokensEqual(expectedToken, provided);
}

export function createCompanionAccessMiddleware(expectedToken: string) {
  return function companionAccessMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    if (req.method === "OPTIONS") {
      next();
      return;
    }

    if (req.method === "GET" && req.path === "/health") {
      next();
      return;
    }

    if (!isAuthorizedBearer(req.headers.authorization, expectedToken)) {
      res.status(401).json(UNAUTHORIZED_BODY);
      return;
    }

    next();
  };
}

export function authorizeLiveProxyUpgrade(
  request: IncomingMessage,
  expectedToken: string,
): boolean {
  return isAuthorizedBearer(request.headers.authorization, expectedToken);
}

/** Refuse Upgrade before handleUpgrade / upstream / voice counting. */
export function rejectUnauthorizedUpgrade(socket: Duplex): void {
  if (!socket.destroyed) {
    socket.write(
      "HTTP/1.1 401 Unauthorized\r\n" +
        "Connection: close\r\n" +
        "Content-Type: text/plain; charset=utf-8\r\n" +
        `Content-Length: ${Buffer.byteLength(UNAUTHORIZED_PLAIN)}\r\n` +
        "\r\n" +
        UNAUTHORIZED_PLAIN,
    );
  }
  socket.destroy();
}
