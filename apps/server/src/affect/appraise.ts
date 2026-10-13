import {
  clampImpulse,
  type UtteranceAppraisal,
} from "./affect";

const EMPTY_IMPULSE = {
  valence: 0,
  arousal: 0,
  warmth: 0,
  curiosity: 0,
  cause: "",
};

const NEGATIVE =
  /讨厌|厌烦|烦死|好烦|心烦|好累|累死|难过|伤心|委屈|失落|难受|不开心|糟糕|倒霉|生气|气死|崩溃|受不了/;

const HEAVY =
  /好累|累死|难过|伤心|委屈|失落|难受|崩溃/;

const POSITIVE =
  /好开心|太好了|太棒了|好高兴|通过了|考过|成功了|真不错|好消息|好喜欢/;

export function appraiseLocally(
  userText: string,
  currentCause: string,
): UtteranceAppraisal {
  const text = userText.replace(/\s+/g, "").trim();
  const cause = currentCause.trim();
  const negative = NEGATIVE.test(text);
  const positive = POSITIVE.test(text);
  const sameTopic = sharesTopic(text, cause);

  if (!negative && !positive) {
    return {
      relation: sameTopic ? "continue" : "neutral",
      impulse: EMPTY_IMPULSE,
    };
  }

  if (sameTopic && negative === positive) {
    return {
      relation: "continue",
      impulse: EMPTY_IMPULSE,
    };
  }

  if (negative && !positive) {
    const heavy = HEAVY.test(text);

    return {
      relation: "shift",
      impulse: clampImpulse({
        valence: heavy ? -0.2 : -0.08,
        arousal: heavy ? 0.1 : 0.08,
        warmth: heavy ? 0.12 : 0,
        curiosity: 0,
        cause: toCause(text),
      }),
    };
  }

  return {
    relation: "shift",
    impulse: clampImpulse({
      valence: 0.28,
      arousal: 0.2,
      warmth: 0.08,
      curiosity: 0.04,
      cause: toCause(text),
    }),
  };
}

function sharesTopic(text: string, cause: string): boolean {
  const body = cause.replace(/^他?说/, "");

  if (body.length < 2) return false;

  for (let index = 0; index < body.length - 1; index += 1) {
    const gram = body.slice(index, index + 2);

    if (text.includes(gram)) return true;
  }

  return false;
}

function toCause(text: string): string {
  const spoken = text.replace(/^我+/, "");
  return `他说${spoken}`;
}
