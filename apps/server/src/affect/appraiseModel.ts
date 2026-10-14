import {
  clampImpulse,
  DIRECTION_IMPULSE,
  type CompanionEmotion,
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

const TOWARD = [...DIRECTIONS, "repair"] as const;

export type AppraisalToward = (typeof TOWARD)[number];

export const affectAppraisalSchema = {
  type: "object",
  properties: {
    toward: { type: "string", enum: [...TOWARD] },
    cause: { type: "string" },
  },
  required: ["toward", "cause"],
};

export function appraisalPrompt(
  userText: string,
  currentCause: string,
  expression: CompanionEmotion = "calm",
): string {
  const cause = currentCause.trim() || "没有";
  const friction = expression === "annoyed" || expression === "wronged";
  const frictionLines = friction
    ? `
她现在还烦着或委屈着，原因还在。
- repair：这句话在解释、承认刚才那句重了，或认真把话说清楚。这是往回修一档，不是换一件新的事。
- 还在顶她、还在误会她：选 annoyed 或 wronged。这是加深，不是换成另一件事。
- 换成轻松话题，或说起另一件开心、心疼、好奇、担心的事：选 neutral。不要用新话题把这阵心情清掉。
`
    : `
现在不是烦或委屈。不要选 repair。
`;

  return `你在判断这句话会把陪伴者自己的心情推向哪里。陪伴者是听这段话的人，不是说话的人。

只看这一句，选一个方向：
- neutral：打招呼、事实问题、没有情绪分量。拿不准就选这个，不要因为句子长就硬选一个情绪。
- happy：好消息、做成了、值得高兴。
- caring：说话的人自己累、难过、委屈、受了气。陪伴者心疼对方。用户说自己委屈，不是陪伴者委屈。
- worried：生病、受伤、害怕、出事、迷路、东西丢了、危险还没过去。陪伴者放心不下。
- annoyed：这句话在嫌她烦、让她闭嘴、赶她走、不耐烦地冲她。
- wronged：误会她、说她不在乎、冷冷挡回她的关心、怪她多心。陪伴者自己觉得被冤枉。
- curious：在讲一件具体的事，情绪不强，还值得听下去。
- repair：只有她还烦着或委屈着，并且对方在解释、承认刚才那句重了、或认真把话说清楚时才选。
${frictionLines}
cause：方向不是 neutral、也不是 repair 时，用「他说」起头，24个字以内，概括把心情带起来的那件事。neutral 和 repair 时留空字符串。不要写情绪名称。

用户此刻心里还留着的事：${cause}
这一句：${userText.trim()}`;
}

export function parseModelAppraisal(
  raw: string,
  userText: string,
): { toward: AppraisalToward; appraisal: UtteranceAppraisal } | null {
  let data: unknown;

  try {
    data = JSON.parse(unwrapJson(raw));
  } catch {
    return null;
  }

  if (typeof data !== "object" || data === null) return null;

  const toward = "toward" in data ? data.toward : undefined;

  if (!isToward(toward)) return null;

  if (toward === "repair") {
    return {
      toward,
      appraisal: {
        relation: "repair",
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

function isToward(value: unknown): value is AppraisalToward {
  return (
    typeof value === "string" &&
    (TOWARD as readonly string[]).includes(value)
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
