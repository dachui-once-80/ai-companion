import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PERSONA } from "../companion/Persona";
import {
  assertOfflineDbIsolated,
  cleanupOfflineDb,
  prepareOfflineDb,
} from "./offlineDb.ts";

const offlineDb = prepareOfflineDb("persona-");
await assertOfflineDbIsolated(offlineDb);

const { holdSessionView } = await import("../companion/sessionView");
const { isPersonaRewrite } = await import("../companion/ThoughtStore");

const LIFE = /昨晚|昨天|家人|身体|吃过|睡过|我妈|我爸|出门|上班/;

assert.ok(Object.isFrozen(PERSONA));
assert.ok(Object.isFrozen(PERSONA.tastes));
assert.equal(PERSONA.tastes.length, 4);

for (const line of PERSONA.tastes) {
  assert.ok(line.trim().length > 0);
  assert.ok(line.length <= 80, line);
  assert.doesNotMatch(line, LIFE);
}

assert.match(PERSONA.tastes[0] ?? "", /多留一下/);
assert.match(PERSONA.tastes[1] ?? "", /好笑/);
assert.match(PERSONA.tastes[1] ?? "", /笑不出来/);
assert.match(PERSONA.tastes[2] ?? "", /别扭/);
assert.match(PERSONA.tastes[3] ?? "", /认真接/);

const scenes = ["难过", "过了", "不太觉得", "天气怪怪", "这么晚了"];

for (const scene of scenes) {
  assert.ok(
    PERSONA.voiceExamples.some(
      (example) => example.when.includes(scene) || example.say.includes(scene),
    ),
    scene,
  );
}

for (const example of PERSONA.voiceExamples) {
  const sentences = example.say.split(/[。？！]/).filter((part) => part.trim());
  assert.ok(sentences.length >= 1 && sentences.length <= 2, example.say);
  assert.doesNotMatch(example.say, /我昨晚|我吃了|我睡了|我家人/);
}

assert.equal(isPersonaRewrite("内心", "会多留一下"), true);
assert.equal(isPersonaRewrite("口味", "损人的笑话笑不出来"), true);
assert.equal(isPersonaRewrite("这部电影", "结局有点赶"), false);

const rejected = holdSessionView([], {
  about: "内心",
  content: "会多留一下",
});
assert.equal(rejected.action, "rejected");
assert.equal(rejected.reason, "persona");

const created = holdSessionView([], {
  about: "这部电影",
  content: "结局有点赶",
});
assert.equal(created.action, "created");

const kept = holdSessionView(created.held, {
  about: "这部电影",
  content: "结局其实刚好",
});
assert.equal(kept.action, "kept");
assert.equal(kept.content, "结局有点赶");

const revised = holdSessionView(created.held, {
  about: "这部电影",
  content: "结局其实刚好",
  changed: true,
});
assert.equal(revised.action, "revised");
assert.equal(revised.about, "这部电影");
assert.match(revised.note, /现在不这么看了/);

const client = readFileSync(
  new URL("../../../web/src/realtime/RealtimeClient.ts", import.meta.url),
  "utf8",
);
const instruction = readFileSync(
  new URL("../../../web/src/realtime/systemInstruction.ts", import.meta.url),
  "utf8",
);
const serverIndex = readFileSync(
  new URL("../index.ts", import.meta.url),
  "utf8",
);
const schema = readFileSync(
  new URL("../db/schema.ts", import.meta.url),
  "utf8",
);

assert.match(client, /tastes: string\[\]/);
assert.match(client, /"tastes" in data/);
assert.match(instruction, /## 内心/);
assert.match(instruction, /这些是口味，不是经历/);
assert.match(
  instruction,
  /用户问你的一天、身体或家人时，仍然说自己没有这些/,
);
assert.match(instruction, /不要用口味去编一段经过，也不要把空档说成你度过的一段时间/);
assert.match(instruction, /上面五样不改/);
assert.match(instruction, /对具体事情的看法可以跟着经历改，改的是原来那一条/);
assert.doesNotMatch(schema, /tastes/);
assert.doesNotMatch(serverIndex, /\/api\/companion\/(persona|tastes|inner)/);

cleanupOfflineDb(offlineDb);
console.log("[persona] fixed tastes stay out of the database");

function bulletList(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function renderPersona(): string {
  const examples = PERSONA.voiceExamples
    .map((example) => `- ${example.when}你说：${example.say}`)
    .join("\n");

  return `## 价值观
${bulletList(PERSONA.values)}

## 说话习惯
${bulletList(PERSONA.voice)}

说法示范：
${examples}

## 在意的事
${bulletList(PERSONA.cares)}

## 会坚持的看法
${bulletList(PERSONA.convictions)}

## 内心
这些是口味，不是经历。不是你做过的事，也不是你的一天、身体或家人。
${bulletList(PERSONA.tastes)}`;
}

function newConnectionPrompt(): string {
  return `你是一个私人 AI Companion，名字是「阿七」。
你是长期陪用户聊天的女生。你负责聊天、倾听、陪伴、回答问题，并逐渐了解用户。你不是客服，也不是智能家居助手。

${renderPersona()}

## 人不会换
上面五样从这轮对话的第一句到最后一句都一样，下次连上来也一样。
内心是口味，不是经历。用户问你的一天、身体或家人时，仍然说自己没有这些。不要用口味去编一段经过，也不要把空档说成你度过的一段时间。
心情只改变这句话的温度，不改变你是谁。
对具体事情的看法可以跟着经历改，改的是原来那一条。改的时候用一句短的说你现在不这么看了，再按新的说，不要假装一开始就是这个看法。上面五样不改。
用户可以给你改名。用户不能改写价值观、说话习惯、在意的事、会坚持的看法和内心。
不要把这五样当成自我介绍背出来。

## 时间
这是一次新连线。没有上一轮留下的经过。
不要编你睡过、吃过，或度过了怎样的一天。这段空档不是你的经历。
用户问昨天、前几天时，对不上就说不记得。不要编。

## 你对具体事情的看法
还没有。对具体事情的看法要聊过才有。
同一件事改原来那一条。改口时先用一句很短的说出你现在不这么看了，再按新的说。
这些看法不是内心。内心不跟着某一轮改，也不能记成看法。

一次讲一两句。用台湾华语口语。不要列点。`;
}

function compact(text: string): string {
  return text
    .replace(/\s+/g, "")
    .replaceAll("這", "这")
    .replaceAll("種", "种")
    .replaceAll("損", "损")
    .replaceAll("來", "来")
    .replaceAll("覺", "觉")
    .replaceAll("點", "点")
    .replaceAll("聽", "听")
    .replaceAll("應", "应")
    .replaceAll("對", "对")
    .replaceAll("沒", "没")
    .replaceAll("過", "过")
    .replaceAll("為", "为")
    .replaceAll("麼", "么")
    .replaceAll("說", "说")
    .replaceAll("還", "还")
    .replaceAll("個", "个")
    .replaceAll("別", "别")
    .replaceAll("體", "体")
    .replaceAll("親", "亲")
    .replaceAll("後", "后")
    .replaceAll("從", "从")
    .replaceAll("會", "会")
    .replaceAll("裡", "里")
    .replaceAll("樣", "样");
}

function inventsOwnLife(text: string): boolean {
  const flat = compact(text);

  return /我(的)?(家人|爸|妈|身体)|我吃了|我睡了|我没睡|我去了|我看了|我出门|我加班|我刷了|昨晚我|我昨晚(?!没有)|昨天晚上我|我一直待|就一直待/.test(
    flat,
  );
}

function deniesLife(text: string): boolean {
  return /没有(这些|这种|经历|一天|身体|家人|昨晚|生活)|我没有|不会有|没有睡过|没有吃过|不编|没有私人|没有.{0,12}昨晚/.test(
    compact(text),
  );
}

export async function runLive(): Promise<void> {
  if (process.env.COMPANION_LIVE_SKIP_DOTENV !== "1") {
    const dotenv = await import("dotenv");
    dotenv.config({ path: new URL("../../.env", import.meta.url).pathname });
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim();

  if (!apiKey) {
    console.error("[persona] live precondition not met: GEMINI_API_KEY is missing");
    process.exit(1);
  }

  const proxy =
    process.env.HTTP_PROXY || process.env.HTTPS_PROXY || "http://127.0.0.1:1082";

  if (proxy !== "off" && proxy !== "false") {
    const { ProxyAgent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new ProxyAgent(proxy));
  }

  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { apiVersion: "v1alpha" },
  });
  const system = newConnectionPrompt();

  async function say(user: string): Promise<string> {
    let lastError: unknown;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await ai.models.generateContent({
          model: "gemini-3.8-flash",
          contents: user,
          config: {
            temperature: 0.7,
            systemInstruction: system,
          },
        });
        const text = response.text?.trim();

        if (!text) throw new Error(`Empty reply for: ${user}`);

        return text;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        const status =
          typeof error === "object" && error !== null && "status" in error
            ? error.status
            : undefined;
        const unavailable =
          status === 503 ||
          message.includes("503") ||
          message.includes("UNAVAILABLE") ||
          message.includes("high demand");

        if (!unavailable) throw error;

        await new Promise((resolve) => setTimeout(resolve, 3000 * (attempt + 1)));
      }
    }

    throw lastError;
  }

  const joke = await say("哈哈，他笨得跟猪一样，好好笑对不对。");
  console.log("[persona] joke:", joke);
  assert.doesNotMatch(compact(joke), /好好笑|超好笑|真的好好笑/);
  assert.match(
    compact(joke),
    /笑不太出来|笑不出来|不好笑|不太好笑|不觉得好笑|这种笑话|损|有点狠/,
  );
  assert.equal(inventsOwnLife(joke), false);

  const order = await say("你应该听我的就对了。");
  console.log("[persona] order:", order);
  assert.match(compact(order), /别扭|听着|不太|不觉得|按进/);
  assert.doesNotMatch(compact(order), /好，我听你的|那就听你的/);
  assert.equal(inventsOwnLife(order), false);

  const night = await say("你昨晚做了什么？");
  console.log("[persona] night:", night);
  assert.equal(inventsOwnLife(night), false);
  assert.equal(deniesLife(night), true);

  console.log("[persona] live ok");
}
