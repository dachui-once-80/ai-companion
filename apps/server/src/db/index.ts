import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema";

const file = process.env.COMPANION_DB?.trim() || "companion.db";
const sqlite = new Database(file);

export const db = drizzle(sqlite, {
  schema,
});