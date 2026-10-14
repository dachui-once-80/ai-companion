import {
  clampImpulse,
  DIRECTION_IMPULSE,
  type AffectRelation,
  type CompanionEmotion,
  type UtteranceAppraisal,
} from "./affect";

export type LocalAppraisal = {
  appraisal: UtteranceAppraisal;
  confident: boolean;
};

const LONG_SPOKEN = 20;

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

const CARE_CUES = [
  "担心你",
  "放心不下",
  "心疼",
  "想你了",
  "陪着你",
  "陪你",
  "照顾你",
  "你辛苦",
  "辛苦了",
  "注意身体",
  "路上小心",
  "早点睡",
  "早点休息",
  "好好休息",
  "别熬夜",
  "别太拼",
  "别太累",
  "记得吃",
  "记得休息",
  "多喝水",
  "穿暖",
  "我等你",
  "我帮你",
  "保重",
  "替你担心",
  "为你担心",
];

const ANNOY_CUES = [
  "你好烦",
  "好烦你",
  "你烦不烦",
  "你真烦",
  "烦死你",
  "你很烦",
  "闭嘴",
  "少废话",
  "别烦我",
  "吵死",
  "太啰嗦",
  "好啰嗦",
  "懒得理你",
  "有完没完",
  "有病吧",
  "神经吧",
  "滚开",
  "滚一边",
  "少来这套",
  "随便你",
  "拉倒吧",
  "打住",
];

const WRONGED_CUES = [
  "你想多了",
  "你想太多",
  "你误会",
  "你不在乎我",
  "你是不是不在乎",
  "你都不管我",
  "你根本没听",
  "你都没在听",
  "你心里没有我",
  "你怎么这样对我",
  "你凭什么",
  "假好心",
  "你少装",
  "你根本不懂我",
  "你都不懂我",
  "你把我当",
  "你冤枉",
];

const WORRY_CUES = [
  "害怕",
  "好怕",
  "吓死",
  "吓到",
  "出事",
  "受伤",
  "住院",
  "发烧",
  "生病",
  "病了",
  "迷路",
  "危险",
  "找不到",
  "丢了",
  "被骗",
  "手术",
  "急救",
  "心慌",
  "不安",
];

const PUSH_CUES = [
  "搞错",
  "误会了",
  "听错了",
  "理解错",
  "理解偏",
  "说错了",
  "想歪了",
  "不是这个意思",
  "不是那个意思",
  "我没有那个意思",
  "我没那个意思",
  "我没让你",
  "没叫你",
  "不是要你",
  "别再",
  "别这样",
  "别说了",
  "别顺着",
  "你别",
  "打住",
  "闭嘴",
  "少来",
  "随便你",
  "你想多了",
  "拉倒吧",
  "先停",
  "停一下",
  "到此为止",
  "不用你管",
  "你不用管",
  "别管",
  "你少管",
  "轮不到你",
];

const NEGATIVE_TONE = [
  "赶不上",
  "来不及",
  "错过",
  "没带",
  "失眠",
  "头疼",
  "头痛",
  "加班",
  "堵车",
  "被骂",
  "被批",
  "吵架",
  "迟到",
  "搞砸",
  "出错",
  "一个人",
  "空落",
  "没精神",
  "压力大",
  "只想躺",
  "倒头",
  "没顾上",
  "从早忙",
];

const POSITIVE_TONE = [
  "真好",
  "挺好",
  "不错",
  "好耶",
  "喜欢",
  "高兴",
  "顺利",
  "暖和",
  "笑了",
  "庆幸",
  "舒服",
  "轻松",
];

type Move = {
  valence: number;
  arousal: number;
  warmth: number;
  curiosity: number;
  relation: AffectRelation;
};

const REPAIR_CUES = [
  "我说重了",
  "说重了",
  "说得太重",
  "说太重",
  "我说得重",
  "对不起",
  "抱歉",
  "不好意思",
  "我道歉",
  "是我不好",
  "我太冲",
  "太冲了",
  "我不该那样",
  "我不该那么",
  "我收回",
  "当我没说",
  "我不是冲你",
  "不是冲你",
  "没想凶你",
  "不是要凶你",
  "我跟你解释",
  "听我解释",
  "我解释一下",
  "我说明一下",
  "我说清楚",
  "我讲清楚",
  "我跟你说清楚",
  "我没说清",
  "没说清楚",
  "是我没说清",
  "我太急了",
  "我刚才太急",
  "我态度不好",
  "我语气不好",
  "我重新说",
  "我再说清楚",
  "我重新讲",
  "听我说完",
  "是我的错",
  "我好好说",
];

const APOLOGY_MARKERS = ["对不起", "抱歉", "不好意思"];

export function appraiseLocally(
  userText: string,
  currentCause: string,
  expression: CompanionEmotion = "calm",
): LocalAppraisal {
  const text = userText.replace(/\s+/g, "").trim();

  if ([...text].length < 2) {
    return {
      confident: true,
      appraisal: { relation: "neutral", impulse: EMPTY_IMPULSE },
    };
  }

  const clauses = splitClauses(text);
  const lexical = lexicalMove(text);
  const push = pushbackStrength(text);
  const care = careStrength(text);
  const worry = worryStrength(text);
  const annoy = annoyStrength(text);
  const wronged = wrongedStrength(text);
  const story = storyStrength(text, clauses);
  const plainQuestion = isPlainQuestion(clauses);

  let move: Move;
  let confident = true;
  const friction = expression === "annoyed" || expression === "wronged";

  if (
    friction &&
    repairStrength(text) >= 0.55 &&
    annoy < 0.55 &&
    wronged < 0.55
  ) {
    return {
      confident: true,
      appraisal: { relation: "repair", impulse: EMPTY_IMPULSE },
    };
  }

  if (annoy >= 0.55) {
    move = directed("annoyed");
  } else if (wronged >= 0.55) {
    move = directed("wronged");
  } else if (worry >= 0.55) {
    move = directed("worried");
  } else if (plainQuestion && push < 0.55) {
    if (!lexical) {
      return {
        confident: spokenLength(text) < LONG_SPOKEN,
        appraisal: {
          relation: "continue",
          impulse: clampImpulse({
            valence: 0.02,
            arousal: 0.02,
            warmth: 0.01,
            curiosity: 0.06,
            cause: "",
          }),
        },
      };
    }

    move = scaleMove(lexical, 0.22);
    move.relation = "continue";
  } else if (lexical) {
    move = lexical;

    if (story >= 0.5) {
      move = {
        ...move,
        curiosity: move.curiosity + Math.min(0.28, story * 0.35),
      };
    }
  } else if (push >= 0.55) {
    move = {
      valence: -0.2,
      arousal: 0.16,
      warmth: -0.05,
      curiosity: 0.06,
      relation: "continue",
    };

    if (plainQuestion) move = scaleMove(move, 0.85);
  } else if (care >= 0.5) {
    move = {
      valence: 0.2,
      arousal: 0.1,
      warmth: 0.15,
      curiosity: 0.08,
      relation: "continue",
    };
  } else if (selfStrain(text) && story < 0.5) {
    move = {
      valence: -0.16,
      arousal: 0.11,
      warmth: 0.1,
      curiosity: 0.08,
      relation: "continue",
    };
  } else if (story >= 0.5) {
    const tint = toneNudge(text);
    const heavy = tint < 0;

    move = {
      valence: tint === 0 ? 0.05 : tint,
      arousal: 0.12,
      warmth: heavy ? 0.1 : 0.08,
      curiosity: heavy ? 0.36 : 0.52,
      relation: "continue",
    };
    confident = false;
  } else if (isPassage(text, clauses)) {
    move = {
      valence: 0.2,
      arousal: 0.1,
      warmth: 0.12,
      curiosity: 0.16,
      relation: "continue",
    };
    confident = false;
  } else {
    move = {
      valence: 0.05,
      arousal: 0.05,
      warmth: 0.04,
      curiosity: 0.08,
      relation: "continue",
    };
    confident = false;
  }

  if (repeatsCause(text, currentCause)) {
    move = scaleMove(move, 0.45);
    move.relation = "continue";
  }

  const memorable =
    Math.abs(move.valence) >= 0.08 ||
    move.warmth >= 0.08 ||
    move.arousal >= 0.1 ||
    move.curiosity >= 0.2;

  return {
    confident,
    appraisal: {
      relation: move.relation,
      impulse: clampImpulse({
        valence: move.valence,
        arousal: move.arousal,
        warmth: move.warmth,
        curiosity: move.curiosity,
        cause: memorable ? toCause(text) : "",
      }),
    },
  };
}

export function shouldConsultModel(
  userText: string,
  confident: boolean,
): boolean {
  if (confident) return false;

  const text = userText.replace(/\s+/g, "").trim();
  return spokenLength(text) >= LONG_SPOKEN;
}

function directed(key: "worried" | "annoyed" | "wronged"): Move {
  const impulse = DIRECTION_IMPULSE[key];

  return {
    valence: impulse.valence,
    arousal: impulse.arousal,
    warmth: impulse.warmth,
    curiosity: impulse.curiosity,
    relation: "shift",
  };
}

function lexicalMove(text: string): Move | null {
  const negative = NEGATIVE.test(text);
  const positive = POSITIVE.test(text);

  if (!negative && !positive) return null;
  if (negative && positive) return null;

  if (negative) {
    const heavy = HEAVY.test(text);

    return {
      valence: heavy ? -0.2 : -0.08,
      arousal: heavy ? 0.1 : 0.08,
      warmth: heavy ? 0.12 : 0,
      curiosity: 0,
      relation: "shift",
    };
  }

  return {
    valence: 0.28,
    arousal: 0.2,
    warmth: 0.08,
    curiosity: 0.04,
    relation: "shift",
  };
}

function repairStrength(text: string): number {
  const bodyCues = REPAIR_CUES.filter(
    (cue) => !APOLOGY_MARKERS.includes(cue),
  );
  let body = cueScore(text, bodyCues);

  if (/我.{0,8}(说清楚|讲清楚|解释|说重|太冲|太急|没说清)/.test(text)) {
    body = Math.max(body, 0.7);
  }

  const markerHit = APOLOGY_MARKERS.some((cue) => text.includes(cue));

  if (!markerHit) return body;

  const stripped = text.replace(/对不起|抱歉|不好意思/g, "");
  const question = body === 0 && looksLikeQuestion(stripped);

  if (question) return 0;

  return Math.min(1, body + 0.7);
}

function looksLikeQuestion(text: string): boolean {
  const clause = text.trim();

  if ([...clause].length < 2) return false;

  return isInterrogative(clause);
}

function annoyStrength(text: string): number {
  return Math.min(1, cueScore(text, ANNOY_CUES));
}

function wrongedStrength(text: string): number {
  let score = cueScore(text, WRONGED_CUES);

  if (/你[^他她]{0,6}不在乎/.test(text)) score += 0.7;
  if (/你[^他她]{0,6}不管我/.test(text)) score += 0.7;
  if (/你[^他她]{0,4}没(在)?听/.test(text)) score += 0.7;
  if (/你[^他她]{0,4}不懂我/.test(text)) score += 0.7;

  return Math.min(1, score);
}

function worryStrength(text: string): number {
  const aboutHer = text.replace(/担心你|替你担心|为你担心/g, "");
  let score = cueScore(aboutHer, WORRY_CUES);

  if (/我(好|很|特别|有点)?担心/.test(aboutHer)) score += 0.7;

  return Math.min(1, score);
}

function careStrength(text: string): number {
  if (/我[^你]{0,6}辛苦了/.test(text) && !/你辛苦|辛苦你/.test(text)) {
    return cueScore(text.replace(/我[^你]{0,6}辛苦了/g, ""), CARE_CUES);
  }

  let score = cueScore(text, CARE_CUES);

  if (/去.{0,8}(吃|睡|歇|热|喝).+吧/.test(text)) score += 0.5;
  if (/你.{0,8}(休息|吃饭|睡觉|喝水|小心)/.test(text)) score += 0.35;

  return Math.min(1, score);
}

function pushbackStrength(text: string): number {
  return Math.min(1, cueScore(text, PUSH_CUES));
}

function storyStrength(text: string, clauses: string[]): number {
  let score = 0;
  const length = spokenLength(text);

  if (length >= 16) score += 0.22;
  if (length >= 32) score += 0.2;
  if (/[0-9０-９]/.test(text) || /[一二两三四五六七八九十]{1,3}/.test(text)) {
    score += 0.16;
  }
  if (
    /今天|昨天|前天|刚才|早上|晚上|凌晨|中午|下午|上午|夜里|上周|这周|那天|小时|分钟/.test(
      text,
    )
  ) {
    score += 0.2;
  }
  if (
    /公司|地铁|公交|学校|医院|家里|楼下|楼道|店里|路上|车站|办公室|教室/.test(
      text,
    )
  ) {
    score += 0.16;
  }
  if (/然后|后来|接着|结果|最后|于是|回到|走到|赶到|出来/.test(text)) {
    score += 0.14;
  }
  if (/了/.test(text) && length >= 12) score += 0.1;
  if (clauses.filter((clause) => [...clause].length >= 6).length >= 2) {
    score += 0.16;
  }
  if (/我/.test(text)) score += 0.08;

  return Math.min(1, score);
}

function isPassage(text: string, clauses: string[]): boolean {
  const length = spokenLength(text);
  const richClauses = clauses.filter((clause) => [...clause].length >= 6);

  return length >= 16 || richClauses.length >= 2;
}

function isPlainQuestion(clauses: string[]): boolean {
  const substantive = clauses.filter((clause) => [...clause].length >= 2);

  if (substantive.length === 0) return false;

  return substantive.every(isInterrogative);
}

function isInterrogative(clause: string): boolean {
  if (/[？?吗呢]$/.test(clause)) return true;

  return /什么|怎么|怎样|如何|为什么|为何|哪个|哪里|哪儿|哪些|谁|多少|几点|几个|星期几|是不是|有没有|能不能|可不可以|会不会|要不要|对不对|行不行|好不好/.test(
    clause,
  );
}

function selfStrain(text: string): boolean {
  if (/你辛苦|辛苦你/.test(text)) return false;

  return /我.{0,8}辛苦|好困|睡不着|没睡好|没顾上|连轴转/.test(text);
}

function toneNudge(text: string): number {
  const negative = NEGATIVE_TONE.filter((cue) => text.includes(cue)).length;
  const positive = POSITIVE_TONE.filter((cue) => text.includes(cue)).length;

  if (negative === positive) return 0;
  return negative > positive ? -0.16 : 0.08;
}

function spokenLength(text: string): number {
  return [...text.replace(/[。！？!?；;，,、…~～]/g, "")].length;
}

function cueScore(text: string, cues: readonly string[]): number {
  const hits = cues.filter((cue) => text.includes(cue)).length;

  if (hits === 0) return 0;
  return hits === 1 ? 0.7 : 1;
}

function scaleMove(move: Move, factor: number): Move {
  return {
    valence: move.valence * factor,
    arousal: move.arousal * factor,
    warmth: move.warmth * factor,
    curiosity: move.curiosity * factor,
    relation: move.relation,
  };
}

function repeatsCause(text: string, cause: string): boolean {
  const body = cause.replace(/^他?说/, "").trim();

  if ([...body].length < 6) return false;

  const head = [...body].slice(0, 8).join("");
  return text.includes(head);
}

function splitClauses(text: string): string[] {
  return text
    .split(/[。！？!?；;，,、]+/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

function toCause(text: string): string {
  const spoken = text.replace(/^我+/, "").replace(/[。！？!?，,、]+$/g, "");
  return `他说${spoken}`;
}
