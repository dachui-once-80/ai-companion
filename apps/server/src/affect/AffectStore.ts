import { eq } from "drizzle-orm";
import { db } from "../db";
import { companionAffect } from "../db/schema";
import {
  applyAppraisal,
  baselineAffect,
  describeMood,
  isCompanionEmotion,
  project,
  reunionImpulse,
  REUNION_GAP_MS,
  shift,
  type AffectState,
  type CompanionEmotion,
  type UtteranceAppraisal,
} from "./affect";

const AFFECT_ID = "main";

export type AffectSnapshot = {
  expression: CompanionEmotion;
  cause: string;
  mood: string;
  updatedAt: string;
  lastSeenAt: string;
};

type AffectRow = {
  state: AffectState;
  lastSeenAt: string;
};

export class AffectStore {
  resume(nowMs = Date.now()): AffectSnapshot {
    const row = this.read();
    const previousSeenAt = row.lastSeenAt;
    const elapsedSinceSeen = elapsedSince(previousSeenAt, nowMs);
    let next = project(row.state, nowMs);
    let lastSeenAt = previousSeenAt;

    if (elapsedSinceSeen >= REUNION_GAP_MS) {
      next = shift(next, reunionImpulse(next.cause), nowMs);
      lastSeenAt = new Date(nowMs).toISOString();
    }

    const saved = this.commit(next, lastSeenAt);

    // 库里的时间在隔了三小时后会改成现在，用来挡住下一次心情脉冲。
    // 这一次交出去的仍是连上之前记下的 lastSeenAt，会话才能知道空档。
    return { ...saved, lastSeenAt: previousSeenAt };
  }

  settle(nowMs = Date.now()): AffectSnapshot {
    const row = this.read();
    return this.commit(project(row.state, nowMs), row.lastSeenAt);
  }

  noteSeen(nowMs = Date.now()): AffectSnapshot {
    const row = this.read();
    return this.commit(
      project(row.state, nowMs),
      new Date(nowMs).toISOString(),
    );
  }

  follow(
    appraisal: UtteranceAppraisal,
    nowMs = Date.now(),
  ): AffectSnapshot {
    const row = this.read();
    const next = applyAppraisal(row.state, appraisal, nowMs);

    return this.commit(next, new Date(nowMs).toISOString());
  }

  peekCause(): string {
    return this.read().state.cause;
  }

  private read(): AffectRow {
    const existing = db
      .select()
      .from(companionAffect)
      .where(eq(companionAffect.id, AFFECT_ID))
      .get();

    if (existing) {
      return {
        state: toState(existing),
        lastSeenAt: existing.lastSeenAt,
      };
    }

    const created = baselineAffect();
    const lastSeenAt = created.updatedAt;

    db.insert(companionAffect)
      .values({
        id: AFFECT_ID,
        ...toRow(created, lastSeenAt),
      })
      .run();

    return { state: created, lastSeenAt };
  }

  private commit(state: AffectState, lastSeenAt: string): AffectSnapshot {
    const previous = db
      .select()
      .from(companionAffect)
      .where(eq(companionAffect.id, AFFECT_ID))
      .get();

    db.update(companionAffect)
      .set(toRow(state, lastSeenAt))
      .where(eq(companionAffect.id, AFFECT_ID))
      .run();

    if (
      !previous ||
      previous.expression !== state.expression ||
      previous.cause !== state.cause
    ) {
      console.log(
        "[Affect]",
        state.expression,
        state.cause || "(settled)",
      );
    }

    return {
      expression: state.expression,
      cause: state.cause,
      mood: describeMood(state),
      updatedAt: state.updatedAt,
      lastSeenAt,
    };
  }
}

export const affectStore = new AffectStore();

function toState(row: {
  valence: number;
  arousal: number;
  warmth: number;
  curiosity: number;
  cause: string;
  expression: string;
  updatedAt: string;
}): AffectState {
  return {
    valence: finite(row.valence, baselineAffect().valence),
    arousal: finite(row.arousal, baselineAffect().arousal),
    warmth: finite(row.warmth, baselineAffect().warmth),
    curiosity: finite(row.curiosity, 0),
    cause: row.cause ?? "",
    expression: isCompanionEmotion(row.expression)
      ? row.expression
      : "calm",
    updatedAt: row.updatedAt,
  };
}

function toRow(state: AffectState, lastSeenAt: string) {
  return {
    valence: state.valence,
    arousal: state.arousal,
    warmth: state.warmth,
    curiosity: state.curiosity,
    cause: state.cause,
    expression: state.expression,
    updatedAt: state.updatedAt,
    lastSeenAt,
  };
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function elapsedSince(iso: string, nowMs: number): number {
  const parsed = Date.parse(iso);

  if (!Number.isFinite(parsed)) return 0;

  return Math.max(0, nowMs - parsed);
}
