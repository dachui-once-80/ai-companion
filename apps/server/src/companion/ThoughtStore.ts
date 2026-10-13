import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { companionThoughts } from "../db/schema";
import { contentKey } from "../memory/openMemory";

/**
 * 她自己的念头。和档案、片段、判断、笔记分开存。
 *
 * unresolved：还放不下的事
 * view：对一件具体的事的看法。about 是那件事，content 是她的偏好或不同意见。
 *       同一件事再写，改原来那一条。不写人设，也不记下换人设的要求。
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
const VIEW_CONTEXT_LIMIT = 30;

const PERSONA_SUBJECTS = new Set([
  "人设",
  "价值观",
  "说话习惯",
  "说话方式",
  "在意的事",
  "会坚持的看法",
  "扮演",
  "扮演别人",
]);

export function isThoughtKind(value: string): value is ThoughtKind {
  return (THOUGHT_KINDS as readonly string[]).includes(value);
}

/** 同一件事用这个对齐，标点和空白不算差别。 */
export function subjectKey(about: string): string {
  const key = about
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^\u4e00-\u9fffa-z0-9]/g, "");

  return key || contentKey(about);
}

/**
 * 看法不能改写她是谁，也不能把「换人设、换性格、扮演别人」记成她的看法。
 * 对具体事情的偏好和不同意见留得下。
 */
export function isPersonaRewrite(about: string, content: string): boolean {
  if (PERSONA_SUBJECTS.has(subjectKey(about))) return true;

  const text = `${about}${content}`.replace(/\s+/g, "");

  return /换人设|换个人设|换性格|换一种性格|换个性|换说话方式|换说话习惯|扮演别人|扮演另一个人|变成另一个人/.test(
    text,
  );
}

export type ThoughtSaveResult = {
  thought: CompanionThought;
  action: "created" | "updated" | "unchanged";
};

export class ThoughtStore {
  save(input: {
    kind: ThoughtKind;
    content: string;
    about?: string;
  }): ThoughtSaveResult {
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
        throw new Error("A view needs the matter it is about");
      }

      if (isPersonaRewrite(about, content)) {
        throw new Error("A view cannot change who she is");
      }
    } else if (about) {
      throw new Error("Only a view can keep what it is about");
    }

    if (about.length > MAX_ABOUT_LENGTH) {
      throw new Error(
        `Thought about is too long (max ${MAX_ABOUT_LENGTH} characters)`,
      );
    }

    if (input.kind === "view") {
      return this.saveView(content, about);
    }

    const existing = this.list(input.kind).find(
      (thought) =>
        contentKey(thought.content) === contentKey(content) &&
        contentKey(thought.about) === contentKey(about),
    );

    if (existing) return { thought: existing, action: "unchanged" };

    return {
      thought: this.insert(input.kind, content, about),
      action: "created",
    };
  }

  /** 整理时对照已有看法，沿用原来的 about。 */
  describeViews(): string {
    const views = this.list("view")
      .slice()
      .sort(
        (a, b) =>
          b.updatedAt.localeCompare(a.updatedAt) ||
          a.createdAt.localeCompare(b.createdAt),
      )
      .slice(0, 40);

    return this.formatViews(views, "还没有。");
  }

  /** 下次对话里用。相关话题出现时拿对应的一条接话。 */
  renderForConversation(): string {
    const views = this.list("view")
      .slice()
      .sort(
        (a, b) =>
          b.updatedAt.localeCompare(a.updatedAt) ||
          b.createdAt.localeCompare(a.createdAt),
      )
      .slice(0, VIEW_CONTEXT_LIMIT);

    return this.formatViews(views, "还没有。");
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

  private saveView(content: string, about: string): ThoughtSaveResult {
    const key = subjectKey(about);
    const matches = this.list("view").filter(
      (thought) => subjectKey(thought.about) === key,
    );

    if (matches.length === 0) {
      return { thought: this.insert("view", content, about), action: "created" };
    }

    const original = this.viewsByAge(matches)[0];

    for (const extra of matches) {
      if (extra.id !== original.id) this.remove(extra.id);
    }

    if (contentKey(original.content) === contentKey(content)) {
      return { thought: this.get(original.id) ?? original, action: "unchanged" };
    }

    const now = new Date().toISOString();

    db.update(companionThoughts)
      .set({ content, updatedAt: now })
      .where(eq(companionThoughts.id, original.id))
      .run();

    const updated = this.get(original.id);

    if (!updated) {
      throw new Error("Thought disappeared during update");
    }

    return { thought: updated, action: "updated" };
  }

  private insert(
    kind: ThoughtKind,
    content: string,
    about: string,
  ): CompanionThought {
    const now = new Date().toISOString();
    const thought: CompanionThought = {
      id: crypto.randomUUID(),
      kind,
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

  private remove(id: string): void {
    db.delete(companionThoughts).where(eq(companionThoughts.id, id)).run();
  }

  private viewsByAge(views = this.list("view")): CompanionThought[] {
    return views
      .slice()
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id),
      );
  }

  private formatViews(views: CompanionThought[], empty: string): string {
    if (views.length === 0) return empty;

    return views
      .map((view) => `- ${view.about}：${view.content}`)
      .join("\n");
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
