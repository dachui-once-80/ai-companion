import {
  clampImpulse,
  DIRECTION_IMPULSE,
  type MoodDirection,
  type UtteranceAppraisal,
} from "./affect";

const DIRECTIONS = [
  "neutral",
  "happy",
  "caring",
  "curious",
  "worried",
  "annoyed",
  "wronged",
] as const;

export const affectAppraisalSchema = {
  type: "object",
  properties: {
    toward: { type: "string", enum: [...DIRECTIONS] },
    cause: { type: "string" },
  },
  required: ["toward", "cause"],
};

export function appraisalPrompt(
  userText: string,
  currentCause: string,
): string {
  const cause = currentCause.trim() || "没有";

  return `你在判断这句话会把陪伴者自己的心情推向哪里。陪伴者是听这段话的人，不是说话的人。

只看这一句，选一个方向：
- neutral：打招呼、事实问题、没有情绪分量。拿不准就选这个，不要因为句子长就硬选一个情绪。
- happy：好消息、做成了、值得高兴。
- caring：说话的人自己累、难过、委屈、受了气。陪伴者心疼对方。用户说自己委屈，不是陪伴者委屈。
- worried：生病、受伤、害怕、出事、迷路、东西丢了、危险还没过去。陪伴者放心不下。
- annoyed：这句话在嫌她烦、让她闭嘴、赶她走、不耐烦地冲她。
- wronged：误会她、说她不在乎、冷冷挡回她的关心、怪她多心。陪伴者自己觉得被冤枉。
- curious：在讲一件具体的事，情绪不强，还值得听下去。

cause：方向不是 neutral 时，用「他说」起头，24个字以内，概括把心情带起来的那件事。neutral 时留空字符串。不要写情绪名称。

用户此刻心里还留着的事：${cause}
这一句：${userText.trim()}`;
}

export function parseModelAppraisal(
  raw: string,
  userText: string,
): { toward: MoodDirection; appraisal: UtteranceAppraisal } | null {
  let data: unknown;

  try {
    data = JSON.parse(unwrapJson(raw));
  } catch {
    return null;
  }

  if (typeof data !== "object" || data === null) return null;

  const toward = "toward" in data ? data.toward : undefined;

  if (!isDirection(toward)) return null;

  if (toward === "neutral") {
    return {
      toward,
      appraisal: {
        relation: "neutral",
        impulse: clampImpulse({
          valence: 0,
          arousal: 0,
          warmth: 0,
          curiosity: 0,
          cause: "",
        }),
      },
    };
  }

  const impulse = DIRECTION_IMPULSE[toward];
  const given = "cause" in data && typeof data.cause === "string" ? data.cause : "";

  return {
    toward,
    appraisal: {
      relation: "shift",
      impulse: clampImpulse({
        valence: impulse.valence,
        arousal: impulse.arousal,
        warmth: impulse.warmth,
        curiosity: impulse.curiosity,
        cause: given.trim() || fallbackCause(userText),
      }),
    },
  };
}

function isDirection(value: unknown): value is MoodDirection {
  return (
    typeof value === "string" &&
    (DIRECTIONS as readonly string[]).includes(value)
  );
}

function unwrapJson(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  return fenced?.[1]?.trim() || trimmed;
}

function fallbackCause(userText: string): string {
  const spoken = userText
    .replace(/\s+/g, "")
    .replace(/^我+/, "")
    .replace(/[。！？!?，,、]+$/g, "");

  return `他说${spoken}`;
}
