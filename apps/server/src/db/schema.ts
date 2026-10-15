import {
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const memories = sqliteTable("memories", {
  id: text("id").primaryKey(),
  category: text("category").notNull(),
  key: text("key")
    .notNull()
    .default("unknown"),
  content: text("content").notNull(),
  importance: text("importance").notNull(),
  status: text("status")
    .notNull()
    .default("current"),
  source: text("source")
    .notNull()
    .default("user"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const companionAffect = sqliteTable("companion_affect", {
  id: text("id").primaryKey(),
  valence: real("valence").notNull(),
  arousal: real("arousal").notNull(),
  warmth: real("warmth").notNull(),
  curiosity: real("curiosity").notNull(),
  cause: text("cause").notNull().default(""),
  expression: text("expression").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
  firstSeenAt: text("first_seen_at").notNull().default(""),
});

export const companionProfile = sqliteTable("companion_profile", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  previousNames: text("previous_names").notNull().default("[]"),
  updatedAt: text("updated_at").notNull(),
});

export const companionThoughts = sqliteTable("companion_thoughts", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  content: text("content").notNull(),
  about: text("about").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const companionAsides = sqliteTable("companion_asides", {
  id: text("id").primaryKey(),
  body: text("body").notNull(),
  leftAt: text("left_at").notNull(),
  matterKey: text("matter_key").notNull(),
  matterRevision: text("matter_revision").notNull(),
  heard: text("heard").notNull().default("false"),
});

export const companionAsideSpoken = sqliteTable(
  "companion_aside_spoken",
  {
    matterKey: text("matter_key").notNull(),
    matterRevision: text("matter_revision").notNull(),
    spokenAt: text("spoken_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.matterKey, table.matterRevision] }),
  ],
);

export const companionVoice = sqliteTable("companion_voice", {
  id: text("id").primaryKey(),
  leftAt: text("left_at").notNull(),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  status: text("status").notNull().default("pending"),
  dueAt: text("due_at"),
  reminderAt: text("reminder_at"),
  reminderSent: text("reminder_sent")
    .notNull()
    .default("false"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});