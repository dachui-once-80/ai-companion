import type { Identity } from "./Identity";
import { PERSONA } from "./Persona";
import { companionProfileStore } from "./CompanionProfileStore";

export class Companion {
  getIdentity(): Identity {
    const profile = companionProfileStore.getOrCreate();

    return {
      currentName: profile.name,
      previousNames: JSON.parse(
        profile.previousNames,
      ) as string[],
      persona: PERSONA,
    };
  }

  rename(newName: string): void {
    companionProfileStore.rename(newName);
  }
}