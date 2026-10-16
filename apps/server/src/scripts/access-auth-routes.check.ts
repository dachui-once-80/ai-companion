import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import http from "node:http";
import {
  MIN_COMPANION_ACCESS_TOKEN_LENGTH,
  UNAUTHORIZED_BODY,
  createCompanionAccessMiddleware,
} from "../auth/accessToken.ts";

/** Synthetic test token only — not a user secret. */
const SYNTHETIC_TOKEN = "s1b-test-companion-access-token-0001";
assert.ok(SYNTHETIC_TOKEN.length >= MIN_COMPANION_ACCESS_TOKEN_LENGTH);

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const indexSource = readFileSync(join(root, "src/index.ts"), "utf8");
const identitySource = readFileSync(
  join(root, "src/companion/identityRoutes.ts"),
  "utf8",
);

type RouteSpec = { method: string; path: string };

function collectRoutes(source: string): RouteSpec[] {
  const routes: RouteSpec[] = [];
  const re =
    /\bapp\.(get|post|put|patch|delete)\(\s*[\n\r\s]*["']([^"']+)["']/g;
  for (const match of source.matchAll(re)) {
    routes.push({
      method: match[1]!.toUpperCase(),
      path: match[2]!,
    });
  }
  return routes;
}

const indexRoutes = collectRoutes(indexSource);
const identityRoutes = collectRoutes(identitySource);
const allRoutes = [...indexRoutes, ...identityRoutes];

const apiRoutes = allRoutes.filter((route) => route.path.startsWith("/api/"));
assert.ok(
  apiRoutes.length >= 30,
  `expected many /api routes, got ${apiRoutes.length}`,
);

const healthRoutes = allRoutes.filter((route) => route.path === "/health");
assert.equal(healthRoutes.length, 1);
assert.equal(healthRoutes[0]?.method, "GET");

assert.match(indexSource, /createCompanionAccessMiddleware/);
assert.match(indexSource, /attachLiveProxyUpgrade/);
assert.match(
  indexSource,
  /app\.use\(createCompanionAccessMiddleware\(companionAccessToken\)\)/,
);
assert.match(indexSource, /registerCompanionIdentityRoutes\(app, companion\)/);

const upgradeSource = readFileSync(
  join(root, "src/gemini/liveProxyUpgrade.ts"),
  "utf8",
);
assert.match(upgradeSource, /authorizeLiveProxyUpgrade/);
assert.match(upgradeSource, /rejectUnauthorizedUpgrade/);
assert.match(upgradeSource, /handleUpgrade/);
assert.match(
  upgradeSource,
  /authorizeLiveProxyUpgrade[\s\S]*?handleUpgrade/,
);

const middlewareIndex = indexSource.indexOf(
  "app.use(createCompanionAccessMiddleware(companionAccessToken))",
);
const routeRegistration = indexSource.match(
  /\bapp\.(get|post|put|patch|delete)\(\s*[\n\r\s]*["']\/api\//,
);
assert.ok(middlewareIndex > 0);
assert.ok(routeRegistration?.index != null);
assert.ok(
  routeRegistration.index > middlewareIndex,
  "middleware must precede Express /api route registrations",
);
const identityRegisterIndex = indexSource.indexOf(
  "registerCompanionIdentityRoutes(app, companion)",
);
assert.ok(
  identityRegisterIndex > middlewareIndex,
  "identity routes register after middleware (still covered by earlier app.use)",
);

function expandPath(path: string): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "test-$1");
}

const uniqueKeys = [
  ...new Set(apiRoutes.map((route) => `${route.method} ${route.path}`)),
];

const app = express();
app.use(
  cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
  }),
);
app.use(express.json());
app.use(createCompanionAccessMiddleware(SYNTHETIC_TOKEN));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "ai-companion-server" });
});

function mountRoute(
  method: string,
  path: string,
  handler: express.RequestHandler,
): void {
  switch (method) {
    case "GET":
      app.get(path, handler);
      return;
    case "POST":
      app.post(path, handler);
      return;
    case "PUT":
      app.put(path, handler);
      return;
    case "PATCH":
      app.patch(path, handler);
      return;
    case "DELETE":
      app.delete(path, handler);
      return;
    default:
      throw new Error(`unsupported method ${method}`);
  }
}

for (const key of uniqueKeys) {
  const [method, path] = key.split(" ");
  assert.ok(method && path);
  mountRoute(method, path, (_req, res) => {
    res.json({ ok: true, method, path });
  });
}

const server = http.createServer(app);
await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve());
});
const addr = server.address();
assert.ok(addr && typeof addr !== "string");
const base = `http://127.0.0.1:${addr.port}`;

try {
  const openHealth = await fetch(`${base}/health`);
  assert.equal(openHealth.status, 200);

  for (const origin of [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ]) {
    const preflight = await fetch(`${base}/api/gemini/token`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
      },
    });
    assert.notEqual(preflight.status, 401);
    assert.equal(
      preflight.headers.get("access-control-allow-origin"),
      origin,
    );
  }

  for (const key of uniqueKeys) {
    const [method, path] = key.split(" ");
    assert.ok(method && path);
    const url = `${base}${expandPath(path)}`;

    const denied = await fetch(url, { method });
    assert.equal(
      denied.status,
      401,
      `${key} without token should be 401, got ${denied.status}`,
    );
    const deniedBody = await denied.json();
    assert.deepEqual(deniedBody, UNAUTHORIZED_BODY);
    assert.equal(JSON.stringify(deniedBody).includes(SYNTHETIC_TOKEN), false);

    const allowed = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${SYNTHETIC_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: method === "GET" || method === "DELETE" ? undefined : "{}",
    });
    assert.notEqual(
      allowed.status,
      401,
      `${key} with token must not be 401 (got ${allowed.status})`,
    );
  }

  const requiredSamples = [
    "GET /api/gemini/health",
    "POST /api/gemini/token",
    "GET /api/weather",
    "GET /api/search",
    "GET /api/tasks",
    "POST /api/tasks",
    "PATCH /api/tasks/:id/complete",
    "DELETE /api/tasks/:id",
    "GET /api/tasks/reminders",
    "POST /api/tasks/reminders/settle",
    "GET /api/companion/identity",
    "POST /api/companion/rename",
    "GET /api/companion/thoughts",
    "GET /api/companion/aside",
    "POST /api/companion/session-view",
    "GET /api/memory",
    "POST /api/memory",
    "POST /api/memory/consolidate",
    "POST /api/memory/remember",
    "POST /api/memory/forget",
    "PATCH /api/memory/:id",
    "DELETE /api/memory/:id",
    "POST /api/affect/resume",
    "POST /api/affect/settle",
    "POST /api/affect/appraise",
  ];

  for (const sample of requiredSamples) {
    assert.ok(uniqueKeys.includes(sample), `missing required route ${sample}`);
  }
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

console.log(
  `[access-auth-routes] protected ${uniqueKeys.length} /api routes + health/OPTIONS ok`,
);
