/**
 * P1-C 端口与 origin 规则。
 * 不读取正式 Vite 配置，不连接任何服务。
 */

import net from "node:net";

export const P1C_RESERVED_PORTS = [3000, 5173] as const;

export const P1C_PROTECTED_PIDS = [56873, 56890] as const;

const ALLOWED_CHILD_ENV = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "P1C_API_ORIGIN",
  "P1C_VITE_PORT",
]);

export function isValidTcpPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function isReservedPort(port: number): boolean {
  return port === 3000 || port === 5173;
}

/** 监听前拒绝 0、保留端口和非法端口。0 会让 Vite 8 自行探测并绑定。 */
export function assertExplicitListenPort(port: number): void {
  if (!isValidTcpPort(port) || isReservedPort(port)) {
    throw new Error(`P1-C refuses listen port ${port} before bind`);
  }
}

/** 配置解析阶段调用。端口必须是已经核对过的显式端口。 */
export function assertViteConfiguredPort(port: number | undefined): void {
  if (port === undefined || !isValidTcpPort(port) || isReservedPort(port)) {
    throw new Error(
      `P1-C refuses Vite listen port ${String(port)} before bind`,
    );
  }
}

export function readP1cVitePort(env: NodeJS.ProcessEnv): number {
  const raw = env.P1C_VITE_PORT;

  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new Error("P1C_VITE_PORT is required before Vite listens");
  }

  const port = Number(raw);

  assertExplicitListenPort(port);

  return port;
}

/** 实际 bind 之后的端口。0、3000、5173 都失败。 */
export function assertBoundPort(port: number, label: string): void {
  if (!isValidTcpPort(port) || isReservedPort(port)) {
    throw new Error(`P1-C refuses ${label} port ${port}`);
  }
}

export function assertNavigationPorts(apiPort: number, vitePort: number): void {
  assertBoundPort(apiPort, "api");
  assertBoundPort(vitePort, "vite");

  if (apiPort === vitePort) {
    throw new Error(`P1-C api and vite resolved the same port ${apiPort}`);
  }
}

export function readP1cApiOrigin(env: NodeJS.ProcessEnv): string {
  const raw = env.P1C_API_ORIGIN;

  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("P1C_API_ORIGIN is required");
  }

  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    throw new Error("P1C_API_ORIGIN is not an absolute URL");
  }

  if (url.protocol !== "http:") {
    throw new Error("P1C_API_ORIGIN must use http");
  }

  if (url.hostname !== "127.0.0.1") {
    throw new Error("P1C_API_ORIGIN host must be 127.0.0.1");
  }

  if (url.username !== "" || url.password !== "") {
    throw new Error("P1C_API_ORIGIN must not include credentials");
  }

  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("P1C_API_ORIGIN must not include a path");
  }

  if (url.search !== "" || url.hash !== "") {
    throw new Error("P1C_API_ORIGIN must not include a query or hash");
  }

  if (url.port === "") {
    throw new Error("P1C_API_ORIGIN must include an explicit port");
  }

  const port = Number(url.port);

  if (!isValidTcpPort(port) || isReservedPort(port)) {
    throw new Error(`P1C_API_ORIGIN port ${url.port} is not allowed`);
  }

  return `http://127.0.0.1:${port}`;
}

export function assertSignalAllowed(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 1) {
    throw new Error(`refusing to signal invalid pid ${pid}`);
  }

  if (pid === 56873 || pid === 56890) {
    throw new Error(`refusing to signal protected pid ${pid}`);
  }
}

export function buildP1cChildEnv(input: {
  source: NodeJS.ProcessEnv;
  apiOrigin?: string;
  vitePort?: number;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const key of ["PATH", "HOME", "TMPDIR"] as const) {
    const value = input.source[key];

    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }

  if (input.apiOrigin !== undefined) {
    env.P1C_API_ORIGIN = readP1cApiOrigin({
      P1C_API_ORIGIN: input.apiOrigin,
    });
  }

  if (input.vitePort !== undefined) {
    assertExplicitListenPort(input.vitePort);
    env.P1C_VITE_PORT = String(input.vitePort);
  }

  for (const key of Object.keys(env)) {
    if (!ALLOWED_CHILD_ENV.has(key)) {
      throw new Error(`P1-C child env refused key ${key}`);
    }
  }

  return env;
}

export function parseViteLocalPort(text: string): number | null {
  const match = text.match(/http:\/\/127\.0\.0\.1:(\d+)\//);

  if (!match?.[1]) return null;

  const port = Number(match[1]);

  if (!isValidTcpPort(port) || isReservedPort(port)) return null;

  return port;
}

export function buildP1cViteCliArgs(port: number): string[] {
  assertExplicitListenPort(port);

  return [
    "--config",
    "vite.p1c.config.ts",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ];
}

function probeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;

      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

/**
 * 在启动 Vite 或 mock 之前占用并关闭一个 loopback 端口。
 * 保留端口会被丢弃；连续失败则拒绝启动，不改绑固定端口。
 */
export async function reserveLoopbackPort(): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await probeLoopbackPort();

    if (isValidTcpPort(port) && !isReservedPort(port)) return port;
  }

  throw new Error("P1-C could not reserve a non-reserved loopback port");
}
