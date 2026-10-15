/**
 * 见面时主屏只留两处，不把整段对话摊开。
 * 第 1 条是上次连线停住的那一句，滚动的 8 行挤不掉它。
 * 第 9 条是她没说完的那一句，哪怕已经滑出最近 8 行也留下。
 * 整段对话另存，点进去再翻。
 */

const STORAGE_KEY = "companion.talk";
const MAX_STORED_LINES = 400;

export type TalkLine = {
  id: number;
  speaker: string;
  text: string;
  fromCompanion: boolean;
};

export type TalkDraft = {
  id: string;
  startedAt: string;
  lines: TalkLine[];
  unfinished: string;
};

export type LastTalk = {
  id: string;
  startedAt: string;
  endedAt: string;
  lines: TalkLine[];
  stoppedOn: string;
  unfinished: string;
};

type StoredTalk = {
  previous: LastTalk | null;
  draft: TalkDraft | null;
};

export function sentenceLooksFinished(text: string): boolean {
  const trimmed = text.trim();

  if (!trimmed) return false;

  return /[。！？…!?]$/.test(trimmed);
}

export function createDraft(): TalkDraft {
  return {
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}`,
    startedAt: new Date().toISOString(),
    lines: [],
    unfinished: "",
  };
}

export function readPreviousTalk(): LastTalk | null {
  return readStored().previous;
}

/** 页面重新打开时，没挂断就中断的连线收成上一次。 */
export function settleStoredTalk(): LastTalk | null {
  const stored = readStored();
  const draft = stored.draft;

  if (!draft || draft.lines.length === 0) {
    if (draft) {
      stored.draft = null;
      writeStored(stored);
    }

    return stored.previous;
  }

  stored.previous = toLastTalk(draft);
  stored.draft = null;
  writeStored(stored);

  return stored.previous;
}

export function saveDraft(draft: TalkDraft): void {
  const stored = readStored();

  stored.draft = {
    ...draft,
    lines: draft.lines.slice(-MAX_STORED_LINES),
  };
  writeStored(stored);
}

export function finishDraft(draft: TalkDraft): LastTalk | null {
  const stored = readStored();

  if (draft.lines.length === 0) {
    stored.draft = null;
    writeStored(stored);
    return stored.previous;
  }

  const finished = toLastTalk(draft);

  stored.previous = finished;
  stored.draft = null;
  writeStored(stored);

  return finished;
}

export function clearDraft(): void {
  const stored = readStored();

  if (!stored.draft) return;

  stored.draft = null;
  writeStored(stored);
}

function toLastTalk(draft: TalkDraft): LastTalk {
  const last = draft.lines[draft.lines.length - 1];
  const stoppedOn = last?.text.trim() ?? "";
  let unfinished = draft.unfinished.trim();

  if (
    !unfinished &&
    last?.fromCompanion &&
    !sentenceLooksFinished(last.text)
  ) {
    unfinished = last.text.trim();
  }

  return {
    id: draft.id,
    startedAt: draft.startedAt,
    endedAt: new Date().toISOString(),
    lines: draft.lines.slice(-MAX_STORED_LINES),
    stoppedOn,
    unfinished,
  };
}

function readStored(): StoredTalk {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);

    if (!raw) return { previous: null, draft: null };

    const data: unknown = JSON.parse(raw);

    if (!data || typeof data !== "object") {
      return { previous: null, draft: null };
    }

    const record = data as { previous?: unknown; draft?: unknown };

    return {
      previous: parseLastTalk(record.previous),
      draft: parseDraft(record.draft),
    };
  } catch (error) {
    console.warn("[Talk] read failed:", error);
    return { previous: null, draft: null };
  }
}

function writeStored(stored: StoredTalk): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch (error) {
    console.warn("[Talk] save failed:", error);
  }
}

function parseLastTalk(value: unknown): LastTalk | null {
  if (!value || typeof value !== "object") return null;

  const talk = value as Partial<LastTalk>;

  if (typeof talk.id !== "string" || !Array.isArray(talk.lines)) return null;

  const lines = talk.lines.flatMap(parseLine);

  if (lines.length === 0) return null;

  return {
    id: talk.id,
    startedAt: typeof talk.startedAt === "string" ? talk.startedAt : "",
    endedAt: typeof talk.endedAt === "string" ? talk.endedAt : "",
    lines,
    stoppedOn: typeof talk.stoppedOn === "string" ? talk.stoppedOn : "",
    unfinished: typeof talk.unfinished === "string" ? talk.unfinished : "",
  };
}

function parseDraft(value: unknown): TalkDraft | null {
  if (!value || typeof value !== "object") return null;

  const draft = value as Partial<TalkDraft>;

  if (typeof draft.id !== "string" || !Array.isArray(draft.lines)) return null;

  return {
    id: draft.id,
    startedAt: typeof draft.startedAt === "string" ? draft.startedAt : "",
    lines: draft.lines.flatMap(parseLine),
    unfinished: typeof draft.unfinished === "string" ? draft.unfinished : "",
  };
}

function parseLine(value: unknown): TalkLine[] {
  if (!value || typeof value !== "object") return [];

  const line = value as Partial<TalkLine>;

  if (typeof line.text !== "string" || !line.text.trim()) return [];

  return [
    {
      id: typeof line.id === "number" ? line.id : 0,
      speaker: typeof line.speaker === "string" ? line.speaker : "",
      text: line.text,
      fromCompanion: line.fromCompanion === true,
    },
  ];
}
