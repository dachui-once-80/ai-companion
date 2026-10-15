const MAX_MEMORY_CONTENT_LENGTH = 500;

import {
  and,
  desc,
  eq,
} from "drizzle-orm";

import { db } from "../db";
import { memories } from "../db/schema";

import { contentKey } from "./openMemory";

import {
  getMemoryPolicy,
  getMemoryCategory,
  isValidMemoryKey,
} from "./MemoryPolicy";
import {
  isUnstatedProfile,
  normalizeImportantDate,
} from "./profileFacts";

import type {
  Memory,
  MemoryCategory,
  MemoryImportance,
  MemoryStatus,
  MemorySource,
} from "./MemoryTypes";

import type { OpenMemoryCategory } from "./openMemory";

export type RememberMemoryInput = {
  category: MemoryCategory;
  key: string;
  content: string;
  importance: MemoryImportance;
  status?: MemoryStatus;
  source: MemorySource;
};

export type RecallScope =
  | "current"
  | "historical"
  | "all";

export type RecallMemoryOptions = {
  query: string;
  key?: string;
  scope?: RecallScope;
};

export class MemoryStore {
  addMemory(
    input: RememberMemoryInput,
  ): Memory {
    const now = new Date().toISOString();

    const memory: Memory = {
      id: crypto.randomUUID(),

      category: input.category,

      key: input.key.trim(),

      content: input.content.trim(),

      importance: input.importance,

      status: input.status ?? "current",

      source: input.source,

      createdAt: now,

      updatedAt: now,
    };

    db.insert(memories)
      .values({
        id: memory.id,

        category: memory.category,

        key: memory.key,

        content: memory.content,

        importance: memory.importance,

        status: memory.status,

        source: memory.source,

        createdAt: memory.createdAt,

        updatedAt: memory.updatedAt,
      })
      .run();

    return memory;
  }

  getAll(): Memory[] {
    return db
      .select()
      .from(memories)
      .orderBy(desc(memories.updatedAt))
      .all()
      .map((memory) =>
        this.toMemory(memory),
      );
  }

  findByCategory(
    category: MemoryCategory,
  ): Memory[] {
    return db
      .select()
      .from(memories)
      .where(
        eq(memories.category, category),
      )
      .orderBy(desc(memories.updatedAt))
      .all()
      .map((memory) =>
        this.toMemory(memory),
      );
  }

  findByKey(
    key: string,
  ): Memory[] {
    return db
      .select()
      .from(memories)
      .where(eq(memories.key, key))
      .orderBy(desc(memories.updatedAt))
      .all()
      .map((memory) =>
        this.toMemory(memory),
      );
  }

  findCurrentByKey(
    key: string,
  ): Memory[] {
    return db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.key, key),
          eq(memories.status, "current"),
        ),
      )
      .orderBy(desc(memories.updatedAt))
      .all()
      .map((memory) =>
        this.toMemory(memory),
      );
  }

  /**
 * 撤销某一项多值记忆。
 *
 * 例如：
 * favorite_drink = 咖啡
 *
 * 用户表示不再喜欢咖啡时，
 * 将咖啡转为 historical，
 * 不影响可乐、绿茶等其他当前记忆。
 */
  forgetCurrentMemory(
    key: string,
    targetContent: string,
  ): Memory | null {
    const normalizedKey = key.trim();
    const normalizedTarget = targetContent.trim().toLowerCase();

    if (!normalizedKey || !normalizedTarget) {
      throw new Error("Memory key and target content cannot be empty");
    }

    if (!isValidMemoryKey(normalizedKey)) {
      throw new Error(`Invalid memory key: ${normalizedKey}`);
    }

    const policy = getMemoryPolicy(normalizedKey);

    if (policy !== "multi-value") {
      throw new Error(
        `Cannot forget an individual value from single-current key: ${normalizedKey}`,
      );
    }

    const currentMemories = this.findCurrentByKey(normalizedKey);

    // 只匹配目标记忆，不影响同一 key 下的其他值。
    // 只匹配完整内容，避免误撤销相似记忆。
    const targetMemory = currentMemories.find((memory) => {
      const content = memory.content.trim().toLowerCase();
      return content === normalizedTarget;
    });


    if (!targetMemory) {
      return null;
    }

    const updatedAt = new Date().toISOString();

    db.update(memories)
      .set({
        status: "historical",
        updatedAt,
      })
      .where(
        and(
          eq(memories.id, targetMemory.id),
          eq(memories.status, "current"),
        ),
      )
      .run();

    const updated = db
      .select()
      .from(memories)
      .where(eq(memories.id, targetMemory.id))
      .get();

    return updated ? this.toMemory(updated) : null;
  }

  findByImportance(
    importance: MemoryImportance,
  ): Memory[] {
    return db
      .select()
      .from(memories)
      .where(
        eq(
          memories.importance,
          importance,
        ),
      )
      .orderBy(desc(memories.updatedAt))
      .all()
      .map((memory) =>
        this.toMemory(memory),
      );
  }

  search(query: string): Memory[] {
    const normalizedQuery = query.trim().toLowerCase();

    if (!normalizedQuery) {
      return [];
    }

    const allMemories = this.getAll();
    const keywords = this.extractKeywords(normalizedQuery);

    const scored = allMemories
      .map((memory) => {
        const content = memory.content.toLowerCase();
        const key = memory.key.toLowerCase();

        let relevanceScore = 0;

        // 完整短语匹配给予更高权重
        if (
          content.length > 0 &&
          (
            content.includes(normalizedQuery) ||
            normalizedQuery.includes(content)
          )
        ) {
          relevanceScore += 8;
        }

        // key 只有非空时才参与完整匹配
        if (
          key.length > 0 &&
          (
            key.includes(normalizedQuery) ||
            normalizedQuery.includes(key)
          )
        ) {
          relevanceScore += 8;
        }

        // 根据关键词计算相关度
        for (const keyword of keywords) {
          if (content.includes(keyword)) {
            relevanceScore += keyword.length >= 2 ? 3 : 1;
          }

          if (key.length > 0 && key.includes(keyword)) {
            relevanceScore += 4;
          }
        }

        // 没有文本相关性的记忆，不参与本次搜索
        if (relevanceScore === 0) {
          return { memory, score: 0 };
        }

        let score = relevanceScore;

        if (memory.status === "current") {
          score += 2;
        }

        if (memory.importance === "high") {
          score += 1;
        }

        return { memory, score };
      })
      .filter((item) => item.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.memory.updatedAt.localeCompare(
            a.memory.updatedAt,
          ),
      );

    return scored.map((item) => item.memory);
  }

  recall(options: RecallMemoryOptions): Memory[] {
    const query = options.query.trim();
    const key = options.key?.trim();
    const scope = options.scope ?? "all";

    let results = this.getAll();

    // 先执行精确的结构化过滤
    if (key) {
      results = results.filter(
        (memory) => memory.key === key,
      );
    }

    if (scope !== "all") {
      results = results.filter(
        (memory) => memory.status === scope,
      );
    }

    // 指定 key 时，保留原有的结构化查询行为
    if (key) {
      return this.sortMemories(results);
    }

    // 未提供文本查询时，返回过滤后的记忆
    if (!query) {
      return this.sortMemories(results);
    }

    const normalizedQuery = query.toLowerCase();
    const keywords = this.extractKeywords(normalizedQuery);

    return results
      .map((memory) => {
        const content = memory.content.toLowerCase();
        const memoryKey = memory.key.toLowerCase();
        const category = memory.category.toLowerCase();

        let relevanceScore = 0;

        // 完整短语匹配
        if (
          content.length > 0 &&
          (
            content.includes(normalizedQuery) ||
            normalizedQuery.includes(content)
          )
        ) {
          relevanceScore += 8;
        }

        if (
          memoryKey.length > 0 &&
          (
            memoryKey.includes(normalizedQuery) ||
            normalizedQuery.includes(memoryKey)
          )
        ) {
          relevanceScore += 8;
        }

        // 内容和 key 比分类名称更能体现语义相关性
        for (const keyword of keywords) {
          if (content.includes(keyword)) {
            relevanceScore += keyword.length >= 2 ? 3 : 1;
          }

          if (memoryKey.length > 0 && memoryKey.includes(keyword)) {
            relevanceScore += 4;
          }

          if (category.includes(keyword)) {
            relevanceScore += 1;
          }
        }

        // 相关度为零时，不因记忆状态或重要程度而入选
        if (relevanceScore === 0) {
          return { memory, score: 0 };
        }

        let score = relevanceScore;

        if (memory.status === "current") {
          score += 2;
        }

        if (memory.importance === "high") {
          score += 1;
        }

        return { memory, score };
      })
      .filter((item) => item.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.memory.updatedAt.localeCompare(
            a.memory.updatedAt,
          ),
      )
      .map((item) => item.memory);
  }

  rememberMemory(
    input: RememberMemoryInput,
  ): {
    action: "created" | "updated" | "unchanged";
    memory: Memory;
    previousMemory?: Memory;
  } {
    const key = input.key.trim();
    let content = input.content.trim();

    if (!isValidMemoryKey(key)) {
      throw new Error(`Invalid memory key: ${key}`);
    }

    if (!content) {
      throw new Error("Memory content cannot be empty");
    }

    if (isUnstatedProfile(content)) {
      throw new Error("Refusing unstated profile fact");
    }

    if (key === "important_date") {
      const normalized = normalizeImportantDate(content);

      if (!normalized) {
        throw new Error("important_date must include a readable date");
      }

      content = normalized;
    }

    if (content.length > MAX_MEMORY_CONTENT_LENGTH) {
      throw new Error(
        `Memory content is too long (max ${MAX_MEMORY_CONTENT_LENGTH} characters)`,
      );
    }

    const expectedCategory = getMemoryCategory(key);

    if (input.category !== expectedCategory) {
      throw new Error(
        `Memory category mismatch: key "${key}" requires category "${expectedCategory}"`,
      );
    }

    const currentMemories = this.findCurrentByKey(key);
    const cardinality = getMemoryPolicy(key);

    // 多值记忆：允许多个不同内容同时处于 current 状态。
    if (cardinality === "multi-value") {
      const duplicate = currentMemories.find(
        (memory) =>
          memory.content.trim().toLowerCase() ===
          content.toLowerCase(),
      );

      if (duplicate) {
        return {
          action: "unchanged",
          memory: duplicate,
        };
      }

      return {
        action: "created",
        memory: this.addMemory({
          ...input,
          key,
          content,
          status: "current",
        }),
      };
    }

    // 单值记忆：内容相同时，不重复创建。
    const existing = currentMemories.find(
      (memory) =>
        memory.content.trim().toLowerCase() ===
        content.toLowerCase(),
    );

    if (existing && currentMemories.length === 1) {
      return {
        action: "unchanged",
        memory: existing,
      };
    }

    // 单值记忆尚不存在时，直接创建。
    if (currentMemories.length === 0) {
      return {
        action: "created",
        memory: this.addMemory({
          ...input,
          key,
          content,
          status: "current",
        }),
      };
    }

    // 更新单值记忆：归档所有旧 current，并原子性地创建新值。
    const now = new Date().toISOString();

    const next: Memory = {
      id: crypto.randomUUID(),
      category: input.category,
      key,
      content,
      importance: input.importance,
      status: "current",
      source: input.source,
      createdAt: now,
      updatedAt: now,
    };

    const previous = currentMemories[0];

    db.transaction((tx) => {
      for (const memory of currentMemories) {
        tx.update(memories)
          .set({
            status: "historical",
            updatedAt: now,
          })
          .where(eq(memories.id, memory.id))
          .run();
      }

      tx.insert(memories)
        .values({
          id: next.id,
          category: next.category,
          key: next.key,
          content: next.content,
          importance: next.importance,
          status: next.status,
          source: next.source,
          createdAt: next.createdAt,
          updatedAt: next.updatedAt,
        })
        .run();
    });

    return {
      action: "updated",
      memory: next,
      previousMemory: {
        ...previous,
        status: "historical",
        updatedAt: now,
      },
    };
  }

  /**
   * 片段、判断、留下的事不走档案 key。
   * append 按内容去重；replace 用同一 key 替换当前判断。
   */
  saveCompanionMemory(input: {
    category: OpenMemoryCategory;
    key: string;
    content: string;
    importance: MemoryImportance;
    mode: "append" | "replace";
  }): {
    action: "created" | "updated" | "unchanged";
    memory: Memory;
  } {
    const category = input.category;
    const key = input.key.trim();
    const content = input.content.trim();

    if (!key.startsWith(`${category}:`)) {
      throw new Error(`Invalid companion memory key: ${key}`);
    }

    if (!content) {
      throw new Error("Memory content cannot be empty");
    }

    if (content.length > MAX_MEMORY_CONTENT_LENGTH) {
      throw new Error(
        `Memory content is too long (max ${MAX_MEMORY_CONTENT_LENGTH} characters)`,
      );
    }

    const normalized = contentKey(content);
    const current = this.findByCategory(category).filter(
      (memory) => memory.status === "current",
    );

    if (input.mode === "append") {
      const duplicate = current.find(
        (memory) => contentKey(memory.content) === normalized,
      );

      if (duplicate) {
        return { action: "unchanged", memory: duplicate };
      }

      return {
        action: "created",
        memory: this.addMemory({
          category,
          key,
          content,
          importance: input.importance,
          status: "current",
          source: "companion",
        }),
      };
    }

    const sameKey = current.filter((memory) => memory.key === key);
    const sameText = sameKey.find(
      (memory) => contentKey(memory.content) === normalized,
    );

    if (sameText) {
      return { action: "unchanged", memory: sameText };
    }

    if (sameKey.length === 0) {
      return {
        action: "created",
        memory: this.addMemory({
          category,
          key,
          content,
          importance: input.importance,
          status: "current",
          source: "companion",
        }),
      };
    }

    const now = new Date().toISOString();
    const next: Memory = {
      id: crypto.randomUUID(),
      category,
      key,
      content,
      importance: input.importance,
      status: "current",
      source: "companion",
      createdAt: now,
      updatedAt: now,
    };

    db.transaction((tx) => {
      for (const memory of sameKey) {
        tx.update(memories)
          .set({ status: "historical", updatedAt: now })
          .where(eq(memories.id, memory.id))
          .run();
      }

      tx.insert(memories)
        .values({
          id: next.id,
          category: next.category,
          key: next.key,
          content: next.content,
          importance: next.importance,
          status: next.status,
          source: next.source,
          createdAt: next.createdAt,
          updatedAt: next.updatedAt,
        })
        .run();
    });

    return { action: "updated", memory: next };
  }

  retireCompanionMemory(
    category: OpenMemoryCategory,
    key: string,
  ): number {
    const normalizedKey = key.trim();

    if (!normalizedKey.startsWith(`${category}:`)) {
      throw new Error(`Invalid companion memory key: ${normalizedKey}`);
    }

    const current = this.findCurrentByKey(normalizedKey).filter(
      (memory) => memory.category === category,
    );

    if (current.length === 0) return 0;

    const updatedAt = new Date().toISOString();

    for (const memory of current) {
      db.update(memories)
        .set({ status: "historical", updatedAt })
        .where(
          and(
            eq(memories.id, memory.id),
            eq(memories.status, "current"),
          ),
        )
        .run();
    }

    return current.length;
  }

  updateMemory(
    id: string,
    input: Partial<
      Pick<
        Memory,
        | "category"
        | "key"
        | "content"
        | "importance"
        | "status"
      >
    >,
  ): Memory | null {
    const existing = db
      .select()
      .from(memories)
      .where(
        eq(memories.id, id),
      )
      .get();

    if (!existing) {
      return null;
    }

    const updatedAt =
      new Date().toISOString();

    db.update(memories)
      .set({
        ...(input.category !==
          undefined
          ? {
            category:
              input.category,
          }
          : {}),

        ...(input.key !==
          undefined
          ? {
            key:
              input.key,
          }
          : {}),

        ...(input.content !==
          undefined
          ? {
            content:
              input.content,
          }
          : {}),

        ...(input.importance !==
          undefined
          ? {
            importance:
              input.importance,
          }
          : {}),

        ...(input.status !==
          undefined
          ? {
            status:
              input.status,
          }
          : {}),

        updatedAt,
      })
      .where(
        eq(memories.id, id),
      )
      .run();

    const updated = db
      .select()
      .from(memories)
      .where(
        eq(memories.id, id),
      )
      .get();

    if (!updated) {
      return null;
    }

    return this.toMemory(
      updated,
    );
  }

  removeMemory(
    id: string,
  ): boolean {
    const result = db
      .delete(memories)
      .where(
        eq(memories.id, id),
      )
      .run();

    return result.changes > 0;
  }

  clear(): void {
    db.delete(memories).run();
  }

  private extractKeywords(query: string): string[] {
    const keywords = new Set<string>();

    const stopWords = [
      "我的",
      "你的",
      "我们",
      "你们",
      "他们",
      "她们",
      "什么",
      "哪些",
      "哪个",
      "哪里",
      "怎么",
      "如何",
      "还记得",
      "记得",
      "知道",
      "有没有",
      "关于",
      "方面",
      "事情",
      "东西",
      "我",
      "你",
      "他",
      "她",
      "它",
      "吗",
      "呢",
      "呀",
      "啊",
      "了",
      "的",
      "是",
    ];

    let text = query.toLowerCase().trim();

    for (const word of stopWords) {
      text = text.replaceAll(word, " ");
    }

    // 保留英文、数字和按空格分开的完整词语
    for (const part of text.split(/\s+/)) {
      const word = part.trim();

      if (word.length >= 2) {
        keywords.add(word);
      }
    }

    // 中文按连续片段提取双字关键词，不再添加单个汉字
    const chineseSegments =
      text.match(/[\u4e00-\u9fff]+/g) ?? [];

    for (const segment of chineseSegments) {
      if (segment.length >= 2) {
        keywords.add(segment);
      }

      for (let i = 0; i < segment.length - 1; i++) {
        const pair = segment.slice(i, i + 2);

        if (!stopWords.includes(pair)) {
          keywords.add(pair);
        }
      }
    }

    return Array.from(keywords);
  }

  private sortMemories(
    memoriesToSort: Memory[],
  ): Memory[] {
    const importanceScore: Record<
      MemoryImportance,
      number
    > = {
      high: 3,
      medium: 2,
      low: 1,
    };

    return [
      ...memoriesToSort,
    ].sort((a, b) => {
      const importanceDiff =
        importanceScore[
        b.importance
        ] -
        importanceScore[
        a.importance
        ];

      if (
        importanceDiff !== 0
      ) {
        return importanceDiff;
      }

      return (
        new Date(
          b.updatedAt,
        ).getTime() -
        new Date(
          a.updatedAt,
        ).getTime()
      );
    });
  }

  private toMemory(
    memory:
      typeof memories.$inferSelect,
  ): Memory {
    return {
      id: memory.id,

      category:
        memory.category as MemoryCategory,

      key: memory.key,

      content: memory.content,

      importance:
        memory.importance as MemoryImportance,

      status:
        memory.status as MemoryStatus,

      source:
        memory.source as MemorySource,

      createdAt:
        memory.createdAt,

      updatedAt:
        memory.updatedAt,
    };
  }
}