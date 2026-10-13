import { useCallback, useEffect, useRef, useState } from "react";

import {
  RealtimeClient,
  type ConnectionState,
  type CompanionEmotion,
} from "./realtime/RealtimeClient";

import "./App.css";

type VisualState = "idle" | "listening" | "thinking" | "speaking";

type MemoryCategory =
  | "identity"
  | "preference"
  | "fact"
  | "event"
  | "relationship";

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
};

const importanceLabels: Record<MemoryImportance, string> = {
  low: "低",
  medium: "中",
  high: "高",
};

function formatDate(value: string) {
  if (!value) return "时间未知";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function App() {
  const clientRef = useRef<RealtimeClient | null>(null);
  const transcriptRef = useRef("");
  const visualStateRef = useRef<VisualState>("idle");

  const [state, setState] = useState<ConnectionState>("idle");
  const [transcript, setTranscript] = useState("");
  const [emotion, setEmotion] = useState<CompanionEmotion>("calm");
  const [visualState, setVisualState] = useState<VisualState>("idle");

  const [memories, setMemories] = useState<Memory[]>([]);
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryError, setMemoryError] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<
    "all" | MemoryStatus
  >("current");
  const [notice, setNotice] = useState("");
  const notifiedReminderIds = useRef<Set<string>>(new Set());

  const updateVisualState = useCallback((next: VisualState) => {
    visualStateRef.current = next;
    setVisualState(next);
  }, []);

  const loadMemories = useCallback(async () => {
    setMemoryLoading(true);
    setMemoryError("");

    try {
      const response = await fetch("/api/memory");

      if (!response.ok) {
        throw new Error(`读取记忆失败：HTTP ${response.status}`);
      }

      const data: unknown = await response.json();

      // 兼容后端直接返回数组，或返回 { memories: [...] }。
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

      setMemoryError(
        error instanceof Error ? error.message : "读取记忆失败",
      );
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
    let active = true;
    let checking = false;

    const checkReminders = async () => {
      if (checking) return;
      checking = true;

      try {
        const response = await fetch("/api/tasks/reminders");

        if (!response.ok) {
          throw new Error(`读取提醒失败：HTTP ${response.status}`);
        }

        const data: {
          success: boolean;
          reminders?: Array<{
            id: string;
            title: string;
            description?: string;
            reminderAt?: string | null;
          }>;
        } = await response.json();

        if (!active || !data.success || !data.reminders) return;

        for (const reminder of data.reminders) {
          if (notifiedReminderIds.current.has(reminder.id)) continue;

          notifiedReminderIds.current.add(reminder.id);

          setNotice(`⏰ 阿七提醒你：${reminder.title}`);

          // 如果浏览器允许通知，就同时显示系统通知。
          if ("Notification" in window && Notification.permission === "granted") {
            new Notification("阿七提醒你", {
              body: reminder.title,
            });
          }
        }
      } catch (error) {
        console.error("[Reminder] 检查提醒失败", error);
      } finally {
        checking = false;
      }
    };

    void checkReminders();

    const timer = window.setInterval(() => {
      void checkReminders();
    }, 5000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const connect = async () => {
    // 防止重复创建连接。
    if (clientRef.current) return;
    const client = new RealtimeClient();
    try {
      setState("connecting");
      setTranscript("");
      transcriptRef.current = "";

      setEmotion("calm");
      updateVisualState("idle");


      clientRef.current = client;

      client.setMessageHandler((message) => {
        console.log("[App message]", message);

        if (clientRef.current !== client) {
          return;
        }

        if (message.type === "memory_updated") {
          console.log("[Memory] refreshing memory list");
          void loadMemories();
        }

        if (message.type === "emotion_changed") {
          setEmotion(message.emotion);
          console.log("[Emotion] changed to:", message.emotion);
        }

        // 累计同一说话者的转录片段。
        if (
          message.type === "input_transcript" ||
          message.type === "output_transcript"
        ) {
          const speaker =
            message.type === "input_transcript" ? "你" : "阿七";

          const prefix = `${speaker}：`;
          const previous = transcriptRef.current;

          const next = previous.startsWith(prefix)
            ? previous + message.text
            : prefix + message.text;

          transcriptRef.current = next;
          setTranscript(next);
        }

        if (message.type === "connected") {
          setState("connected");
          updateVisualState("listening");
        }
        if (message.type === "audio_playback_started") {
          updateVisualState("speaking");
        }

        if (message.type === "input_transcript") {
          // 用户开始说话，阿七正在接收语音输入。
          updateVisualState("thinking");
        }

        if (message.type === "turn_complete") {
          // 本轮模型输出完成，返回聆听状态。
          updateVisualState("listening");
        }

        if (message.type === "error") {
          console.error("[Connection] client error:", message.error);

          clientRef.current = null;

          setState("error");
          updateVisualState("idle");

          // 清理旧连接。后续 disconnected 事件会被上面的身份检查忽略。
          client.disconnect();
          return;
        }

        if (message.type === "disconnected") {
          setState("idle");
          updateVisualState("idle");
          return;
        }
        if (message.type === "closed") {
          console.warn(
            "[Connection] connection closed:",
            message.reason,
          );

          clientRef.current = null;

          setState("idle");
          updateVisualState("idle");
          setEmotion("calm");

          if (
            message.reason?.includes(
              "User location is not supported",
            )
          ) {
            setNotice(
              "Gemini 拒绝了当前代理出口 IP。请在 Clash 换一个美国/日本/新加坡节点，打开 /api/gemini/health 确认 ok:true 后再呼叫。",
            );
          } else if (message.reason) {
            setNotice(`连接已断开：${message.reason}`);
          }

          return;
        }
      });

      await client.connect();

      // 避免连接过程中用户已经断开后又被设回 connected。
      if (clientRef.current === client) {
        setState("connected");
        updateVisualState("listening");
      }
    } catch (error) {
      console.error("[Connection] failed", error);

      // 无论是否仍是当前客户端，都清理失败的客户端。
      client.disconnect();

      // 只有当前客户端才能修改界面状态。
      if (clientRef.current === client) {
        clientRef.current = null;

        setState("error");
        updateVisualState("idle");
      }
    }
  };

  const disconnect = () => {
    const client = clientRef.current;

    // 先清空引用，防止后续异步操作误判为仍在连接。
    clientRef.current = null;

    client?.disconnect();

    setState("idle");
    setTranscript("");
    transcriptRef.current = "";

    setEmotion("calm");
    updateVisualState("idle");
  };

  const editMemory = async (memory: Memory) => {
    const content = window.prompt(
      "修改这条记忆的内容：",
      memory.content,
    );

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
      const response = await fetch(
        `/api/memory/${encodeURIComponent(memory.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: trimmedContent,
            importance,
          }),
        },
      );

      if (!response.ok) {
        const result = await response.json().catch(() => null);

        throw new Error(
          result?.error ?? `编辑失败：HTTP ${response.status}`,
        );
      }

      setNotice("记忆已更新");
      await loadMemories();
    } catch (error) {
      console.error("[Memory] update failed", error);

      setNotice(
        error instanceof Error ? error.message : "编辑记忆失败",
      );
    }
  };

  const deleteMemory = async (memory: Memory) => {
    const confirmed = window.confirm(
      `确定删除这条记忆吗？\n\n${memory.content}\n\n删除后无法从这里恢复。`,
    );

    if (!confirmed) return;

    try {
      const response = await fetch(
        `/api/memory/${encodeURIComponent(memory.id)}`,
        { method: "DELETE" },
      );

      if (!response.ok) {
        const result = await response.json().catch(() => null);

        throw new Error(
          result?.error ?? `删除失败：HTTP ${response.status}`,
        );
      }

      setNotice("记忆已删除");
      await loadMemories();
    } catch (error) {
      console.error("[Memory] delete failed", error);

      setNotice(
        error instanceof Error ? error.message : "删除记忆失败",
      );
    }
  };

  const isConnected = state === "connected";

  const filteredMemories = memories.filter((memory) => {
    const matchesStatus =
      statusFilter === "all" || memory.status === statusFilter;

    const keyword = search.trim().toLowerCase();

    const matchesSearch =
      !keyword ||
      memory.content.toLowerCase().includes(keyword) ||
      memory.key.toLowerCase().includes(keyword) ||
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

  const visualStateLabels: Record<VisualState, string> = {
    idle: "待机中",
    listening: "正在聆听",
    thinking: "正在思考",
    speaking: "正在回应",
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="阿七首页">
          <span className="brand-mark">七</span>
          <span>
            阿七 <small>PERSONAL AI</small>
          </span>
        </a>

        <span className="topbar-caption">你的私人 AI 伙伴</span>
      </header>

      <div className="dashboard">
        <section className="companion-panel">
          <div className="eyebrow">YOUR COMPANION</div>

          <div
            className={[
              "orb",
              isConnected ? "orb-active" : "",
              `orb-emotion-${emotion}`,
              `orb-mode-${visualState}`,
            ]
              .filter(Boolean)
              .join(" ")}
            role="img"
            aria-label={`阿七当前情绪：${emotionLabels[emotion]}，状态：${visualStateLabels[visualState]}`}
          >
            <div className="orb-aura" />

            <div className="orb-face">
              <div className="orb-eyes">
                <span className="orb-eye orb-eye-left" />
                <span className="orb-eye orb-eye-right" />
              </div>

              <div className="orb-mouth" />
            </div>

            {/* <div className="orb-core">七</div> */}
          </div>

          <h1>阿七</h1>

          <p className="companion-subtitle">一直在这里，听你说。</p>

          <p className="emotion-status">
            当前情绪：{emotionLabels[emotion]}
          </p>

          <p className="emotion-status">
            当前状态：{visualStateLabels[visualState]}
          </p>

          <div className={`connection-pill status-${state}`}>
            <span className="status-dot" />
            {state === "idle" && "还没醒呢"}
            {state === "connecting" && "正在醒来……"}
            {state === "connected" && "嗯，我在。"}
            {state === "error" && "连接遇到问题"}
          </div>

          <div className="transcript-box">
            <span className="transcript-label">最近的对话</span>
            <p>{transcript || "呼叫阿七，开始你们的对话吧。"}</p>
          </div>

          {state === "idle" || state === "error" ? (
            <button className="primary-button" onClick={connect}>
              呼叫阿七 <span>↗</span>
            </button>
          ) : (
            <button className="secondary-button" onClick={disconnect}>
              让阿七休息
            </button>
          )}

          <p className="privacy-note">
            <span>✦</span> 你的伙伴 · 你的记忆 · 由你掌控
          </p>
        </section>

        <section className="memory-panel">
          <div className="memory-heading">
            <div>
              <div className="eyebrow">LONG-TERM MEMORY</div>
              <h2>记忆管理</h2>
              <p className="section-description">
                阿七记住了什么，由你决定。
              </p>
            </div>

            <button
              className="refresh-button"
              onClick={() => void loadMemories()}
              disabled={memoryLoading}
              title="刷新记忆"
            >
              <span className={memoryLoading ? "refresh-spinning" : ""}>
                ↻
              </span>
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
              <button
                onClick={() => setNotice("")}
                aria-label="关闭提示"
              >
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
              <p>正在读取阿七的记忆……</p>
            </div>
          )}

          {!memoryLoading &&
            !memoryError &&
            filteredMemories.length === 0 && (
              <div className="empty-state">
                <div className="empty-icon">✧</div>

                <strong>
                  {search ? "没有找到匹配的记忆" : "这里暂时空空的"}
                </strong>

                <p>
                  {search
                    ? "试试其他关键词，或切换记忆分类。"
                    : "当阿七开始记住你的生活，这里就会慢慢丰富起来。"}
                </p>

                {search && (
                  <button
                    className="text-button"
                    onClick={() => setSearch("")}
                  >
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

                    <span
                      className={`importance-tag importance-${memory.importance}`}
                    >
                      {importanceLabels[memory.importance] ??
                        memory.importance}
                      重要
                    </span>

                    {memory.status === "historical" && (
                      <span className="historical-tag">历史</span>
                    )}
                  </div>

                  <span className="memory-key">{memory.key}</span>
                </div>

                <p className="memory-content">{memory.content}</p>

                <div className="memory-card-bottom">
                  <span className="memory-date">
                    更新于 {formatDate(memory.updatedAt)}
                  </span>

                  <div className="memory-actions">
                    <button onClick={() => void editMemory(memory)}>
                      编辑
                    </button>

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
            <div className="list-footer">
              显示 {filteredMemories.length} 条记忆
            </div>
          )}
        </section>
      </div>

      <footer className="app-footer">
        <span>阿七 · 个人 AI 伙伴</span>
        <span>
          记忆由你掌控 <span className="footer-heart">♥</span>
        </span>
      </footer>
    </main>
  );
}

const emotionLabels: Record<CompanionEmotion, string> = {
  calm: "平静",
  happy: "开心",
  caring: "温柔关怀",
  curious: "好奇",
};

export default App;
