import {
    MemoryStore,
    type RecallMemoryOptions,
    type RememberMemoryInput,
} from "./MemoryStore";

export class MemoryManager {
    constructor(
        private readonly store: MemoryStore,
    ) { }

    remember(input: RememberMemoryInput) {
        return this.store.rememberMemory(input);
    }

    forget(key: string, targetContent: string) {
        return this.store.forgetCurrentMemory(key, targetContent);
    }

    recall(options: RecallMemoryOptions) {
        return this.store.recall(options);
    }

    getAll() {
        return this.store.getAll();
    }

    // 新增：生成当前长期记忆上下文
    getContext(limit = 12): string {
        const importanceRank = {
            high: 3,
            medium: 2,
            low: 1,
        };

        const memories = this.store
            .getAll()
            .filter(
                (memory) =>
                    memory.status === "current" &&
                    memory.key.trim() !== "" &&
                    memory.content.trim() !== "",
            )
            .sort(
                (a, b) =>
                    importanceRank[b.importance] -
                    importanceRank[a.importance] ||
                    b.updatedAt.localeCompare(a.updatedAt),
            )
            .slice(0, limit);

        if (memories.length === 0) {
            return "当前没有可用的用户长期记忆。";
        }

        const memoryLines = memories.map(
            (memory) =>
                `- ${memory.key}: ${memory.content}`,
        );

        return [
            "以下是从长期记忆数据库读取的用户当前信息：",
            ...memoryLines,
            "",
            "使用这些记忆时请遵守以下规则：",
            "- 只在与当前对话相关时自然使用，不要主动逐条复述。",
            "- 这些记忆描述的是用户，不是你自己的身份。",
            "- 这些信息仅代表当前记忆，不代表完整的历史。",
            "- 用户询问以前的情况时，调用 recall_memory 查询历史记录。",
            "- 如果用户明确提供了新的信息，应通过 remember_memory 更新长期记忆，不要只修改上下文。",
            "- 不要编造数据库中不存在的个人信息。",
        ].join("\n");
    }

    remove(id: string) {
        return this.store.removeMemory(id);
    }

    clear() {
        this.store.clear();
    }
}