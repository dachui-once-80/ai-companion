/**
 * Node-only Companion access helpers for Vite's HTTP/WS proxy.
 * Must never be imported from browser app code.
 */

export const COMPANION_ACCESS_TOKEN_ENV = "COMPANION_ACCESS_TOKEN";
export const MIN_COMPANION_ACCESS_TOKEN_LENGTH = 32;

export type HeaderWritable = {
  setHeader(name: string, value: string): void;
};

export type CompanionProxyEmitter = {
  on(
    event: "proxyReq",
    listener: (proxyReq: HeaderWritable, ...rest: unknown[]) => void,
  ): unknown;
  on(
    event: "proxyReqWs",
    listener: (proxyReq: HeaderWritable, ...rest: unknown[]) => void,
  ): unknown;
};

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

export function companionBearerHeader(token: string): string {
  return `Bearer ${token}`;
}

/** Always overwrite Authorization so a client cannot substitute another value. */
export function injectCompanionAuthorization(
  proxyReq: HeaderWritable,
  token: string,
): void {
  proxyReq.setHeader("Authorization", companionBearerHeader(token));
}

export function applyCompanionProxyAuthorization(
  proxy: CompanionProxyEmitter,
  token: string,
): void {
  const inject = (proxyReq: HeaderWritable) => {
    injectCompanionAuthorization(proxyReq, token);
  };

  proxy.on("proxyReq", (proxyReq) => {
    inject(proxyReq);
  });
  proxy.on("proxyReqWs", (proxyReq) => {
    inject(proxyReq);
  });
}
