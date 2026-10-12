import {
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

export const companionProfile = sqliteTable("companion_profile", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  previousNames: text("previous_names").notNull().default("[]"),
  personality: text("personality").notNull(),
  updatedAt: text("updated_at").notNull(),
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