import { useCallback, useEffect, useRef, useState } from "react";

import MemoryPanel from "./memory/MemoryPanel";
import { formatDate } from "./formatDate";
import { createIdentityGate } from "./identityLoad";
import {
  parseCompanionAffect,
  RealtimeClient,
  type ConnectionState,
  type CompanionEmotion,
} from "./realtime/RealtimeClient";
import type { Floor } from "./realtime/presence";
import TalkPage from "./talk/TalkPage";
import {
  clearDraft,
  createDraft,
  finishDraft,
  saveDraft,
  sentenceLooksFinished,
  settleStoredTalk,
  type LastTalk,
  type TalkDraft,
  type TalkLine,
} from "./talk/lastTalk";

import "./App.css";

type VisualState = "idle" | "listening" | "thinking" | "speaking";
type Screen = "meet" | "memory" | "talk";

const NAME_KEY = "companion.currentName";

function readScreen(): Screen {
  const hash = window.location.hash.replace(/^#/, "");

  if (hash === "memory") return "memory";
  if (hash === "talk") return "talk";

  return "meet";
}

function readCurrentName(data: unknown): string | null {
  if (
    data &&
    typeof data === "object" &&
    "currentName" in data &&
    typeof data.currentName === "string"
  ) {
    return data.currentName;
  }

  return null;
}

function cachedName(): string {
  try {
    return sessionStorage.getItem(NAME_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

function nameMark(name: string): string {
  const chars = Array.from(name.trim());

  return chars[chars.length - 1] ?? "";
}

function App() {
  const clientRef = useRef<RealtimeClient | null>(null);
  const lineIdRef = useRef(0);
  const visualStateRef = useRef<VisualState>("idle");
  const holdListeningRef = useRef(false);
  const presenceRef = useRef<Floor>("together");
  const draftRef = useRef<TalkDraft | null>(null);
  const initialName = cachedName();
  const nameRef = useRef(initialName);

  const [state, setState] = useState<ConnectionState>("idle");
  const [screen, setScreen] = useState<Screen>(readScreen);
  const [companionName, setCompanionName] = useState(initialName);
  const [liveLines, setLiveLines] = useState<TalkLine[]>([]);
  const [unfinishedLive, setUnfinishedLive] = useState("");
  const [lastTalk, setLastTalk] = useState<LastTalk | null>(settleStoredTalk);
  const [presence, setPresence] = useState<Floor>("together");
  const [emotion, setEmotion] = useState<CompanionEmotion>("calm");
  const affectEpoch = useRef(0);
  const [identityGate] = useState(createIdentityGate);
  const identityMounted = useRef(true);
  const [visualState, setVisualState] = useState<VisualState>("idle");
  const [notice, setNotice] = useState("");
  const voiceOpenRef = useRef(false);
  const handledReminderIds = useRef<Set<string>>(new Set());
  const spokenReminderIds = useRef<Set<string>>(new Set());
  const pendingSettle = useRef<Array<{ id: string; heard: boolean }>>([]);
  const [leftNote, setLeftNote] = useState<{
    text: string;
    leftAt: string;
  } | null>(null);

  const applyName = useCallback((next: string) => {
    const trimmed = next.trim();

    if (!trimmed) return;

    nameRef.current = trimmed;
    setCompanionName(trimmed);

    try {
      sessionStorage.setItem(NAME_KEY, trimmed);
    } catch {
      // 记不住这次名字，下次打开再问身份接口。
    }
  }, []);

  const loadIdentity = useCallback(async () => {
    const seq = identityGate.begin();

    try {
      const response = await fetch("/api/companion/identity");

      if (!response.ok) return;

      const name = readCurrentName(await response.json());

      if (!identityGate.shouldApply(seq, !identityMounted.current) || !name) return;

      applyName(name);
    } catch (error) {
      console.warn("[Identity] load failed:", error);
    }
  }, [applyName, identityGate]);

  const publishLive = useCallback((draft: TalkDraft) => {
    setLiveLines(draft.lines.slice(-8));
    setUnfinishedLive(draft.unfinished);
  }, []);

  const appendLine = useCallback(
    (speaker: string, text: string, fromCompanion: boolean) => {
      const draft = draftRef.current;

      if (!draft) return;

      const previous = draft.lines;
      const last = previous[previous.length - 1];
      const next =
        last && last.speaker === speaker
          ? [...previous.slice(0, -1), { ...last, text: last.text + text }]
          : [
              ...previous,
              {
                id: ++lineIdRef.current,
                speaker,
                text,
                fromCompanion,
              },
            ];

      draft.lines = next;
      saveDraft(draft);
      publishLive(draft);
    },
    [publishLive],
  );

  const endSession = useCallback(() => {
    const draft = draftRef.current;

    draftRef.current = null;
    setLiveLines([]);
    setUnfinishedLive("");

    if (!draft) return;

    if (draft.lines.length === 0) {
      clearDraft();
      return;
    }

    const saved = finishDraft(draft);

    if (saved) setLastTalk(saved);
  }, []);

  const startSession = useCallback(() => {
    const draft = createDraft();

    lineIdRef.current = 0;
    draftRef.current = draft;
    saveDraft(draft);
    setLiveLines([]);
    setUnfinishedLive("");
  }, []);

  const markUnfinished = useCallback(() => {
    const draft = draftRef.current;
    const last = draft?.lines[draft.lines.length - 1];

    if (!draft || !last?.fromCompanion || !last.text.trim()) return;

    draft.unfinished = last.text.trim();
    saveDraft(draft);
    setUnfinishedLive(draft.unfinished);
  }, []);

  const settleUnfinished = useCallback(() => {
    const draft = draftRef.current;
    const last = draft?.lines[draft.lines.length - 1];

    if (!draft || !last?.fromCompanion) return;

    const text = last.text.trim();

    if (!text) return;

    if (draft.unfinished) {
      if (text !== draft.unfinished && sentenceLooksFinished(text)) {
        draft.unfinished = "";
      } else if (text !== draft.unfinished) {
        draft.unfinished = text;
      }
    } else if (!sentenceLooksFinished(text)) {
      draft.unfinished = text;
    } else {
      return;
    }

    saveDraft(draft);
    setUnfinishedLive(draft.unfinished);
  }, []);

  useEffect(() => {
    let dropped = false;
    const seq = identityGate.begin();

    fetch("/api/companion/identity")
      .then((response) => {
        if (!response.ok) return null;

        return response.json() as Promise<unknown>;
      })
      .then((data) => {
        if (!identityGate.shouldApply(seq, dropped || !identityMounted.current) || data == null) return;

        const name = readCurrentName(data);

        if (name) applyName(name);
      })
      .catch((error: unknown) => {
        if (!dropped) console.warn("[Identity] load failed:", error);
      });

    return () => {
      dropped = true;
    };
  }, [applyName, identityGate, screen]);

  useEffect(() => {
    identityMounted.current = true;

    return () => {
      identityMounted.current = false;
      identityGate.invalidate();
    };
  }, [identityGate]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadIdentity();
    };

    document.addEventListener("visibilitychange", onVisible);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadIdentity]);

  useEffect(() => {
    const sync = () => setScreen(readScreen());

    window.addEventListener("hashchange", sync);

    return () => {
      window.removeEventListener("hashchange", sync);
    };
  }, []);

  useEffect(() => {
    if (state === "connected" || state === "connecting") return;

    let active = true;

    const refreshAffect = async () => {
      const seen = affectEpoch.current;

      try {
        const response = await fetch("/api/affect/settle", {
          method: "POST",
        });

        if (!response.ok) {
          throw new Error(`读取心情失败：HTTP ${response.status}`);
        }

        const affect = parseCompanionAffect(await response.json());

        if (!active || !affect || affectEpoch.current !== seen) return;

        setEmotion(affect.expression);
      } catch (error) {
        console.warn("[Affect] settle failed:", error);
      }
    };

    const timer = window.setTimeout(() => {
      void refreshAffect();
    }, 0);

    const interval = window.setInterval(() => {
      void refreshAffect();
    }, 20_000);

    return () => {
      active = false;
      window.clearTimeout(timer);
      window.clearInterval(interval);
    };
  }, [state]);

  useEffect(() => {
    let active = true;
    let checking = false;

    const settleReminder = async (id: string, heard: boolean) => {
      const response = await fetch("/api/tasks/reminders/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, heard }),
      });

      if (!response.ok) return null;

      const data: unknown = await response.json();

      if (!data || typeof data !== "object") return null;

      const line =
        "line" in data && typeof data.line === "string" ? data.line.trim() : "";
      const leftAt =
        "leftAt" in data && typeof data.leftAt === "string" ? data.leftAt : "";

      return { line, leftAt };
    };

    const showHerLine = (line: string, leftAt: string) => {
      if (!line) return;

      setLeftNote({
        text: line,
        leftAt: leftAt || new Date().toISOString(),
      });

      if ("Notification" in window && Notification.permission === "granted") {
        new Notification(nameRef.current || "她", { body: line });
      }
    };

    const checkReminders = async () => {
      if (checking) return;
      checking = true;

      try {
        const stillPending: Array<{ id: string; heard: boolean }> = [];

        for (const item of pendingSettle.current) {
          try {
            const settled = await settleReminder(item.id, item.heard);

            if (!settled) {
              stillPending.push(item);
              continue;
            }

            if (!item.heard) showHerLine(settled.line, settled.leftAt);
          } catch (error) {
            console.error("[Reminder] 补记提醒失败", error);
            stillPending.push(item);
          }
        }

        pendingSettle.current = stillPending;

        const response = await fetch(
          `/api/tasks/reminders?voice=${voiceOpenRef.current ? "1" : "0"}`,
        );

        if (!response.ok) {
          throw new Error(`读取提醒失败：HTTP ${response.status}`);
        }

        const data: {
          success: boolean;
          reminders?: Array<{
            id: string;
            line: string;
            delivery: "speak" | "left";
            leftAt?: string;
          }>;
        } = await response.json();

        if (!active || !data.success || !data.reminders) return;

        const toSpeak: Array<{ id: string; line: string }> = [];

        for (const reminder of data.reminders) {
          if (spokenReminderIds.current.has(reminder.id)) {
            try {
              const settled = await settleReminder(reminder.id, true);

              if (!settled) {
                pendingSettle.current.push({ id: reminder.id, heard: true });
              }
            } catch (error) {
              console.error("[Reminder] 补记已说提醒失败", error);
              pendingSettle.current.push({ id: reminder.id, heard: true });
            }
            continue;
          }

          if (handledReminderIds.current.has(reminder.id)) continue;

          if (reminder.delivery === "left") {
            handledReminderIds.current.add(reminder.id);
            showHerLine(reminder.line, reminder.leftAt ?? "");
            continue;
          }

          if (!reminder.line.trim()) continue;

          toSpeak.push({ id: reminder.id, line: reminder.line.trim() });
        }

        if (toSpeak.length === 0) return;

        for (const item of toSpeak) handledReminderIds.current.add(item.id);

        const said =
          voiceOpenRef.current && clientRef.current
            ? await clientRef.current.mentionDue(
                toSpeak.map((item) => item.line),
              )
            : false;

        if (said) {
          for (const item of toSpeak) spokenReminderIds.current.add(item.id);
        }

        for (const item of toSpeak) {
          try {
            const settled = await settleReminder(item.id, said);

            if (!settled) {
              pendingSettle.current.push({ id: item.id, heard: said });
              continue;
            }

            if (!said) showHerLine(settled.line, settled.leftAt);
          } catch (error) {
            console.error("[Reminder] 记录提醒结果失败", error);
            pendingSettle.current.push({ id: item.id, heard: said });
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

  useEffect(() => {
    let active = true;

    const loadLeftNote = async () => {
      try {
        const response = await fetch("/api/companion/aside");

        if (!response.ok) return;

        const data: unknown = await response.json();

        if (!active) return;

        const aside =
          data &&
          typeof data === "object" &&
          "aside" in data &&
          data.aside &&
          typeof data.aside === "object"
            ? data.aside
            : null;

        if (
          aside &&
          "text" in aside &&
          typeof aside.text === "string" &&
          aside.text.trim() &&
          "leftAt" in aside &&
          typeof aside.leftAt === "string"
        ) {
          setLeftNote({ text: aside.text.trim(), leftAt: aside.leftAt });
          return;
        }

        setLeftNote(null);
      } catch (error) {
        console.warn("[Aside] load failed:", error);
      }
    };

    void loadLeftNote();

    const timer = window.setInterval(() => {
      void loadLeftNote();
    }, 15_000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const updateVisualState = useCallback((next: VisualState) => {
    visualStateRef.current = next;
    setVisualState(next);
  }, []);

  const connect = async () => {
    if (clientRef.current) return;

    const client = new RealtimeClient();

    try {
      setState("connecting");
      endSession();
      startSession();
      presenceRef.current = "together";
      setPresence("together");
      updateVisualState("idle");
      clientRef.current = client;

      client.setMessageHandler((message) => {
        console.log("[App message]", message);

        if (clientRef.current !== client) return;

        if (message.type === "memory_updated") {
          console.log("[Memory] refreshing memory list");
        }

        if (message.type === "renamed") {
          // 改名是本地权威结果：作废进行中的身份请求，避免旧响应盖回旧名。
          identityGate.invalidate();
          applyName(message.name);
        }

        if (message.type === "emotion_changed") {
          affectEpoch.current += 1;
          setEmotion(message.emotion);
        }

        if (message.type === "presence") {
          presenceRef.current = message.floor;
          setPresence(message.floor);
        }

        if (
          message.type === "input_transcript" ||
          message.type === "output_transcript"
        ) {
          const fromCompanion = message.type === "output_transcript";
          const speaker = fromCompanion
            ? nameRef.current || "她"
            : message.speaker;

          appendLine(speaker, message.text, fromCompanion);
        }

        if (message.type === "connected") {
          holdListeningRef.current = false;
          voiceOpenRef.current = true;
          setState("connected");
          updateVisualState("listening");
        }

        if (message.type === "playback_interrupted") {
          holdListeningRef.current = true;
          markUnfinished();
          updateVisualState("listening");
        }

        if (message.type === "audio_playback_started") {
          holdListeningRef.current = false;
          updateVisualState("speaking");
        }

        if (message.type === "input_transcript") {
          const quiet =
            presenceRef.current === "aside" ||
            presenceRef.current === "holding";

          updateVisualState(
            quiet || holdListeningRef.current ? "listening" : "thinking",
          );
        }

        if (message.type === "turn_complete") {
          settleUnfinished();
          updateVisualState("listening");
        }

        if (message.type === "error") {
          console.error("[Connection] client error:", message.error);

          voiceOpenRef.current = false;
          clientRef.current = null;
          endSession();
          setState("error");
          updateVisualState("idle");
          client.disconnect();
          return;
        }

        if (message.type === "disconnected") {
          voiceOpenRef.current = false;
          endSession();
          setState("idle");
          updateVisualState("idle");
          return;
        }

        if (message.type === "closed") {
          console.warn("[Connection] connection closed:", message.reason);

          voiceOpenRef.current = false;
          clientRef.current = null;
          endSession();
          setState("idle");
          updateVisualState("idle");

          if (message.reason?.includes("User location is not supported")) {
            setNotice(
              "Gemini 拒绝了当前代理出口 IP。请在 Clash 换一个美国/日本/新加坡节点，打开 /api/gemini/health 确认 ok:true 后再呼叫。",
            );
          } else if (message.reason) {
            setNotice(`连接已断开：${message.reason}`);
          }
        }
      });

      await client.connect();

      if (clientRef.current === client) {
        voiceOpenRef.current = true;
        setState("connected");
        updateVisualState("listening");
      }
    } catch (error) {
      console.error("[Connection] failed", error);
      client.disconnect();

      if (clientRef.current === client) {
        clientRef.current = null;
        endSession();
        setState("error");
        updateVisualState("idle");
      }
    }
  };

  const disconnect = () => {
    const client = clientRef.current;

    voiceOpenRef.current = false;
    clientRef.current = null;
    endSession();
    client?.disconnect();
    setState("idle");
    presenceRef.current = "together";
    setPresence("together");
    updateVisualState("idle");
  };

  const called = companionName || "她";
  const isConnected = state === "connected";
  const unfinishedOutside =
    Boolean(unfinishedLive) &&
    !liveLines.some((line) => line.text === unfinishedLive);

  const visualStateLabels: Record<VisualState, string> = {
    idle: "待机中",
    listening: "正在聆听",
    thinking: "正在想",
    speaking: "正在说",
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#meet" aria-label={`${called}，回到见面`}>
          <span className="brand-mark">{nameMark(companionName) || "·"}</span>
          <span className="brand-name">{called}</span>
        </a>

        <a className="topbar-link" href="#memory">
          记忆
        </a>
      </header>

      {screen === "memory" ? (
        <div className="stage stage-wide">
          <MemoryPanel name={companionName} />
        </div>
      ) : screen === "talk" ? (
        <div className="stage">
          <TalkPage talk={lastTalk} />
        </div>
      ) : (
        <div className="stage">
          <section className="companion-panel">
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
              aria-label={`${called}，${visualStateLabels[visualState]}`}
            >
              <div className="orb-aura" />
              <div className="orb-face">
                <div className="orb-eyes">
                  <span className="orb-eye orb-eye-left" />
                  <span className="orb-eye orb-eye-right" />
                </div>
                <div className="orb-mouth" />
              </div>
            </div>

            <h1>{called}</h1>
            <p className="companion-subtitle">一直在这里，听你说。</p>

            {isConnected && (
              <p className="emotion-status">{visualStateLabels[visualState]}</p>
            )}

            {isConnected && presence !== "together" && (
              <p className={`emotion-status presence-${presence}`}>
                {presenceLabels[presence]}
              </p>
            )}

            <div className={`connection-pill status-${state}`}>
              <span className="status-dot" />
              {state === "idle" && "还没醒呢"}
              {state === "connecting" && "正在醒来……"}
              {state === "connected" && "嗯，我在。"}
              {state === "error" && "连接遇到问题"}
            </div>

            {leftNote ? (
              <div className="left-note">
                <span className="transcript-label">她留下的</span>
                <p>{leftNote.text}</p>
                <span className="left-note-time">
                  {formatDate(leftNote.leftAt)}
                </span>
              </div>
            ) : null}

            {lastTalk && (lastTalk.stoppedOn || lastTalk.unfinished) ? (
              <a className="trace" href="#talk">
                {lastTalk.stoppedOn &&
                lastTalk.stoppedOn !== lastTalk.unfinished ? (
                  <>
                    <span className="trace-label">上次停在</span>
                    <p>{lastTalk.stoppedOn}</p>
                  </>
                ) : null}

                {lastTalk.unfinished ? (
                  <>
                    <span className="trace-label">她没说完</span>
                    <p>{lastTalk.unfinished}</p>
                    {lastTalk.stoppedOn === lastTalk.unfinished ? (
                      <span className="trace-label">上次就停在这句</span>
                    ) : null}
                  </>
                ) : null}

                <span className="trace-open">翻这次对话</span>
              </a>
            ) : null}

            {isConnected && (liveLines.length > 0 || unfinishedOutside) ? (
              <div className="transcript-box">
                {unfinishedOutside ? (
                  <p className="transcript-line">
                    <span>她没说完：</span>
                    {unfinishedLive}
                  </p>
                ) : null}
                {liveLines.map((line) => (
                  <p className="transcript-line" key={line.id}>
                    <span>{line.speaker}：</span>
                    {line.text}
                  </p>
                ))}
              </div>
            ) : null}

            {notice ? (
              <div className="notice-bar">
                <span>{notice}</span>
                <button onClick={() => setNotice("")} aria-label="关闭提示">
                  ×
                </button>
              </div>
            ) : null}

            {state === "idle" || state === "error" ? (
              <button className="primary-button" onClick={connect}>
                呼叫{called} <span>↗</span>
              </button>
            ) : (
              <button className="secondary-button" onClick={disconnect}>
                让{called}休息
              </button>
            )}

            <p className="privacy-note">
              <span>✦</span> 你的伙伴 · 你的记忆 · 由你掌控
            </p>
          </section>
        </div>
      )}

      <footer className="app-footer">
        <span>{called}</span>
        <span>
          记忆由你掌控 <span className="footer-heart">♥</span>
        </span>
      </footer>
    </main>
  );
}

const presenceLabels: Record<Floor, string> = {
  together: "在跟你聊",
  aside: "听你们说，先不插嘴",
  holding: "你让我先安静",
  joined: "加入你们了",
};

export default App;
