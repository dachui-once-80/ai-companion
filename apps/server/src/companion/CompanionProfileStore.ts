import { eq } from "drizzle-orm";
import { db } from "../db";
import { companionProfile } from "../db/schema";

const PROFILE_ID = "main";

const DEFAULT_NAME = "阿七";

const DEFAULT_PERSONALITY =
  "热情、真诚、温暖、幽默。善于倾听，不轻易评判别人。" +
  "回答问题时自然直接，安慰别人时先理解对方的感受。";

export class CompanionProfileStore {
  getOrCreate() {
    const existing = db
      .select()
      .from(companionProfile)
      .where(eq(companionProfile.id, PROFILE_ID))
      .get();

    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();

    db.insert(companionProfile)
      .values({
        id: PROFILE_ID,
        name: DEFAULT_NAME,
        previousNames: "[]",
        personality: DEFAULT_PERSONALITY,
        updatedAt: now,
      })
      .run();

    return db
      .select()
      .from(companionProfile)
      .where(eq(companionProfile.id, PROFILE_ID))
      .get()!;
  }

  rename(newName: string) {
    const name = newName.trim();

    if (!name) {
      throw new Error("Name cannot be empty");
    }

    if (name.length > 30) {
      throw new Error("Name cannot exceed 30 characters");
    }

    const current = this.getOrCreate();

    if (current.name === name) {
      return current;
    }

    const previousNames: string[] = JSON.parse(
      current.previousNames,
    );

    if (!previousNames.includes(current.name)) {
      previousNames.push(current.name);
    }

    db.update(companionProfile)
      .set({
        name,
        previousNames: JSON.stringify(previousNames),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(companionProfile.id, PROFILE_ID))
      .run();

    return this.getOrCreate();
  }
}

export const companionProfileStore =
  new CompanionProfileStore();