import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { companionThoughts } from "../db/schema";
import { contentKey } from "../memory/openMemory";

/**
 * 她自己的念头。和档案、片段、判断、笔记分开存。
 *
 * unresolved：还放不下的事。about 是那件事，content 是还悬着的点。
 *       同一件事再出现并有了结果，就把这一条收掉。
 * view：对一件具体的事的看法。about 是那件事，content 是她的偏好或不同意见。
 *       同一件事再写，改原来那一条。不写人设，也不记下换人设的要求。
 * question：想晚一点再问的问题。about 是那件事，content 是问题。
 *       问过并得到回答，就把这一条收掉。
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
const OPEN_CONTEXT_LIMIT = 8;

const PERSONA_SUBJECTS = new Set([
  "人设",
  "价值观",
  "说话习惯",
  "说话方式",
  "在意的事",
  "会坚持的看法",
  "内心",
  "口味",
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

/**
 * 还放不下的事和想问的问题来自对话，不能写成她有身体、家人、恋人或自己的日常生活。
 */
export function inventsCompanionLife(about: string, content: string): boolean {
  const text = `${about}${content}`.replace(/\s+/g, "");

  return /我(的)?身体|我(男朋友|女朋友|老公|老婆)|我自己(的)?(爸|妈|家人|身体)|我(昨晚|今早|今天早上|刚才)(出门|去了|睡了|没睡|吃了|上班|下班|生病|感冒|发烧)|阿七(的)?(身体|家人|男朋友|女朋友|私人生活|房子|爸|妈)/.test(
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

    if (!about) {
      throw new Error(matterRequired(input.kind));
    }

    if (isPersonaRewrite(about, content)) {
      throw new Error(
        input.kind === "view"
          ? "A view cannot change who she is"
          : "A thought cannot change who she is",
      );
    }

    if (
      input.kind !== "view" &&
      inventsCompanionLife(about, content)
    ) {
      throw new Error("A thought cannot invent her body or private life");
    }

    if (about.length > MAX_ABOUT_LENGTH) {
      throw new Error(
        `Thought about is too long (max ${MAX_ABOUT_LENGTH} characters)`,
      );
    }

    return this.saveBySubject(input.kind, content, about);
  }

  /**
   * 同一件事有了结果，或那个问题问过并得到回答，就收掉。
   * 收掉的不再进入下次对话。
   */
  close(kind: "unresolved" | "question", about: string): number {
    const key = subjectKey(about);

    if (!key) return 0;

    const matches = this.list(kind).filter((thought) => {
      if (thought.about.trim()) {
        return subjectKey(thought.about) === key;
      }

      return (
        contentKey(thought.content) === contentKey(about) ||
        subjectKey(thought.content) === key
      );
    });

    for (const match of matches) this.remove(match.id);

    return matches.length;
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

    return this.formatLines(views, "还没有。");
  }

  /** 整理时对照还悬着的事或还想问的问题，沿用原来的 about。 */
  describeOpen(kind: "unresolved" | "question"): string {
    const items = this.list(kind)
      .slice()
      .sort(
        (a, b) =>
          b.updatedAt.localeCompare(a.updatedAt) ||
          a.createdAt.localeCompare(b.createdAt),
      )
      .slice(0, 40);

    return this.formatLines(items, "还没有。");
  }

  /**
   * 下次对话里用。看法、还放不下的事、想晚一点再问的问题分开。
   * 相关话题出现时拿对应的一条接，不念清单。
   */
  renderForConversation(): {
    views: string;
    unresolved: string;
    questions: string;
    viewItems: Array<{ about: string; content: string }>;
  } {
    const views = this.recentViews(VIEW_CONTEXT_LIMIT).filter(
      (thought) => !isPersonaRewrite(thought.about, thought.content),
    );

    return {
      views: this.formatLines(views, "还没有。"),
      viewItems: views.map((thought) => ({
        about: thought.about,
        content: thought.content,
      })),
      unresolved: this.formatLines(
        this.recentOpen("unresolved", OPEN_CONTEXT_LIMIT),
        "还没有。",
      ),
      questions: this.formatLines(
        this.recentOpen("question", OPEN_CONTEXT_LIMIT),
        "还没有。",
      ),
    };
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

  private saveBySubject(
    kind: ThoughtKind,
    content: string,
    about: string,
  ): ThoughtSaveResult {
    const key = subjectKey(about);
    const matches = this.list(kind).filter(
      (thought) => subjectKey(thought.about) === key,
    );

    if (matches.length === 0) {
      return { thought: this.insert(kind, content, about), action: "created" };
    }

    const original = this.byAge(matches)[0];

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

  private recentViews(limit: number): CompanionThought[] {
    return this.list("view")
      .slice()
      .sort(
        (a, b) =>
          b.updatedAt.localeCompare(a.updatedAt) ||
          b.createdAt.localeCompare(a.createdAt),
      )
      .slice(0, limit);
  }

  private recentOpen(
    kind: "unresolved" | "question",
    limit: number,
  ): CompanionThought[] {
    return this.list(kind)
      .slice()
      .sort(
        (a, b) =>
          b.updatedAt.localeCompare(a.updatedAt) ||
          b.createdAt.localeCompare(a.createdAt),
      )
      .slice(0, limit);
  }

  private byAge(thoughts: CompanionThought[]): CompanionThought[] {
    return thoughts
      .slice()
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) ||
          a.id.localeCompare(b.id),
      );
  }

  private formatLines(thoughts: CompanionThought[], empty: string): string {
    if (thoughts.length === 0) return empty;

    return thoughts
      .map((thought) =>
        thought.about
          ? `- ${thought.about}：${thought.content}`
          : `- ${thought.content}`,
      )
      .join("\n");
  }
}

function matterRequired(kind: ThoughtKind): string {
  if (kind === "view") return "A view needs the matter it is about";
  if (kind === "unresolved") {
    return "An unresolved matter needs the matter it is about";
  }

  return "A question needs the matter it is about";
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
