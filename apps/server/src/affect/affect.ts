export type CompanionEmotion =
  | "calm"
  | "happy"
  | "caring"
  | "curious";

export type AffectState = {
  valence: number;
  arousal: number;
  warmth: number;
  curiosity: number;
  cause: string;
  expression: CompanionEmotion;
  updatedAt: string;
};

export type AffectImpulse = {
  valence: number;
  arousal: number;
  warmth: number;
  curiosity: number;
  cause: string;
};

export type AffectRelation = "shift" | "continue" | "neutral";

export type UtteranceAppraisal = {
  relation: AffectRelation;
  impulse: AffectImpulse;
};

export const BASELINE = {
  valence: 0.08,
  arousal: 0.22,
  warmth: 0.4,
  curiosity: 0,
} as const;

const HALF_LIFE_MS = {
  valence: 90 * 60 * 1000,
  arousal: 12 * 60 * 1000,
  warmth: 72 * 60 * 60 * 1000,
  curiosity: 3 * 60 * 1000,
} as const;

const EXPRESSION_MARGIN = 0.08;

export const REUNION_GAP_MS = 3 * 60 * 60 * 1000;

export function baselineAffect(nowMs = Date.now()): AffectState {
  return {
    valence: BASELINE.valence,
    arousal: BASELINE.arousal,
    warmth: BASELINE.warmth,
    curiosity: BASELINE.curiosity,
    cause: "",
    expression: "calm",
    updatedAt: new Date(nowMs).toISOString(),
  };
}

export function project(state: AffectState, nowMs: number): AffectState {
  const elapsed = elapsedMs(state.updatedAt, nowMs);
  const draft: AffectState = {
    ...state,
    valence: decayToward(
      state.valence,
      BASELINE.valence,
      elapsed,
      HALF_LIFE_MS.valence,
    ),
    arousal: decayToward(
      state.arousal,
      BASELINE.arousal,
      elapsed,
      HALF_LIFE_MS.arousal,
    ),
    warmth: decayToward(
      state.warmth,
      BASELINE.warmth,
      elapsed,
      HALF_LIFE_MS.warmth,
    ),
    curiosity: decayToward(
      state.curiosity,
      BASELINE.curiosity,
      elapsed,
      HALF_LIFE_MS.curiosity,
    ),
    updatedAt: new Date(nowMs).toISOString(),
  };

  draft.cause = freshenCause(draft);
  draft.expression = deriveExpression(draft);
  return draft;
}

export function shift(
  state: AffectState,
  impulse: AffectImpulse,
  nowMs: number,
): AffectState {
  const draft: AffectState = {
    ...state,
    valence: clamp(state.valence + impulse.valence, -1, 1),
    arousal: clamp(state.arousal + impulse.arousal, 0, 1),
    warmth: clamp(state.warmth + impulse.warmth, 0, 1),
    curiosity: clamp(state.curiosity + impulse.curiosity, 0, 1),
    cause: impulse.cause.trim() || state.cause,
    updatedAt: new Date(nowMs).toISOString(),
  };

  draft.expression = deriveExpression(draft);
  return draft;
}

export function retarget(
  state: AffectState,
  impulse: AffectImpulse,
  nowMs: number,
): AffectState {
  const draft: AffectState = {
    ...state,
    valence: clamp(BASELINE.valence + impulse.valence, -1, 1),
    arousal: clamp(BASELINE.arousal + impulse.arousal, 0, 1),
    warmth: clamp(state.warmth + impulse.warmth, 0, 1),
    curiosity: clamp(impulse.curiosity, 0, 1),
    cause: impulse.cause.trim(),
    updatedAt: new Date(nowMs).toISOString(),
  };

  draft.expression = deriveExpression(draft, false);
  return draft;
}

export function shouldRetarget(
  state: AffectState,
  appraisal: UtteranceAppraisal,
): boolean {
  const { relation, impulse } = appraisal;

  if (isNegligible(impulse)) return false;
  if (relation === "shift") return true;

  const lift = state.valence - BASELINE.valence;

  return (
    lift * impulse.valence < 0 &&
    Math.abs(lift) >= 0.08 &&
    Math.abs(impulse.valence) >= 0.1
  );
}

export function applyAppraisal(
  state: AffectState,
  appraisal: UtteranceAppraisal,
  nowMs: number,
): AffectState {
  const projected = project(state, nowMs);

  if (isNegligible(appraisal.impulse)) return projected;

  return shouldRetarget(projected, appraisal)
    ? retarget(projected, appraisal.impulse, nowMs)
    : shift(projected, appraisal.impulse, nowMs);
}

export function reunionImpulse(existingCause: string): AffectImpulse {
  return {
    valence: 0.16,
    arousal: 0.12,
    warmth: 0.06,
    curiosity: 0,
    cause: existingCause.trim() ? "" : "又见面了",
  };
}

export function clampImpulse(impulse: AffectImpulse): AffectImpulse {
  return {
    valence: clamp(impulse.valence, -0.4, 0.4),
    arousal: clamp(impulse.arousal, -0.2, 0.45),
    warmth: clamp(impulse.warmth, -0.08, 0.18),
    curiosity: clamp(impulse.curiosity, 0, 0.9),
    cause: clipCause(impulse.cause),
  };
}

export function isNegligible(impulse: AffectImpulse): boolean {
  return (
    Math.abs(impulse.valence) < 0.045 &&
    Math.abs(impulse.arousal) < 0.045 &&
    Math.abs(impulse.warmth) < 0.025 &&
    impulse.curiosity < 0.12
  );
}

export function describeMood(state: AffectState): string {
  const valenceLift = state.valence - BASELINE.valence;
  const warmthLift = state.warmth - BASELINE.warmth;
  const arousalLift = state.arousal - BASELINE.arousal;

  let tone = "心情接近平时";

  if (valenceLift > 0.18) {
    tone = "心里还亮着，没完全平下来";
  } else if (valenceLift > 0.08) {
    tone = "心情比平时松快一点";
  } else if (valenceLift < -0.18) {
    tone = "心里还沉着";
  } else if (valenceLift < -0.08) {
    tone = "有一点放心不下";
  }

  const extra: string[] = [];

  if (warmthLift > 0.08) {
    extra.push("对这个人还留着亲近");
  }

  if (arousalLift > 0.18) {
    extra.push("语气还带着刚才的起伏");
  }

  if (state.curiosity > 0.45) {
    extra.push("还想把刚才的话题再听下去");
  }

  const toneLine =
    extra.length > 0
      ? `${tone}，${extra.join("，")}。`
      : `${tone}。`;
  const cause = state.cause.trim();
  const causeLine = cause
    ? `留着的原因是：${cause}。`
    : "没有一件特别的事压在心上。";

  return `${toneLine}${causeLine}`;
}

export function isCompanionEmotion(
  value: string,
): value is CompanionEmotion {
  return (
    value === "calm" ||
    value === "happy" ||
    value === "caring" ||
    value === "curious"
  );
}

function deriveExpression(
  state: AffectState,
  holdPrevious = true,
): CompanionEmotion {
  const scores = expressionScores(state);
  let best: CompanionEmotion = "calm";

  for (const emotion of ["happy", "caring", "curious"] as const) {
    if (scores[emotion] > scores[best]) {
      best = emotion;
    }
  }

  const current = state.expression;

  if (
    holdPrevious &&
    current !== best &&
    scores[current] + EXPRESSION_MARGIN >= scores[best]
  ) {
    return current;
  }

  return best;
}

function expressionScores(
  state: AffectState,
): Record<CompanionEmotion, number> {
  const valenceLift = state.valence - BASELINE.valence;
  const warmthLift = state.warmth - BASELINE.warmth;
  const happy = clamp01((valenceLift - 0.06) / 0.2);
  const caring = Math.max(
    clamp01((warmthLift - 0.06) / 0.12) *
      clamp01(0.15 - valenceLift),
    clamp01((-0.06 - valenceLift) / 0.14),
  );
  const curious = clamp01((state.curiosity - 0.28) / 0.4);

  return {
    calm: 0.36,
    happy,
    caring,
    curious,
  };
}

function freshenCause(state: AffectState): string {
  if (!state.cause.trim()) return "";

  const carrying =
    Math.abs(state.valence - BASELINE.valence) > 0.05 ||
    state.warmth - BASELINE.warmth > 0.08 ||
    state.arousal - BASELINE.arousal > 0.1 ||
    state.curiosity > 0.2;

  return carrying ? state.cause : "";
}

function decayToward(
  value: number,
  baseline: number,
  elapsedMs: number,
  halfLifeMs: number,
): number {
  if (elapsedMs <= 0) return value;

  const factor = Math.exp((-elapsedMs / halfLifeMs) * Math.LN2);
  return baseline + (value - baseline) * factor;
}

function elapsedMs(updatedAt: string, nowMs: number): number {
  const parsed = Date.parse(updatedAt);

  if (!Number.isFinite(parsed)) return 0;

  return Math.max(0, nowMs - parsed);
}

function clipCause(cause: string): string {
  const trimmed = cause.replace(/[\r\n]+/g, "").trim();
  const clipped = Array.from(trimmed).slice(0, 24).join("");

  if (
    /^(calm|happy|caring|curious|开心|平静|好奇|关怀|温柔)$/.test(
      clipped,
    )
  ) {
    return "";
  }

  return clipped;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
