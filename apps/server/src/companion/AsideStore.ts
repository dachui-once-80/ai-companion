import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { companionAsides, companionAsideSpoken, companionVoice } from "../db/schema";
import type { MatterRef } from "./reunion";

const CURRENT_ID = "current";
const VOICE_ID = "main";

export type StoredAside = {
  text: string;
  leftAt: string;
  matterKey: string;
  matterRevision: string;
  heard: boolean;
};

/**
 * 当前这一句，和已经留过的事。
 * 留过的版本还在，所以同一件事在内容再变之前不会再留。
 */
export class AsideStore {
  current(): StoredAside | null {
    const row = db
      .select()
      .from(companionAsides)
      .where(eq(companionAsides.id, CURRENT_ID))
      .get();

    if (!row) return null;

    return {
      text: row.body,
      leftAt: row.leftAt,
      matterKey: row.matterKey,
      matterRevision: row.matterRevision,
      heard: row.heard === "true",
    };
  }

  spoken(): MatterRef[] {
    return db
      .select()
      .from(companionAsideSpoken)
      .all()
      .map((row) => ({
        key: row.matterKey,
        revision: row.matterRevision,
      }));
  }

  awayAt(): string | null {
    const row = db
      .select()
      .from(companionVoice)
      .where(eq(companionVoice.id, VOICE_ID))
      .get();

    const leftAt = row?.leftAt.trim() ?? "";

    return leftAt.length > 0 ? leftAt : null;
  }

  /** 语音断开，或还没记过断开时间时，用这个时间算空档。 */
  setAwayAt(leftAt: string): void {
    const existing = db
      .select()
      .from(companionVoice)
      .where(eq(companionVoice.id, VOICE_ID))
      .get();

    if (existing) {
      db.update(companionVoice)
        .set({ leftAt })
        .where(eq(companionVoice.id, VOICE_ID))
        .run();
      return;
    }

    db.insert(companionVoice).values({ id: VOICE_ID, leftAt }).run();
  }

  leave(input: {
    text: string;
    leftAt: string;
    matterKey: string;
    matterRevision: string;
  }): void {
    this.remember(input.matterKey, input.matterRevision, input.leftAt);

    const existing = db
      .select({ id: companionAsides.id })
      .from(companionAsides)
      .where(eq(companionAsides.id, CURRENT_ID))
      .get();

    const row = {
      body: input.text,
      leftAt: input.leftAt,
      matterKey: input.matterKey,
      matterRevision: input.matterRevision,
      heard: "false",
    };

    if (existing) {
      db.update(companionAsides)
        .set(row)
        .where(eq(companionAsides.id, CURRENT_ID))
        .run();
      return;
    }

    db.insert(companionAsides)
      .values({ id: CURRENT_ID, ...row })
      .run();
  }

  hasSpoken(matterKey: string, matterRevision: string): boolean {
    const existing = db
      .select({ matterKey: companionAsideSpoken.matterKey })
      .from(companionAsideSpoken)
      .where(
        and(
          eq(companionAsideSpoken.matterKey, matterKey),
          eq(companionAsideSpoken.matterRevision, matterRevision),
        ),
      )
      .get();

    return Boolean(existing);
  }

  /** 语音里已经说过。不改页面上留下的那一句。 */
  noteSpoken(matterKey: string, matterRevision: string): void {
    this.remember(matterKey, matterRevision, new Date().toISOString());
  }

  /** 语音连上之后，这一句算她已经说过。页面上仍留着，给用户读。 */
  markHeard(): void {
    db.update(companionAsides)
      .set({ heard: "true" })
      .where(eq(companionAsides.id, CURRENT_ID))
      .run();
  }

  private remember(matterKey: string, matterRevision: string, spokenAt: string): void {
    const existing = db
      .select({ matterKey: companionAsideSpoken.matterKey })
      .from(companionAsideSpoken)
      .where(
        and(
          eq(companionAsideSpoken.matterKey, matterKey),
          eq(companionAsideSpoken.matterRevision, matterRevision),
        ),
      )
      .get();

    if (existing) return;

    db.insert(companionAsideSpoken)
      .values({ matterKey, matterRevision, spokenAt })
      .run();
  }
}

export const asideStore = new AsideStore();
