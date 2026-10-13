import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { companionThoughts } from "../db/schema";
import { contentKey } from "../memory/openMemory";

/**
 * 她自己的念头。和档案、片段、判断、笔记分开存。
 * 只负责写入和读出，不进对话。
 *
 * unresolved：还放不下的事
 * view：对某句话的看法。about 是那句话，content 是看法
 * question：想晚一点再问的问题
 */
export const THOUGHT_KINDS = ["unresolved", "view", "question"] as const;

export type ThoughtKind = (typeof THOUGHT_KINDS)[number];

export type CompanionThought = {
  id: string;
  kind: ThoughtKind;
  content: string;
  about: string;
  createdAt: string;
  updatedAt: string;
};

const MAX_CONTENT_LENGTH = 500;
const MAX_ABOUT_LENGTH = 300;

export function isThoughtKind(value: string): value is ThoughtKind {
  return (THOUGHT_KINDS as readonly string[]).includes(value);
}

export class ThoughtStore {
  save(input: {
    kind: ThoughtKind;
    content: string;
    about?: string;
  }): CompanionThought {
    const content = input.content.trim();
    const about = (input.about ?? "").trim();

    if (!content) {
      throw new Error("Thought content cannot be empty");
    }

    if (content.length > MAX_CONTENT_LENGTH) {
      throw new Error(
        `Thought content is too long (max ${MAX_CONTENT_LENGTH} characters)`,
      );
    }

    if (input.kind === "view") {
      if (!about) {
        throw new Error("A view needs the sentence it is about");
      }
    } else if (about) {
      throw new Error("Only a view can keep the sentence it is about");
    }

    if (about.length > MAX_ABOUT_LENGTH) {
      throw new Error(
        `Thought about is too long (max ${MAX_ABOUT_LENGTH} characters)`,
      );
    }

    const existing = this.list(input.kind).find(
      (thought) =>
        contentKey(thought.content) === contentKey(content) &&
        contentKey(thought.about) === contentKey(about),
    );

    if (existing) return existing;

    const now = new Date().toISOString();
    const thought: CompanionThought = {
      id: crypto.randomUUID(),
      kind: input.kind,
      content,
      about,
      createdAt: now,
      updatedAt: now,
    };

    db.insert(companionThoughts)
      .values({
        id: thought.id,
        kind: thought.kind,
        content: thought.content,
        about: thought.about,
        createdAt: thought.createdAt,
        updatedAt: thought.updatedAt,
      })
      .run();

    return thought;
  }

  list(kind?: ThoughtKind): CompanionThought[] {
    const rows = kind
      ? db
          .select()
          .from(companionThoughts)
          .where(eq(companionThoughts.kind, kind))
          .orderBy(desc(companionThoughts.createdAt))
          .all()
      : db
          .select()
          .from(companionThoughts)
          .orderBy(desc(companionThoughts.createdAt))
          .all();

    return rows.flatMap((row) => {
      const thought = toThought(row);
      return thought ? [thought] : [];
    });
  }

  get(id: string): CompanionThought | null {
    const row = db
      .select()
      .from(companionThoughts)
      .where(eq(companionThoughts.id, id))
      .get();

    return row ? toThought(row) : null;
  }
}

export const thoughtStore = new ThoughtStore();

function toThought(row: {
  id: string;
  kind: string;
  content: string;
  about: string;
  createdAt: string;
  updatedAt: string;
}): CompanionThought | null {
  if (!isThoughtKind(row.kind)) return null;

  return {
    id: row.id,
    kind: row.kind,
    content: row.content,
    about: row.about,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
