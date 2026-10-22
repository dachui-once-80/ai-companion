/**
 * P1-C 纯函数与静态边界。不监听端口，不启动 Vite，不打开浏览器。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCompanionAffect } from "../src/realtime/RealtimeClient.ts";
import {
  CONSOLIDATION_SAVED_KEYS,
  isConsolidationSuccessBody,
} from "../src/realtime/consolidateResult.ts";
import { defaultDrainBackoffMs } from "../src/realtime/consolidationDrain.ts";
import {
  planP1cBatchCleanup,
  seedP1cBatch,
} from "../e2e/helpers/p1cBatch.ts";
import {
  P1C_AFFECT_BODY,
  P1C_ASIDE_BODY,
  P1C_IDENTITY_BODY,
  P1C_REMINDERS_BODY,
  decideP1cRequest,
  p1cConsolidationSuccessBody,
  summarizeP1cTurns,
} from "../e2e/helpers/p1cMockApi.ts";
import {
  assertBoundPort,
  assertSignalAllowed,
  assertViteConfiguredPort,
  buildP1cChildEnv,
  buildP1cViteCliArgs,
  parseViteLocalPort,
  readP1cApiOrigin,
} from "../e2e/helpers/p1cApiOrigin.ts";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readText(relative: string): string {
  return readFileSync(path.join(webRoot, relative), "utf8");
}

const receivedAt = "2026-10-21T06:40:00.000Z";

const success = p1cConsolidationSuccessBody();

assert.equal(isConsolidationSuccessBody(success), true);
assert.deepEqual(Object.keys(success.saved), [...CONSOLIDATION_SAVED_KEYS]);

for (const key of CONSOLIDATION_SAVED_KEYS) {
  assert.equal(success.saved[key], 0);
}

assert.equal(typeof P1C_IDENTITY_BODY.currentName, "string");
assert.ok(P1C_IDENTITY_BODY.currentName.length > 0);
assert.ok(parseCompanionAffect(P1C_AFFECT_BODY));
assert.equal(P1C_REMINDERS_BODY.success, true);
assert.deepEqual([...P1C_REMINDERS_BODY.reminders], []);
assert.deepEqual(P1C_ASIDE_BODY, {});
assert.equal(defaultDrainBackoffMs(1), 60_000);

const consolidate = decideP1cRequest({
  method: "POST",
  url: "http://127.0.0.1:43123/api/memory/consolidate",
  body: JSON.stringify({
    batchId: "p1c-ok-stamp-0001",
    payloadHash: "ab".repeat(32),
    occurredOn: "2026-10-21",
    turns: [],
  }),
  mode: "success",
  enteredAt: receivedAt,
  receivedAt,
});

assert.equal(consolidate.kind, "json");

if (consolidate.kind === "json") {
  assert.equal(consolidate.status, 200);
  assert.equal(isConsolidationSuccessBody(consolidate.body), true);
  assert.equal(consolidate.unexpected, null);
  assert.equal(consolidate.consolidate?.outcome, "responded");
  assert.equal(consolidate.consolidate?.responseStatus, 200);
  assert.equal(consolidate.consolidate?.batchId, "p1c-ok-stamp-0001");
  assert.equal(consolidate.consolidate?.payloadHash, "ab".repeat(32));
  assert.equal(consolidate.consolidate?.occurredOn, "2026-10-21");
  assert.deepEqual(consolidate.consolidate?.turns, summarizeP1cTurns([]));
  assert.equal(consolidate.consolidate?.closedAt, null);
}

const disconnected = decideP1cRequest({
  method: "POST",
  url: "http://127.0.0.1:43123/api/memory/consolidate",
  body: JSON.stringify({
    batchId: "p1c-net-stamp-0001",
    payloadHash: "cd".repeat(32),
  }),
  mode: "disconnect",
  enteredAt: receivedAt,
  receivedAt,
});

assert.equal(disconnected.kind, "disconnect");

if (disconnected.kind === "disconnect") {
  assert.equal(disconnected.consolidate.outcome, "disconnected");
  assert.equal(disconnected.consolidate.responseStatus, null);
  assert.equal(disconnected.consolidate.batchId, "p1c-net-stamp-0001");
}

for (const sample of [
  { method: "GET", url: "http://127.0.0.1:9/api/companion/identity" },
  { method: "POST", url: "http://127.0.0.1:9/api/affect/settle" },
  { method: "GET", url: "http://127.0.0.1:9/api/tasks/reminders?voice=0" },
  { method: "GET", url: "http://127.0.0.1:9/api/companion/aside" },
]) {
  const decision = decideP1cRequest({
    ...sample,
    body: "",
    mode: "success",
    enteredAt: receivedAt,
    receivedAt,
  });

  assert.equal(decision.kind, "json");

  if (decision.kind === "json") {
    assert.equal(decision.status, 200);
    assert.equal(decision.unexpected, null);
  }
}

for (const sample of [
  { method: "POST", url: "http://127.0.0.1:9/api/companion/identity" },
  { method: "GET", url: "http://127.0.0.1:9/api/gemini/token" },
  { method: "GET", url: "http://127.0.0.1:9/api/gemini/live-proxy" },
  { method: "POST", url: "http://127.0.0.1:9/api/tasks/reminders/settle" },
  { method: "GET", url: "http://127.0.0.1:9/api/memory" },
]) {
  const decision = decideP1cRequest({
    ...sample,
    body: "",
    mode: "success",
    enteredAt: receivedAt,
    receivedAt,
  });

  assert.equal(decision.kind, "json");

  if (decision.kind === "json") {
    assert.equal(decision.status, 404);
    assert.equal(decision.unexpected?.path.startsWith("/api/"), true);
  }
}

assert.throws(() => readP1cApiOrigin({}), /required/);
assert.throws(() => readP1cApiOrigin({ P1C_API_ORIGIN: "http://localhost:43123" }), /127\.0\.0\.1/);
assert.throws(() => readP1cApiOrigin({ P1C_API_ORIGIN: "http://127.0.0.1:3000" }), /not allowed/);
assert.throws(() => readP1cApiOrigin({ P1C_API_ORIGIN: "http://127.0.0.1:5173" }), /not allowed/);
assert.throws(() => readP1cApiOrigin({ P1C_API_ORIGIN: "https://127.0.0.1:43123" }), /http/);
assert.equal(
  readP1cApiOrigin({ P1C_API_ORIGIN: "http://127.0.0.1:43123" }),
  "http://127.0.0.1:43123",
);
assert.throws(() => assertBoundPort(3000, "api"), /refuses/);
assert.throws(() => assertBoundPort(5173, "vite"), /refuses/);
assert.throws(() => assertViteConfiguredPort(5173), /refuses/);
assert.throws(() => assertViteConfiguredPort(3000), /refuses/);
assert.throws(() => assertViteConfiguredPort(0), /refuses/);
assert.throws(() => assertViteConfiguredPort(undefined), /refuses/);
assert.doesNotThrow(() => assertViteConfiguredPort(43124));
assert.throws(() => assertSignalAllowed(56873), /protected/);
assert.throws(() => assertSignalAllowed(56890), /protected/);
assert.throws(() => assertSignalAllowed(1), /invalid/);
assert.doesNotThrow(() => assertSignalAllowed(99999));

const childEnv = buildP1cChildEnv({
  source: process.env,
  apiOrigin: "http://127.0.0.1:43123",
});

for (const key of Object.keys(childEnv)) {
  assert.ok(
    ["PATH", "HOME", "TMPDIR", "P1C_API_ORIGIN", "P1C_VITE_PORT"].includes(key),
    key,
  );
}

assert.equal("GEMINI_API_KEY" in childEnv, false);
assert.equal("COMPANION_ACCESS_TOKEN" in childEnv, false);
assert.equal(childEnv.P1C_API_ORIGIN, "http://127.0.0.1:43123");
assert.deepEqual(buildP1cViteCliArgs(43124), [
  "--config",
  "vite.p1c.config.ts",
  "--host",
  "127.0.0.1",
  "--port",
  "43124",
  "--strictPort",
]);
assert.throws(() => buildP1cViteCliArgs(0), /refuses/);
assert.throws(() => buildP1cViteCliArgs(3000), /refuses/);
assert.throws(() => buildP1cViteCliArgs(5173), /refuses/);
assert.equal(parseViteLocalPort("Local: http://127.0.0.1:43124/"), 43124);
assert.equal(parseViteLocalPort("Local: http://localhost:5173/"), null);
assert.equal(parseViteLocalPort("Local: http://127.0.0.1:5173/"), null);
assert.equal(parseViteLocalPort("Local: http://127.0.0.1:3000/"), null);

const seeded = await seedP1cBatch({
  kind: "net",
  stamp: "static",
  nowIso: "2026-10-21T06:00:00.000Z",
});
const cleanup = planP1cBatchCleanup(
  seeded.raw,
  seeded.batchId,
  "2026-10-21T06:00:00.000Z",
);

assert.equal(cleanup.action, "remove-key");
assert.throws(
  () => planP1cBatchCleanup(seeded.raw, "other-batch", "2026-10-21T06:00:00.000Z"),
  /outside this run/,
);

const files = [
  "vite.p1c.config.ts",
  "e2e/helpers/p1cApiOrigin.ts",
  "e2e/helpers/p1cMockApi.ts",
  "e2e/helpers/p1cMockServe.ts",
  "e2e/helpers/p1cBatch.ts",
  "e2e/helpers/p1cLaunch.ts",
  "e2e/helpers/p1cOwnedProcess.mjs",
  "e2e/consolidation-startup-drain.p1c.spec.ts",
];

for (const relative of files) {
  const text = readText(relative);

  assert.equal(text.includes("127.0.0.1:3000"), false, relative);
  assert.equal(text.includes("localhost:5173"), false, relative);
  assert.equal(text.includes("...process.env"), false, relative);
  assert.equal(text.includes("pkill"), false, relative);
  assert.equal(text.includes("vite.config.ts"), false, relative);
  assert.equal(text.includes("companion.db"), false, relative);
  assert.equal(text.includes("server/src/index"), false, relative);
  assert.equal(text.includes("server/src/db"), false, relative);
  assert.equal(text.includes("localStorage.clear"), false, relative);
}

const spec = readText("e2e/consolidation-startup-drain.p1c.spec.ts");

assert.equal(spec.includes("page.goto"), false);
assert.equal(spec.includes(".reload("), false);
assert.equal(spec.includes("gotoP1cApp") || spec.includes("gotoApp"), true);

const config = readText("vite.p1c.config.ts");

assert.equal(config.includes('ws: false'), true);
assert.equal(config.includes("hmr: true"), true);
assert.equal(config.includes("strictPort: true"), true);
assert.equal(config.includes("readP1cApiOrigin"), true);
assert.equal(config.includes("readP1cVitePort"), true);

console.log("[p1c-origin] ok");
console.log("[p1c-origin] network backoff ms", defaultDrainBackoffMs(1));
console.log("[p1c-origin] nextAttemptAt runtime value not observed; browser test was not executed");
