import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import express from "express";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPANION_ACCESS_TOKEN_ENV,
  MIN_COMPANION_ACCESS_TOKEN_LENGTH,
  UNAUTHORIZED_BODY,
  createCompanionAccessMiddleware,
  extractBearerToken,
  isAuthorizedBearer,
  readCompanionAccessTokenFromEnv,
  tokensEqual,
} from "../auth/accessToken.ts";

/** Synthetic test token only — not a user secret. */
const SYNTHETIC_TOKEN = "s1b-test-companion-access-token-0001";
assert.ok(SYNTHETIC_TOKEN.length >= MIN_COMPANION_ACCESS_TOKEN_LENGTH);

// --- env fail-closed ---
{
  assert.throws(
    () => readCompanionAccessTokenFromEnv({}),
    /is not configured/,
  );
  assert.throws(
    () =>
      readCompanionAccessTokenFromEnv({
        [COMPANION_ACCESS_TOKEN_ENV]: "   ",
      }),
    /is not configured/,
  );
  assert.throws(
    () =>
      readCompanionAccessTokenFromEnv({
        [COMPANION_ACCESS_TOKEN_ENV]: "too-short",
      }),
    /at least/,
  );
  assert.equal(
    readCompanionAccessTokenFromEnv({
      [COMPANION_ACCESS_TOKEN_ENV]: `  ${SYNTHETIC_TOKEN}  `,
    }),
    SYNTHETIC_TOKEN,
  );
}

// --- bearer parse + compare ---
{
  assert.equal(extractBearerToken(undefined), null);
  assert.equal(extractBearerToken(["Bearer a"]), null);
  assert.equal(extractBearerToken("Basic abc"), null);
  assert.equal(extractBearerToken("Bearer"), null);
  assert.equal(extractBearerToken(`Bearer ${SYNTHETIC_TOKEN}`), SYNTHETIC_TOKEN);

  assert.equal(tokensEqual(SYNTHETIC_TOKEN, SYNTHETIC_TOKEN), true);
  assert.equal(tokensEqual(SYNTHETIC_TOKEN, `${SYNTHETIC_TOKEN}x`), false);
  assert.equal(tokensEqual(SYNTHETIC_TOKEN, "s1b-test-companion-access-token-0002"), false);

  assert.equal(
    isAuthorizedBearer(`Bearer ${SYNTHETIC_TOKEN}`, SYNTHETIC_TOKEN),
    true,
  );
  assert.equal(isAuthorizedBearer(undefined, SYNTHETIC_TOKEN), false);
  assert.equal(
    isAuthorizedBearer("Bearer wrong-token-value-not-matching-000", SYNTHETIC_TOKEN),
    false,
  );
}

async function withApp(
  run: (base: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(createCompanionAccessMiddleware(SYNTHETIC_TOKEN));
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/api/probe", (_req, res) => {
    res.json({ ok: true, probe: true });
  });
  app.post("/api/probe", (_req, res) => {
    res.status(201).json({ ok: true });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const base = `http://127.0.0.1:${addr.port}`;

  try {
    await run(base);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

await withApp(async (base) => {
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const missing = await fetch(`${base}/api/probe`);
  assert.equal(missing.status, 401);
  const missingBody = await missing.json();
  assert.deepEqual(missingBody, UNAUTHORIZED_BODY);
  assert.equal(JSON.stringify(missingBody).includes(SYNTHETIC_TOKEN), false);

  const wrong = await fetch(`${base}/api/probe`, {
    headers: { Authorization: "Bearer s1b-test-companion-access-token-BAD!" },
  });
  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json(), UNAUTHORIZED_BODY);

  const ok = await fetch(`${base}/api/probe`, {
    headers: { Authorization: `Bearer ${SYNTHETIC_TOKEN}` },
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, probe: true });

  const postOk = await fetch(`${base}/api/probe`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SYNTHETIC_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(postOk.status, 201);

  const options = await fetch(`${base}/api/probe`, { method: "OPTIONS" });
  // Without cors package this may be 404 from Express; middleware must not 401.
  assert.notEqual(options.status, 401);
});

// Fail-closed in a child process with synthetic env (does not read .env files).
{
  const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const env = { ...process.env };
  delete env[COMPANION_ACCESS_TOKEN_ENV];
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "tsx",
      "--eval",
      `
import { readCompanionAccessTokenFromEnv } from "./src/auth/accessToken.ts";
try {
  readCompanionAccessTokenFromEnv();
  console.error("EXPECTED_FAIL");
  process.exit(2);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes(${JSON.stringify(COMPANION_ACCESS_TOKEN_ENV)})) {
    console.error(message);
    process.exit(3);
  }
  console.log("SERVER_TOKEN_FAIL_CLOSED_OK");
}
`,
    ],
    { cwd: serverRoot, env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /SERVER_TOKEN_FAIL_CLOSED_OK/);
  assert.equal(
    (result.stdout + result.stderr).includes(SYNTHETIC_TOKEN),
    false,
  );
}

console.log("[access-token] env, compare, middleware, fail-closed ok");
