import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import Database from "better-sqlite3";
import {
  assertOfflineDbIsolated,
  cleanupOfflineDb,
  prepareOfflineDb,
} from "./offlineDb.ts";

const file = prepareOfflineDb("rename-");

const setup = new Database(file);
setup.exec(`
  CREATE TABLE companion_profile (
    id text PRIMARY KEY NOT NULL,
    name text NOT NULL,
    previous_names text DEFAULT '[]' NOT NULL,
    updated_at text NOT NULL
  );
`);
setup.close();

await assertOfflineDbIsolated(file);
const { registerCompanionIdentityRoutes } = await import(
  "../companion/identityRoutes"
);
const { Companion } = await import("../companion/Companion");

const app = express();
app.use(express.json());
registerCompanionIdentityRoutes(app, new Companion());

const server = http.createServer(app);
await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve());
});

const address = server.address();

if (address === null || typeof address === "string") {
  throw new Error("rename test server did not bind a port");
}

const base = `http://127.0.0.1:${address.port}`;

function profileRow(): { name: string; previous_names: string } | undefined {
  const db = new Database(file, { readonly: true });

  try {
    return db
      .prepare(
        "SELECT name, previous_names FROM companion_profile WHERE id = 'main'",
      )
      .get() as { name: string; previous_names: string } | undefined;
  } finally {
    db.close();
  }
}

async function post(body: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${base}/api/companion/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(2000),
  });
  const text = await response.text();

  return {
    status: response.status,
    json: text ? (JSON.parse(text) as unknown) : null,
  };
}

const created = await post({ name: "小满" });
assert.equal(created.status, 200);
assert.equal(
  (created.json as { currentName?: unknown }).currentName,
  "小满",
);
assert.deepEqual(
  (created.json as { previousNames?: unknown }).previousNames,
  ["阿七"],
);
assert.equal(profileRow()?.name, "小满");
assert.equal(profileRow()?.previous_names, JSON.stringify(["阿七"]));

const empty = await post({ name: "" });
assert.equal(empty.status, 400);
assert.equal(
  (empty.json as { error?: unknown }).error,
  "Name cannot be empty",
);
assert.equal(profileRow()?.name, "小满");

const blank = await post({ name: "   " });
assert.equal(blank.status, 400);
assert.equal(
  (blank.json as { error?: unknown }).error,
  "Name cannot be empty",
);
assert.equal(profileRow()?.name, "小满");

const numberName = await post({ name: 12 });
assert.equal(numberName.status, 400);
assert.equal(
  (numberName.json as { error?: unknown }).error,
  "name must be a string",
);
assert.equal(profileRow()?.name, "小满");

const missing = await post({});
assert.equal(missing.status, 400);
assert.equal(
  (missing.json as { error?: unknown }).error,
  "name must be a string",
);
assert.equal(profileRow()?.name, "小满");

const tooLong = await post({ name: "名".repeat(31) });
assert.equal(tooLong.status, 400);
assert.equal(
  (tooLong.json as { error?: unknown }).error,
  "Name cannot exceed 30 characters",
);
assert.equal(profileRow()?.name, "小满");

const breaker = new Database(file);
breaker.exec("DROP TABLE companion_profile");
breaker.close();

const failed = await post({ name: "新名字" });
assert.equal(failed.status, 500);
assert.equal((failed.json as { error?: unknown }).error, "Failed to rename");

await new Promise<void>((resolve, reject) => {
  server.close((error) => (error ? reject(error) : resolve()));
});

cleanupOfflineDb(file);
console.log("[rename] valid, empty, invalid, and storage failure ok");
