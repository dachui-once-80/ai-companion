import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { resolve } from "node:path";

import { offlineDatabaseRefusal } from "./offlineGuard";
import * as schema from "./schema";

/** 实际打开的 SQLite 路径；离线测试用它核对是否落到临时库。 */
export const dbFile = process.env.COMPANION_DB?.trim() || "companion.db";

const refusal = offlineDatabaseRefusal(dbFile);

if (refusal) {
  throw new Error(refusal);
}

if (process.env.COMPANION_OFFLINE_TEST === "1") {
  console.log("[offline-db] open", resolve(dbFile));
}

const sqlite = new Database(dbFile);

export const db = drizzle(sqlite, {
  schema,
});
