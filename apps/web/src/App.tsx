import { useCallback, useEffect, useRef, useState } from "react";

import MemoryPanel from "./memory/MemoryPanel";
import { formatDate } from "./formatDate";
import {
  noticeForConnectError,
  resolveCloseFeedback,
  resolveConnectCatch,
} from "./connectionFeedback";
import { createIdentityGate } from "./identityLoad";
import {
  classifySettleHttpResult,
  markDeferredBackoff,
  nextPendingAfterUncertain,
  planReminderBatch,
  resolveAfterMentionDue,
  resolveMentionDueThrow,
  type PendingSettle,
} from "./reminderClient";
import {
  parseCompanionAffect,
  RealtimeClient,
  type ConnectionState,
  type CompanionEmotion,
} from "./realtime/RealtimeClient";
import { scheduleStartupConsolidationDrain } from "./realtime/startupConsolidationDrain";
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
import { retractCompanionSuffix } from "./realtime/turnTranscript";

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
  const inFlightReminderIds = useRef<Set<string>>(new Set());
  const pendingSettle = useRef<PendingSettle[]>([]);
  /** speak 领取时的 claimedAt，供 settle 防陈旧租约 */
  const reminderClaimAt = useRef<Map<string, string>>(new Map());
  /** settle 有界重试耗尽：仍靠 spoken 防重播，不再请求 settle */
  const settleGaveUpIds = useRef<Set<string>>(new Set());
  /** Aside deferred 退避：id → 可再次 mentionDue 的时间 */
  const deferredUntil = useRef<Map<string, number>>(new Map());
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

  const retractCompanionLine = useCallback(
    (suffix: string) => {
      const draft = draftRef.current;

      // 空后缀、无草稿、后缀对不上最后一条 companion 行：一律不改。
      if (!draft || !suffix) return;

      const next = retractCompanionSuffix(draft.lines, suffix);

      if (next === draft.lines) return;

      draft.lines = next;

      // 已播出的音频无法收回；此处只撤回字幕。若 unfinished 正是被撤段落则清掉。
      if (draft.unfinished && !next.some((line) => line.text === draft.unfinished)) {
        draft.unfinished = "";
      }

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
    void scheduleStartupConsolidationDrain();
  }, []);

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

    const settleReminder = async (
      id: string,
      heard: boolean,
      claimedAt?: string,
    ) => {
      const body: { id: string; heard: boolean; claimedAt?: string } = {
        id,
        heard,
      };
      const claim = claimedAt ?? reminderClaimAt.current.get(id);
      if (claim) body.claimedAt = claim;

      let response: Response;

      try {
        response = await fetch("/api/tasks/reminders/settle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch {
        return { kind: "uncertain" as const, line: "", leftAt: "" };
      }

      let data: unknown;

      try {
        data = await response.json();
      } catch {
        data = null;
      }

      const deferred =
        !!data &&
        typeof data === "object" &&
        "deferred" in data &&
        data.deferred === true;
      const stale =
        !!data &&
        typeof data === "object" &&
        "stale" in data &&
        data.stale === true;

      const kind = classifySettleHttpResult({
        ok: response.ok,
        status: response.status,
        deferred,
        stale,
      });

      if (kind !== "ok") {
        return { kind, line: "", leftAt: "" };
      }

      const line =
        data &&
        typeof data === "object" &&
        "line" in data &&
        typeof data.line === "string"
          ? data.line.trim()
          : "";
      const leftAt =
        data &&
        typeof data === "object" &&
        "leftAt" in data &&
        typeof data.leftAt === "string"
          ? data.leftAt
          : "";

      return { kind, line, leftAt };
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
        const stillPending: PendingSettle[] = [];

        for (const item of pendingSettle.current) {
          try {
            const settled = await settleReminder(
              item.id,
              item.heard,
              item.claimedAt,
            );

            if (settled.kind === "uncertain") {
              const next = nextPendingAfterUncertain(item);
              if (next) {
                stillPending.push(next);
              } else if (item.heard) {
                settleGaveUpIds.current.add(item.id);
              } else {
                reminderClaimAt.current.delete(item.id);
              }
              continue;
            }

            if (settled.kind === "deferred") {
              reminderClaimAt.current.delete(item.id);
              settleGaveUpIds.current.delete(item.id);
              markDeferredBackoff(deferredUntil.current, item.id, Date.now());
              continue;
            }

            if (settled.kind === "stale") {
              reminderClaimAt.current.delete(item.id);
              settleGaveUpIds.current.delete(item.id);
              deferredUntil.current.delete(item.id);
              continue;
            }

            handledReminderIds.current.add(item.id);
            reminderClaimAt.current.delete(item.id);
            settleGaveUpIds.current.delete(item.id);
            deferredUntil.current.delete(item.id);

            if (item.heard) {
              spokenReminderIds.current.add(item.id);
            } else if (settled.line) {
              showHerLine(settled.line, settled.leftAt);
            }
          } catch (error) {
            console.error("[Reminder] 补记提醒失败", error);
            const next = nextPendingAfterUncertain(item);
            if (next) stillPending.push(next);
            else if (item.heard) settleGaveUpIds.current.add(item.id);
            else reminderClaimAt.current.delete(item.id);
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
            claimedAt?: string;
          }>;
        } = await response.json();

        if (!active || !data.success || !data.reminders) return;

        for (const reminder of data.reminders) {
          if (reminder.delivery === "speak" && reminder.claimedAt) {
            reminderClaimAt.current.set(reminder.id, reminder.claimedAt);
          }
        }

        const plan = planReminderBatch({
          reminders: data.reminders,
          spoken: spokenReminderIds.current,
          handled: handledReminderIds.current,
          inFlight: inFlightReminderIds.current,
          pendingSettleIds: new Set(
            pendingSettle.current.map((item) => item.id),
          ),
          settleGaveUp: settleGaveUpIds.current,
          deferredUntil: deferredUntil.current,
          nowMs: Date.now(),
        });

        // deferred 退避中又被 claim：只释放租约，不 mentionDue。
        for (const item of plan.releaseDeferred) {
          const settled = await settleReminder(
            item.id,
            false,
            item.claimedAt,
          );

          if (settled.kind === "ok") {
            handledReminderIds.current.add(item.id);
            reminderClaimAt.current.delete(item.id);
            deferredUntil.current.delete(item.id);
            if (settled.line) showHerLine(settled.line, settled.leftAt);
            continue;
          }

          if (settled.kind === "deferred") {
            markDeferredBackoff(deferredUntil.current, item.id, Date.now());
            reminderClaimAt.current.delete(item.id);
            continue;
          }

          reminderClaimAt.current.delete(item.id);
          if (settled.kind === "stale") {
            deferredUntil.current.delete(item.id);
          }
        }

        for (const id of plan.settleSpoken) {
          try {
            const settled = await settleReminder(
              id,
              true,
              reminderClaimAt.current.get(id),
            );

            if (settled.kind === "ok") {
              handledReminderIds.current.add(id);
              reminderClaimAt.current.delete(id);
              settleGaveUpIds.current.delete(id);
              continue;
            }

            if (settled.kind === "stale" || settled.kind === "deferred") {
              reminderClaimAt.current.delete(id);
              settleGaveUpIds.current.delete(id);
              continue;
            }

            const next = nextPendingAfterUncertain({
              id,
              heard: true,
              claimedAt: reminderClaimAt.current.get(id),
            });
            if (next) pendingSettle.current.push(next);
            else settleGaveUpIds.current.add(id);
          } catch (error) {
            console.error("[Reminder] 补记已说提醒失败", error);
            const next = nextPendingAfterUncertain({
              id,
              heard: true,
              claimedAt: reminderClaimAt.current.get(id),
            });
            if (next) pendingSettle.current.push(next);
            else settleGaveUpIds.current.add(id);
          }
        }

        for (const item of plan.showLeft) {
          handledReminderIds.current.add(item.id);
          showHerLine(item.line, item.leftAt);
        }

        const toSpeak = plan.toSpeak;

        if (toSpeak.length === 0) return;

        const claimedAtById = new Map(
          toSpeak.map((item) => [item.id, item.claimedAt]),
        );

        for (const item of toSpeak) inFlightReminderIds.current.add(item.id);

        try {
          let heard = false;
          let mentionFailed = false;

          try {
            heard =
              voiceOpenRef.current && clientRef.current
                ? await clientRef.current.mentionDue(
                    toSpeak.map((item) => item.line),
                  )
                : false;
          } catch (error) {
            console.error("[Reminder] mentionDue failed", error);
            mentionFailed = true;
            heard = false;
          }

          if (mentionFailed) {
            const thrown = resolveMentionDueThrow(
              toSpeak.map((item) => item.id),
              claimedAtById,
            );

            // 立刻 settle(heard=false) 释放 speaking，不干等 45s。
            for (const item of thrown.pendingSettle) {
              const settled = await settleReminder(
                item.id,
                false,
                item.claimedAt,
              );

              if (settled.kind === "ok") {
                handledReminderIds.current.add(item.id);
                reminderClaimAt.current.delete(item.id);
                settleGaveUpIds.current.delete(item.id);
                deferredUntil.current.delete(item.id);
                if (settled.line) showHerLine(settled.line, settled.leftAt);
                continue;
              }

              if (settled.kind === "uncertain") {
                const next = nextPendingAfterUncertain(item);
                if (next) pendingSettle.current.push(next);
                else reminderClaimAt.current.delete(item.id);
                continue;
              }

              if (settled.kind === "deferred") {
                reminderClaimAt.current.delete(item.id);
                settleGaveUpIds.current.delete(item.id);
                markDeferredBackoff(deferredUntil.current, item.id, Date.now());
                continue;
              }

              reminderClaimAt.current.delete(item.id);
              settleGaveUpIds.current.delete(item.id);
              if (settled.kind === "stale") {
                deferredUntil.current.delete(item.id);
              }
            }

            return;
          }

          const settleSucceeded = new Set<string>();
          const settleDeferred = new Set<string>();
          const settleStale = new Set<string>();
          const leftLines = new Map<string, { line: string; leftAt: string }>();

          for (const item of toSpeak) {
            const settled = await settleReminder(
              item.id,
              heard,
              item.claimedAt,
            );

            if (settled.kind === "ok") {
              settleSucceeded.add(item.id);
              if (!heard && settled.line) {
                leftLines.set(item.id, {
                  line: settled.line,
                  leftAt: settled.leftAt,
                });
              }
              continue;
            }

            if (settled.kind === "deferred") {
              settleDeferred.add(item.id);
              continue;
            }

            if (settled.kind === "stale") {
              settleStale.add(item.id);
            }
          }

          const outcome = resolveAfterMentionDue({
            ids: toSpeak.map((item) => item.id),
            heard,
            settleSucceeded,
            settleDeferred,
            settleStale,
            claimedAtById,
          });

          for (const id of outcome.markSpoken) {
            spokenReminderIds.current.add(id);
          }

          for (const id of outcome.markHandled) {
            handledReminderIds.current.add(id);
            reminderClaimAt.current.delete(id);
            settleGaveUpIds.current.delete(id);
            deferredUntil.current.delete(id);
            const left = leftLines.get(id);
            if (left) showHerLine(left.line, left.leftAt);
          }

          for (const id of settleDeferred) {
            reminderClaimAt.current.delete(id);
            settleGaveUpIds.current.delete(id);
            markDeferredBackoff(deferredUntil.current, id, Date.now());
          }

          for (const id of settleStale) {
            reminderClaimAt.current.delete(id);
            settleGaveUpIds.current.delete(id);
            deferredUntil.current.delete(id);
          }

          for (const item of outcome.pendingSettle) {
            pendingSettle.current.push(item);
          }
        } finally {
          for (const item of toSpeak) {
            inFlightReminderIds.current.delete(item.id);
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
      // 新一次呼叫：清掉过期失败提示，避免成功后或重试时残留。
      setNotice("");
      setState("connecting");
      endSession();
      startSession();
      presenceRef.current = "together";
      setPresence("together");
      updateVisualState("idle");
      clientRef.current = client;

      client.setMessageHandler((message) => {
        console.log("[App message]", message);

        // 旧 client 的迟到回调不得改写新连接或取消后的 UI。
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

        if (message.type === "output_retract") {
          retractCompanionLine(message.text);
        }

        if (message.type === "connected") {
          holdListeningRef.current = false;
          voiceOpenRef.current = true;
          setNotice("");
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
          setNotice(noticeForConnectError(message.error));
          updateVisualState("idle");
          client.disconnect();
          return;
        }

        if (message.type === "disconnected") {
          voiceOpenRef.current = false;
          endSession();
          // 若已是 error（带失败提示），不要被迟到的 disconnected 盖回 idle。
          setState((current) => (current === "error" ? current : "idle"));
          updateVisualState("idle");
          return;
        }

        if (message.type === "closed") {
          console.warn("[Connection] connection closed:", message.reason);

          voiceOpenRef.current = false;
          clientRef.current = null;
          endSession();
          updateVisualState("idle");

          const feedback = resolveCloseFeedback(message.reason);
          setState(feedback.state);
          if (feedback.notice) setNotice(feedback.notice);
        }
      });

      await client.connect();

      if (clientRef.current === client) {
        voiceOpenRef.current = true;
        setNotice("");
        setState("connected");
        updateVisualState("listening");
      }
    } catch (error) {
      console.error("[Connection] failed", error);
      client.disconnect();

      const outcome = resolveConnectCatch({
        isCurrentClient: clientRef.current === client,
        error,
      });

      if (outcome.kind === "stale") {
        // 用户已取消，或 error/closed 已更新 UI；此处不再改状态或提示。
        return;
      }

      clientRef.current = null;
      endSession();
      setState(outcome.state);
      setNotice(outcome.notice);
      updateVisualState("idle");
    }
  };

  const disconnect = () => {
    const client = clientRef.current;

    voiceOpenRef.current = false;
    clientRef.current = null;
    endSession();
    client?.disconnect();
    setState("idle");
    // 主动结束 / 取消连接：不保留失败提示，避免被当成意外故障。
    setNotice("");
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
