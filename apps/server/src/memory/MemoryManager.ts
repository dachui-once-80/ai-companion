import {
    MemoryStore,
    type RecallMemoryOptions,
    type RememberMemoryInput,
} from "./MemoryStore";
import {
    betweenKey,
    describeBetweenText,
    parseBetweenKey,
    renderBetweenText,
    selectBetween,
    isStandingKind,
    type BetweenKind,
    type BetweenRecord,
} from "./between";
import type { Memory, MemoryImportance } from "./MemoryTypes";
import {
    contentKey,
    formatToday,
    isOpenCategory,
    openId,
    openKey,
} from "./openMemory";

const importanceRank: Record<MemoryImportance, number> = {
    high: 3,
    medium: 2,
    low: 1,
};

function byImportanceThenTime(a: Memory, b: Memory): number {
    return (
        importanceRank[b.importance] - importanceRank[a.importance] ||
        b.updatedAt.localeCompare(a.updatedAt)
    );
}

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

    saveEpisode(
        date: string,
        content: string,
        importance: MemoryImportance,
    ) {
        return this.store.saveCompanionMemory({
            category: "episode",
            key: openKey("episode", date),
            content,
            importance,
            mode: "append",
        });
    }

    saveImpression(
        theme: string,
        content: string,
        importance: MemoryImportance,
    ) {
        return this.store.saveCompanionMemory({
            category: "impression",
            key: openKey("impression", theme),
            content,
            importance,
            mode: "replace",
        });
    }

    retireImpression(theme: string): number {
        return this.store.retireCompanionMemory(
            "impression",
            openKey("impression", theme),
        );
    }

    saveNote(
        label: string,
        content: string,
        importance: MemoryImportance,
    ) {
        return this.store.saveCompanionMemory({
            category: "note",
            key: openKey("note", label),
            content,
            importance,
            mode: "append",
        });
    }

    getContext(limit = 12): string {
        return [
            this.renderSections(limit),
            "",
            "使用这些记忆时：",
            "- 只在和当前对话相关时自然使用，不要逐条复述，也不要说「根据记忆」。",
            "- 档案是用户说过的事实，不是你的身份。",
            "- 最近发生的事按日期理解。用户问昨天、前几天时，先对照今天的日期；没有记录就说不记得。",
            "- 你对用户的判断是你自己的感觉。可以轻轻带出来，不要当成用户确认过的资料。用户说的不一样，以现在说的为准。",
            "- 你决定留下的事是以后还用得上、又不适合放进档案的内容。",
            "- 怎么称呼、先听完再给办法、不能先给建议、彼此的笑话、答应了还没做的事，不在这里。那些在「我们之间」。",
            "- 问更早的事，或上下文里没有的事，调用 recall_memory，用事情里的词去查，不要编档案 key。",
            "- 用户明确说出姓名、城市、喜好这类稳定事实时，用 remember_memory 写入对应档案。某一天的事、近况和你的感觉不要写进档案。",
            "- 不要编造这里没有的个人信息。",
        ].join("\n");
    }

    describeForReview(limit = 12): string {
        return this.renderSections(limit);
    }

    /**
     * 下次连线用。称呼和一直生效的相处方式始终在。
     * 笑话和还没做的约定，只有 topic 对得上才带。
     */
    renderBetween(topic = ""): string {
        return renderBetweenText(selectBetween(this.currentBetween(), topic));
    }

    /** 连线中途，只补和当前这句话相关的笑话、未完成约定。 */
    renderBetweenTopic(topic: string): string {
        const extra = selectBetween(this.currentBetween(), topic).filter(
            (item) => !isStandingKind(item.kind),
        );

        return extra.length === 0 ? "" : renderBetweenText(extra);
    }

    /** 整理时对照已有的相处方式，沿用原来的 kind 和 about。 */
    describeBetween(): string {
        const items = this.currentBetween()
            .slice()
            .sort(
                (a, b) =>
                    b.updatedAt.localeCompare(a.updatedAt) ||
                    a.about.localeCompare(b.about),
            )
            .slice(0, 40);

        return describeBetweenText(items);
    }

    saveBetween(
        kind: BetweenKind,
        about: string,
        content: string,
        importance: MemoryImportance,
    ) {
        const key = betweenKey(kind, about);
        const normalized = contentKey(content);
        const current = this.store
            .findByCategory("between")
            .filter((memory) => memory.status === "current");
        const sameText = current.find(
            (memory) => contentKey(memory.content) === normalized,
        );

        if (sameText && sameText.key !== key) {
            return { action: "unchanged" as const, memory: sameText };
        }

        return this.store.saveCompanionMemory({
            category: "between",
            key,
            content,
            importance,
            mode: "replace",
        });
    }

    retireBetween(kind: BetweenKind, about: string): number {
        return this.store.retireCompanionMemory(
            "between",
            betweenKey(kind, about),
        );
    }

    private currentBetween(): BetweenRecord[] {
        return this.store
            .findByCategory("between")
            .filter(
                (memory) =>
                    memory.status === "current" &&
                    memory.content.trim() !== "",
            )
            .flatMap((memory) => {
                const parsed = parseBetweenKey(memory.key);

                if (!parsed) return [];

                return [
                    {
                        kind: parsed.kind,
                        about: parsed.about,
                        content: memory.content,
                        importance: memory.importance,
                        updatedAt: memory.updatedAt,
                    },
                ];
            });
    }

    private renderSections(profileLimit: number): string {
        const current = this.store.getAll().filter(
            (memory) =>
                memory.status === "current" &&
                memory.content.trim() !== "",
        );

        const profile = current
            .filter(
                (memory) =>
                    !isOpenCategory(memory.category) &&
                    memory.key.trim() !== "",
            )
            .sort(byImportanceThenTime)
            .slice(0, profileLimit);

        const episodes = current
            .filter((memory) => memory.category === "episode")
            .sort(
                (a, b) =>
                    b.key.localeCompare(a.key) ||
                    b.updatedAt.localeCompare(a.updatedAt),
            )
            .slice(0, 8);

        const impressions = current
            .filter((memory) => memory.category === "impression")
            .sort(byImportanceThenTime)
            .slice(0, 8);

        const notes = current
            .filter((memory) => memory.category === "note")
            .sort(byImportanceThenTime)
            .slice(0, 6);

        const blocks = [`今天是 ${formatToday()}。`];

        if (
            profile.length === 0 &&
            episodes.length === 0 &&
            impressions.length === 0 &&
            notes.length === 0
        ) {
            blocks.push("当前没有可用的长期记忆。");
            return blocks.join("\n");
        }

        if (profile.length > 0) {
            blocks.push(
                "",
                "## 档案",
                "用户明确说过、现在仍然成立的稳定事实。",
                ...profile.map(
                    (memory) => `- ${memory.key}: ${memory.content}`,
                ),
            );
        }

        if (episodes.length > 0) {
            blocks.push(
                "",
                "## 最近发生的事",
                "聊过的具体片段。问昨天或前几天时，按今天的日期往前对，没有记录就不要编。",
                ...episodes.map(
                    (memory) =>
                        `- ${openId("episode", memory.key)}：${memory.content}`,
                ),
            );
        }

        if (impressions.length > 0) {
            blocks.push(
                "",
                "## 你对用户的判断",
                "这是你自己的感觉，不是用户填进档案的事实。用注意到的口气说，不要宣读。用户要是说得不一样，以用户现在说的为准。",
                ...impressions.map((memory) => `- ${memory.content}`),
            );
        }

        if (notes.length > 0) {
            blocks.push(
                "",
                "## 你决定留下的事",
                "从聊天里挑出来、以后还用得上、又不适合放进档案的内容。",
                ...notes.map((memory) => `- ${memory.content}`),
            );
        }

        return blocks.join("\n");
    }

    remove(id: string) {
        return this.store.removeMemory(id);
    }

    clear() {
        this.store.clear();
    }
}