import { PERSONA, type Persona } from "./Persona";

export const DEFAULT_COMPANION_NAME = "阿七";

export type Identity = {
  currentName: string;
  previousNames: string[];
  persona: Persona;
};

export const defaultIdentity: Identity = {
  currentName: DEFAULT_COMPANION_NAME,
  previousNames: [],
  persona: PERSONA,
};
