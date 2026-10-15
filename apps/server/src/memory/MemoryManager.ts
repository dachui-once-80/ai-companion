import {
    MemoryStore,
    type RecallMemoryOptions,
    type RememberMemoryInput,
} from "./MemoryStore";
import {
    betweenKey,
    betweenLabel,
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
    parseImportantDate,
    type ReadableDate,
} from "./profileFacts";
import {
    contentKey,
    formatToday,
    isOpenCategory,
    openId,
    openKey,
} from "./openMemory";
import {
    candidateFromMemory,
    candidateFromView,
    isTrivialUtterance,
    literalMatches,
    renderCandidateLine,
    selectByMeaning,
    toRecalled,
    type MeaningDeps,
    type RecallCandidate,
    type RecalledMemory,
} from "./meaning";

type ViewSource = {
    list(kind: "view"): Array<{ id: string; about: string; content: string }>;
};

const importanceRank: Record<MemoryImportance, number> = {
    high: 3,
    medium: 2,
    low: 1,
};

const COMPANIONSHIP_KEYS = new Set([
    "when_sad",
    "preferred_address",
    "daily_routine",
    "current_activity",
    "avoid_topic",
    "important_date",
]);

function byImportanceThenTime(a: Memory, b: Memory): number {
    return (
        importanceRank[b.importance] - importanceRank[a.importance] ||
        b.updatedAt.localeCompare(a.updatedAt)
    );
}

export class MemoryManager {
    constructor(
        private readonly store: MemoryStore,
        private readonly views: ViewSource | null = null,
        private readonly meaning: MeaningDeps | null = null,
    ) { }

    remember(input: RememberMemoryInput) {
        return this.store.rememberMemory(input);
    }

    forget(key: string, targetContent: string) {
        return this.store.forgetCurrentMemory(key, targetContent);
    }

    /**
     * 按意思找。字面对得上的也能找到。
     * 没有够近的结果就空着，不用相近的另一件事来顶。
     */
    async recall(options: RecallMemoryOptions): Promise<RecalledMemory[]> {
        const query = options.query.trim();
        const key = options.key?.trim() || undefined;
        const scope = options.scope ?? "all";
        const pool = this.collect(scope, key);

        if (!query) return pool.map(toRecalled);

        const picked = await this.pick(pool, query, 4);

        return picked.map(toRecalled);
    }

    /**
     * 连线中这一句明显在说某个人或某件旧事时，补进那几条。
     * 对不上就返回空，不把整段历史塞进来。
     */
    async relevantText(utterance: string): Promise<string> {
        const topic = utterance.trim();

        if (topic.length < 2 || isTrivialUtterance(topic)) return "";

        const pool = this.collect("all").filter((item) => !item.standing);
        const picked = await this.pick(pool, topic, 4);
        const lines = new Map<string, string>();

        for (const item of picked) {
            lines.set(contentKey(item.content), renderCandidateLine(item));
        }

        for (const extra of selectBetween(this.currentBetween(), topic)) {
            if (isStandingKind(extra.kind) || lines.size >= 4) continue;

            const key = contentKey(extra.content);

            if (lines.has(key)) continue;

            lines.set(
                key,
                `- 我们之间 ${betweenLabel(extra.kind)}：${extra.content}`,
            );
        }

        return [...lines.values()].join("\n");
    }

    /** 当前档案里、以后能按日期读出来的在意的日子。 */
    listImportantDates(): ReadableDate[] {
        return this.store
            .findCurrentByKey("important_date")
            .map((memory) => parseImportantDate(memory.content))
            .filter((item): item is ReadableDate => item !== null);
    }

    /** 还没做完的约定。开场只从这里面挑，不把笑话和相处方式算进去。 */
    listPromises(): Array<{ about: string; content: string; updatedAt: string }> {
        return this.currentBetween()
            .filter((item) => item.kind === "promise")
            .map((item) => ({
                about: item.about,
                content: item.content,
                updatedAt: item.updatedAt,
            }));
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
            "- 档案是用户说过的事实，不是你的身份。",
            "- 最近发生的事按日期理解。用户问昨天、前几天时，先对照今天的日期；没有记录就说不记得。",
            "- 你对用户的判断是你自己的感觉。可以轻轻带出来，不要当成用户确认过的资料。用户说的不一样，以现在说的为准。",
            "- 你决定留下的事是以后还用得上、又不适合放进档案的内容。",
            "- when_sad 是用户难过时想被听还是想要办法。他难过时按这一条来，不要先给建议，除非这一条写的是想要办法。",
            "- preferred_address 是平时怎么称呼他，不是姓名。avoid_topic 里的话题不要主动提。",
            "- 彼此的笑话、答应了还没做的事、某一件具体的事要不要先听完，不在档案里。那些在「我们之间」。",
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

    private async pick(
        pool: RecallCandidate[],
        query: string,
        limit: number,
    ): Promise<RecallCandidate[]> {
        if (!this.meaning) return literalMatches(pool, query).slice(0, limit);

        return selectByMeaning(pool, query, this.meaning, limit);
    }

    private collect(scope: "current" | "historical" | "all", key?: string): RecallCandidate[] {
        const memories = this.store
            .getAll()
            .filter((memory) => {
                if (scope !== "all" && memory.status !== scope) return false;
                if (key && memory.key !== key) return false;

                return true;
            })
            .flatMap((memory) => {
                const candidate = candidateFromMemory(memory);

                return candidate ? [candidate] : [];
            });

        if (key || scope === "historical" || !this.views) return memories;

        const views = this.views.list("view").flatMap((view) => {
            const candidate = candidateFromView(view);

            return candidate ? [candidate] : [];
        });

        return [...memories, ...views];
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

        const profileAll = current
            .filter(
                (memory) =>
                    !isOpenCategory(memory.category) &&
                    memory.key.trim() !== "",
            )
            .sort(byImportanceThenTime);
        const companionship = profileAll
            .filter((memory) => COMPANIONSHIP_KEYS.has(memory.key))
            .slice(0, 16);
        const profile = [
            ...companionship,
            ...profileAll
                .filter((memory) => !COMPANIONSHIP_KEYS.has(memory.key))
                .slice(0, profileLimit),
        ];

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