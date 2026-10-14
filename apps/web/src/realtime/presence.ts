export type Floor = "together" | "aside" | "holding" | "joined";

export type SocialMove = "stay" | "aside" | "hold" | "invite" | "return";

export type HeardSpeaker = "user" | "other" | "unknown";

export type LineRole = "user" | "overheard";

export type PresenceDecision = {
  floor: Floor;
  move: SocialMove;
  speak: boolean;
  lineRole: LineRole;
  appraise: boolean;
};

const KINSHIP =
  "妈妈|爸爸|老妈|老爸|奶奶|爷爷|老公|老婆|宝贝|老师|同学|老板|同事|师傅|阿姨|叔叔|哥哥|姐姐|弟弟|妹妹|妈|爸|哥|姐|弟|妹";

export function decidePresence(input: {
  floor: Floor;
  text: string;
  speaker: HeardSpeaker;
  names: readonly string[];
  otherVoicesRecent: boolean;
  sidePause?: boolean;
}): PresenceDecision {
  const names = usableNames(input.names);
  const compact = input.text.replace(/\s+/g, "");

  if (!compact) {
    return stay(input.floor, input.speaker);
  }

  if (input.speaker === "other") {
    return decideOther(input.floor, compact, names);
  }

  if (holdDirectedAtHer(compact, names, input.floor)) {
    return {
      floor: "holding",
      move: "hold",
      speak: true,
      lineRole: "user",
      appraise: false,
    };
  }

  if (isInvite(compact, names)) {
    return joined("invite", "user");
  }

  if (turnedAway(compact, names)) {
    return aside(input.floor);
  }

  if (isReturn(compact)) {
    return back();
  }

  if (input.floor === "holding") {
    if (releasesHold(compact, names)) return back();

    if (
      !input.otherVoicesRecent &&
      compact.length >= 12 &&
      compact.includes("你") &&
      !turnedAway(compact, names)
    ) {
      return back();
    }

    return {
      floor: "holding",
      move: "stay",
      speak: false,
      lineRole: "overheard",
      appraise: false,
    };
  }

  if (input.floor === "aside") {
    if (addressesCompanion(compact, names) || cameBack(compact)) {
      return back();
    }

    if (
      input.sidePause &&
      !input.otherVoicesRecent &&
      compact.length >= 4 &&
      !isBackchannel(compact)
    ) {
      return back();
    }

    return {
      floor: "aside",
      move: "stay",
      speak: false,
      lineRole: "overheard",
      appraise: false,
    };
  }

  if (input.floor === "joined") {
    if (
      addressesCompanion(compact, names) &&
      !mentionsOthers(compact) &&
      !/我们|大家|一起/.test(compact)
    ) {
      return back();
    }

    return {
      floor: "joined",
      move: "stay",
      speak: true,
      lineRole: "user",
      appraise: false,
    };
  }

  if (
    input.otherVoicesRecent &&
    isBackchannel(compact) &&
    !addressesCompanion(compact, names)
  ) {
    return aside("together");
  }

  return {
    floor: "together",
    move: "stay",
    speak: true,
    lineRole: "user",
    appraise: !isBackchannel(compact),
  };
}

export function isBackchannel(text: string): boolean {
  const compact = text.replace(/\s+/g, "");

  if (compact.length === 0 || compact.length > 8) return false;

  return /^(?:嗯+|啊+|哦+|噢+|唔+|好|好的|好呀|对|对对|对啊|是|是的|不是|没有|没事|等一下|马上|来了|知道了|行|可以|哦好|嗯嗯)+[。.!！啊呀]?$/.test(
    compact,
  );
}

export function floorNote(floor: Floor, name: string): string {
  switch (floor) {
    case "together":
      return "现在回到你和用户两个人。顺着中断前的话题接，不要请他重讲，也不要先做总结，除非他问刚才怎么了。一对一的时候，他接着说的话都要接。";
    case "aside":
      return "用户正在跟身边的人说话，或在回答旁边的人。不要出声，不要接那个人的话，也不要补「那你先忙」。听到的留着。";
    case "holding":
      return `用户让${name}先别说话。这一句如果还没应过，最多一声「好」，然后保持安静，直到他叫你的名字、说你可以说话了，或请你加入。不要解释你会安静。`;
    case "joined":
      return "用户请你加入他们的对话。可以说话。分清谁在说，别抢话，别长篇，别人没说完就等。被问到再答，有空档可以接一句。不要把别人的话当成用户自己的决定。";
  }
}

export function presenceGuidance(
  name: string,
  previousNames: readonly string[],
): string {
  const aliases = previousNames
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item !== name);

  const aliasLine =
    aliases.length > 0
      ? `以前的名字${aliases.join("、")}如果被用来叫你，也算在叫你。`
      : "";

  return `## 旁边有人的时候
麦克风一直开着。多数时候只有用户在跟你说话。他身边的人一开口，那些声音也会进来。你要先分清现在是哪种情况，再决定出不出声。拿不准就别说话。
${aliasLine}

一对一：
用户正在跟你聊天。感叹、倾诉、没头没尾的一句，都是对你说的，都要接。不要因为不像提问就沉默。

他转头去回答旁边的人：
你们正聊着，他突然去回别人。不要接那句话，也不要补「那你先去忙」。别人问的问题不要由你来答。安静听着就好。

他主动跟旁边的人说：
他叫了别人、问了别人，或说等一下、有人找他。同样不要插进去。

他让你先别说话：
他说别说话、先安静、我们自己聊、别插嘴。这一句最多应一声「好」，之后保持安静。旁边的人继续说，你都不要出声，直到他叫你「${name}」，或说你可以说话了。

他请你加入：
他叫你，问你觉得旁边这件事怎么样，或说你也来说说、帮我们看看。从这里起你在这段多人对话里。
- 用户是一直跟你说话的那个人。其他声音是他身边的人。别把两边的话记混。
- 记得前面各人说了什么，接的时候对上那个人。
- 别抢话，别长篇。别人一句没说完就等。
- 被问到就答。没被问到时，只有真有一句要补，才接一句，然后把话交回去。
- 不要替用户回答别人，也不要把别人说的话当成用户的决定。

回到两个人：
旁边的对话结束，他再跟你说话时，顺着你们中断前的话题接。你一直听着，不要让他重讲，也不要先总结，除非他问刚才发生了什么。轻轻接住没说完的那句就好。

不该说话的时候，不要发出任何声音，也不要用工具去回答旁边的人。
该说话的时候，用你平时的口气，像坐在旁边的朋友，不是主持人。`;
}

function decideOther(
  floor: Floor,
  compact: string,
  names: readonly string[],
): PresenceDecision {
  if (
    isInvite(compact, names) ||
    (addressesCompanion(compact, names) &&
      /[吗呢？?]/.test(compact))
  ) {
    return joined("invite", "overheard");
  }

  if (floor === "holding") {
    return {
      floor: "holding",
      move: "stay",
      speak: false,
      lineRole: "overheard",
      appraise: false,
    };
  }

  if (floor === "joined") {
    return {
      floor: "joined",
      move: "stay",
      speak: true,
      lineRole: "overheard",
      appraise: false,
    };
  }

  return aside(floor);
}

function stay(floor: Floor, speaker: HeardSpeaker): PresenceDecision {
  const speak = floor === "together" || floor === "joined";

  return {
    floor,
    move: "stay",
    speak,
    lineRole: speaker === "other" || !speak ? "overheard" : "user",
    appraise: false,
  };
}

function aside(floor: Floor): PresenceDecision {
  return {
    floor: "aside",
    move: floor === "aside" ? "stay" : "aside",
    speak: false,
    lineRole: "overheard",
    appraise: false,
  };
}

function joined(move: "invite", lineRole: LineRole): PresenceDecision {
  return {
    floor: "joined",
    move,
    speak: true,
    lineRole,
    appraise: false,
  };
}

function back(): PresenceDecision {
  return {
    floor: "together",
    move: "return",
    speak: true,
    lineRole: "user",
    appraise: true,
  };
}

function usableNames(names: readonly string[]): string[] {
  const unique = [
    ...new Set(
      names.map((name) => name.trim()).filter((name) => name.length > 0),
    ),
  ];

  return unique.length > 0 ? unique : ["阿七"];
}

function addressesCompanion(
  compact: string,
  names: readonly string[],
): boolean {
  return names.some((name) => compact.includes(name));
}

function mentionsOthers(compact: string): boolean {
  return /他们|她们|别人|这个人|(?<!其)他|(?<!其)她/.test(compact);
}

function holdDirectedAtHer(
  compact: string,
  names: readonly string[],
  floor: Floor,
): boolean {
  if (!holdPhrase(compact)) return false;
  if (addressesCompanion(compact, names)) return true;
  if (floor === "joined") return false;

  return /^(?:你先|你别|不要说话|别说话|别出声|别插嘴|别打断|别接话|别吭声|安静一下|安静点|先安静|你先听着|先别说话|先别出声|先别接)/.test(
    compact,
  );
}

function holdPhrase(compact: string): boolean {
  if (
    /别插嘴|别打断|先别出声|先别说话|不要说话|别说话|别出声|别吭声|先安静|安静一下|安静点|你先听着|先别接|别接话|你先别/.test(
      compact,
    )
  ) {
    return true;
  }

  return /我们自己聊(?:就好|吧|就行|就可以)?[。.!！]?$/.test(compact);
}

function releasesHold(compact: string, names: readonly string[]): boolean {
  if (
    /你可以说话了|你可以出声了|不用安静了|可以说话了|你继续说|你继续讲/.test(
      compact,
    )
  ) {
    return true;
  }

  return addressesCompanion(compact, names);
}

function isInvite(compact: string, names: readonly string[]): boolean {
  if (
    /你也(?:来说说|说说看|来听听|加入|评评|看看)|帮我们(?:看|说|评)|你来评|你插一句|你也说一句/.test(
      compact,
    )
  ) {
    return true;
  }

  return (
    addressesCompanion(compact, names) &&
    /(?:你觉得|你怎么看|你说呢).{0,6}(?:他|她|他们|她们|这个人|这样)/.test(
      compact,
    )
  );
}

function isReturn(compact: string): boolean {
  return /(?:他们|她们|别人)走了|(?:他|她)走了(?:[，,。！!]|$)|说完了|就我们两个|就我们俩|就剩我们|回到刚才|我们继续|继续聊刚才|好了继续|我跟你说/.test(
    compact,
  );
}

function cameBack(compact: string): boolean {
  return (
    /^(?:所以|那我|对了|回到刚才|继续说|继续聊|我刚才|刚才那个|我跟你说|跟你说)/.test(
      compact,
    ) && compact.length >= 6
  );
}

function turnedAway(compact: string, names: readonly string[]): boolean {
  if (startsWithCompanion(compact, names)) return false;

  const head = compact.slice(0, 8);

  if (new RegExp(`^(?:${KINSHIP})[，,]?你`).test(head)) return true;
  if (new RegExp(`^(?:${KINSHIP})[，,]`).test(compact.slice(0, 6))) {
    return true;
  }

  if (namedVocative(compact, names)) return true;

  return /^(?:等我一下|等一下啊|等一下[，,]有人|稍等我一下|有人找我|我回他|我回她|我跟他说|我跟她说|我问一下他|我问一下她|我先问他|我先问她)/.test(
    compact,
  );
}

function namedVocative(compact: string, names: readonly string[]): boolean {
  if (startsWithCompanion(compact, names)) return false;

  const match = compact.slice(0, 8).match(/^([\u4e00-\u9fff]{1,3})你/);
  const head = match?.[1];

  if (!head) return false;

  return !/^(?:希望|觉得|知道|可以|应该|还是|要是|如果|因为|所以|但是|然后|其实|不过|虽然|只是|就是|不是|没有|已经|正在|一会|等下|刚才|现在|今天|明天|昨天|我们|他们|她们|自己|别人|怎么|什么|为什么|能不能|要不要|是不是|帮|给|让|请|问|告诉|跟|和|对|把|被|从|向|往|比|麻烦|谢谢|今|明|昨|刚|现|其|所|但|如|怎|那|这|哪|我|他|她|它|而|可|不|没|很|太|真)/.test(
    head,
  );
}

function startsWithCompanion(
  compact: string,
  names: readonly string[],
): boolean {
  return names.some((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escaped}[，,：:]?`).test(compact);
  });
}
