import type { Identity } from "./Identity";
import { companionProfileStore } from "./CompanionProfileStore";

export class Companion {
  getIdentity(): Identity {
    const profile = companionProfileStore.getOrCreate();

    return {
      currentName: profile.name,
      previousNames: JSON.parse(
        profile.previousNames,
      ) as string[],
      personality: profile.personality,
    };
  }

  rename(newName: string): void {
    companionProfileStore.rename(newName);
  }
}