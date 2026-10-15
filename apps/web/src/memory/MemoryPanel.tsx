import { useCallback, useEffect, useState } from "react";
import { formatDate } from "../formatDate";

type MemoryCategory =
  | "identity"
  | "preference"
  | "fact"
  | "event"
  | "relationship"
  | "episode"
  | "impression"
  | "note";

type MemoryImportance = "low" | "medium" | "high";

type MemoryStatus = "current" | "historical";

type Memory = {
  id: string;
  category: MemoryCategory;
  key: string;
  content: string;
  importance: MemoryImportance;
  status: MemoryStatus;
  source: string;
  createdAt: string;
  updatedAt: string;
};

const categoryLabels: Record<MemoryCategory, string> = {
  identity: "身份",
  preference: "偏好",
  fact: "事实",
  event: "事件",
  relationship: "关系",
  episode: "片段",
  impression: "判断",
  note: "留下的",
};

const importanceLabels: Record<MemoryImportance, string> = {
  low: "低",
  medium: "中",
  high: "高",
};

function displayKey(key: string): string {
  if (
    key.startsWith("episode:") ||
    key.startsWith("impression:") ||
    key.startsWith("note:")
  ) {
    return key.slice(key.indexOf(":") + 1);
  }

  return key;
}

export default function MemoryPanel({ name }: { name: string }) {
  const called = name || "她";
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryError, setMemoryError] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | MemoryStatus>(
    "current",
  );
  const [notice, setNotice] = useState("");

  const loadMemories = useCallback(async () => {
    setMemoryLoading(true);
    setMemoryError("");

    try {
      const response = await fetch("/api/memory");

      if (!response.ok) {
        throw new Error(`读取记忆失败：HTTP ${response.status}`);
      }

      const data: unknown = await response.json();
      const list =
        Array.isArray(data)
          ? data
          : data &&
              typeof data === "object" &&
              "memories" in data &&
              Array.isArray(data.memories)
            ? data.memories
            : null;

      if (!list) {
        throw new Error("记忆接口返回格式不符合预期");
      }

      setMemories(list as Memory[]);
    } catch (error) {
      console.error("[Memory] load failed", error);
      setMemoryError(error instanceof Error ? error.message : "读取记忆失败");
    } finally {
      setMemoryLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadMemories();
    }, 0);

    return () => {
      window.clearTimeout(timer);
    };
  }, [loadMemories]);

  useEffect(() => {
    const onMemoryUpdated = () => {
      void loadMemories();
    };

    window.addEventListener("companion-memory-updated", onMemoryUpdated);

    return () => {
      window.removeEventListener("companion-memory-updated", onMemoryUpdated);
    };
  }, [loadMemories]);

  const editMemory = async (memory: Memory) => {
    const content = window.prompt("修改这条记忆的内容：", memory.content);

    if (content === null) return;

    const trimmedContent = content.trim();

    if (!trimmedContent) {
      setNotice("记忆内容不能为空");
      return;
    }

    if (trimmedContent.length > 500) {
      setNotice("记忆内容不能超过 500 个字符");
      return;
    }

    const importanceInput = window.prompt(
      "设置重要程度：low / medium / high",
      memory.importance,
    );

    if (importanceInput === null) return;

    const importance = importanceInput.trim().toLowerCase();

    if (!["low", "medium", "high"].includes(importance)) {
      setNotice("重要程度只能填写 low、medium 或 high");
      return;
    }

    try {
      const response = await fetch(`/api/memory/${encodeURIComponent(memory.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: trimmedContent,
          importance,
        }),
      });

      if (!response.ok) {
        const result = await response.json().catch(() => null);

        throw new Error(result?.error ?? `编辑失败：HTTP ${response.status}`);
      }

      setNotice("记忆已更新");
      await loadMemories();
    } catch (error) {
      console.error("[Memory] update failed", error);
      setNotice(error instanceof Error ? error.message : "编辑记忆失败");
    }
  };

  const deleteMemory = async (memory: Memory) => {
    const confirmed = window.confirm(
      `确定删除这条记忆吗？\n\n${memory.content}\n\n删除后无法从这里恢复。`,
    );

    if (!confirmed) return;

    try {
      const response = await fetch(`/api/memory/${encodeURIComponent(memory.id)}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const result = await response.json().catch(() => null);

        throw new Error(result?.error ?? `删除失败：HTTP ${response.status}`);
      }

      setNotice("记忆已删除");
      await loadMemories();
    } catch (error) {
      console.error("[Memory] delete failed", error);
      setNotice(error instanceof Error ? error.message : "删除记忆失败");
    }
  };

  const filteredMemories = memories.filter((memory) => {
    const matchesStatus =
      statusFilter === "all" || memory.status === statusFilter;
    const keyword = search.trim().toLowerCase();
    const matchesSearch =
      !keyword ||
      memory.content.toLowerCase().includes(keyword) ||
      memory.key.toLowerCase().includes(keyword) ||
      displayKey(memory.key).toLowerCase().includes(keyword) ||
      (categoryLabels[memory.category] ?? memory.category)
        .toLowerCase()
        .includes(keyword);

    return matchesStatus && matchesSearch;
  });

  const currentCount = memories.filter(
    (memory) => memory.status === "current",
  ).length;
  const historicalCount = memories.filter(
    (memory) => memory.status === "historical",
  ).length;

  return (
    <section className="memory-panel">
      <a className="page-back" href="#meet">
        回到她这里
      </a>

      <div className="memory-heading">
        <div>
          <div className="eyebrow">LONG-TERM MEMORY</div>
          <h2>记忆管理</h2>
          <p className="section-description">
            档案、聊过的片段，和她留下的判断。
          </p>
        </div>

        <button
          className="refresh-button"
          onClick={() => void loadMemories()}
          disabled={memoryLoading}
          title="刷新记忆"
        >
          <span className={memoryLoading ? "refresh-spinning" : ""}>↻</span>
          刷新
        </button>
      </div>

      <div className="memory-stats">
        <div className="stat-card">
          <span>当前记忆</span>
          <strong>{currentCount}</strong>
          <small>正在使用</small>
        </div>

        <div className="stat-card">
          <span>历史记忆</span>
          <strong>{historicalCount}</strong>
          <small>曾经发生过</small>
        </div>

        <div className="stat-card">
          <span>记忆总数</span>
          <strong>{memories.length}</strong>
          <small>全部记录</small>
        </div>
      </div>

      <div className="memory-toolbar">
        <label className="search-box">
          <span>⌕</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索记忆内容或关键词……"
          />
          {search && (
            <button
              className="clear-search"
              onClick={() => setSearch("")}
              aria-label="清除搜索"
            >
              ×
            </button>
          )}
        </label>

        <div className="filter-tabs">
          <button
            className={statusFilter === "current" ? "selected" : ""}
            onClick={() => setStatusFilter("current")}
          >
            当前
          </button>
          <button
            className={statusFilter === "historical" ? "selected" : ""}
            onClick={() => setStatusFilter("historical")}
          >
            历史
          </button>
          <button
            className={statusFilter === "all" ? "selected" : ""}
            onClick={() => setStatusFilter("all")}
          >
            全部
          </button>
        </div>
      </div>

      {notice && (
        <div className="notice-bar">
          <span>{notice}</span>
          <button onClick={() => setNotice("")} aria-label="关闭提示">
            ×
          </button>
        </div>
      )}

      {memoryError && (
        <div className="error-panel">
          <strong>暂时无法读取记忆</strong>
          <p>{memoryError}</p>
          <button onClick={() => void loadMemories()}>重试</button>
        </div>
      )}

      {memoryLoading && memories.length === 0 && (
        <div className="empty-state">
          <div className="empty-icon">◌</div>
          <p>正在读取{called}的记忆……</p>
        </div>
      )}

      {!memoryLoading && !memoryError && filteredMemories.length === 0 && (
        <div className="empty-state">
          <div className="empty-icon">✧</div>
          <strong>{search ? "没有找到匹配的记忆" : "这里暂时空空的"}</strong>
          <p>
            {search
              ? "试试其他关键词，或切换记忆分类。"
              : `当${called}开始记住你的生活，这里就会慢慢丰富起来。`}
          </p>
          {search && (
            <button className="text-button" onClick={() => setSearch("")}>
              清除搜索
            </button>
          )}
        </div>
      )}

      <div className="memory-list">
        {filteredMemories.map((memory) => (
          <article className="memory-card" key={memory.id}>
            <div className="memory-card-top">
              <div className="memory-tags">
                <span className="category-tag">
                  {categoryLabels[memory.category] ?? memory.category}
                </span>
                {memory.source === "companion" && (
                  <span className="category-tag">她留下的</span>
                )}
                <span
                  className={`importance-tag importance-${memory.importance}`}
                >
                  {importanceLabels[memory.importance] ?? memory.importance}
                  重要
                </span>
                {memory.status === "historical" && (
                  <span className="historical-tag">历史</span>
                )}
              </div>
              <span className="memory-key">{displayKey(memory.key)}</span>
            </div>

            <p className="memory-content">{memory.content}</p>

            <div className="memory-card-bottom">
              <span className="memory-date">
                更新于 {formatDate(memory.updatedAt)}
              </span>
              <div className="memory-actions">
                <button onClick={() => void editMemory(memory)}>编辑</button>
                <button
                  className="delete-button"
                  onClick={() => void deleteMemory(memory)}
                >
                  删除
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>

      {filteredMemories.length > 0 && (
        <div className="list-footer">显示 {filteredMemories.length} 条记忆</div>
      )}
    </section>
  );
}
