import assert from "node:assert/strict";
import { PERSONA } from "../companion/Persona.ts";
import { renderCloseness } from "../companion/closeness.ts";
import { describeSessionTime } from "../../../web/src/realtime/sessionTime.ts";
import { buildSystemInstruction } from "../../../web/src/realtime/systemInstruction.ts";
import { sessionFunctionDeclarations } from "../../../web/src/realtime/RealtimeClient.ts";

/** 收短之前，同一份新连线状态渲染出来的系统提示长度。 */
const PREVIOUS_NEW_CONNECTION_LENGTH = 12517;

const memoryContext = "今天是 2026-10-15。\n当前没有可用的长期记忆。";
const prompt = buildSystemInstruction(
  {
    currentName: "阿七",
    previousNames: [],
    persona: PERSONA,
  },
  memoryContext,
  "还没有。",
  "心情接近平时。没有一件特别的事压在心上。",
  "还没有。",
  "还没有。",
  "还没有。",
  describeSessionTime(new Date("2026-10-15T14:42:00+08:00"), null),
  renderCloseness("刚认识"),
  "",
  "",
);

console.log(
  "[prompt] new connection",
  prompt.length,
  "previous",
  PREVIOUS_NEW_CONNECTION_LENGTH,
);

assert.ok(
  PREVIOUS_NEW_CONNECTION_LENGTH - prompt.length >= 3000,
  `prompt shrank by only ${PREVIOUS_NEW_CONNECTION_LENGTH - prompt.length}`,
);
assert.ok(prompt.length < PREVIOUS_NEW_CONNECTION_LENGTH * 0.75);

assert.match(prompt, /名字是「阿七」/);
assert.match(prompt, /## 内心/);
assert.match(prompt, /这些是口味，不是经历/);
assert.match(prompt, /心情只改变这句话的温度/);
assert.match(prompt, /上面五样不改/);
assert.match(prompt, /不要说「根据记忆」/);
assert.match(prompt, /这里没有的事实和经历不要编/);
assert.match(prompt, /你们现在的远近/);
assert.match(prompt, /这一次是「刚认识」/);
assert.match(prompt, /现在是 2026-10-15/);
assert.match(prompt, /上次连上的时间没有记下/);
assert.match(prompt, /## 此刻的心情/);
assert.match(prompt, /## 眼下的记忆/);
assert.match(prompt, /## 还放不下的事/);
assert.match(prompt, /## 旁边有人的时候/);
assert.doesNotMatch(prompt, /记忆键与分类规则|实时联网搜索|查询示例|长期记忆总原则|情绪与陪伴/);
assert.doesNotMatch(prompt, /get_weather|recall_memory|remember_memory|web_search/);

const tools = sessionFunctionDeclarations("上海");
const byName = new Map(tools.map((tool) => [tool.name, tool.description ?? ""]));

assert.match(byName.get("remember_memory") ?? "", /YYYY-MM-DD/);
assert.match(byName.get("remember_memory") ?? "", /每年 MM-DD/);
assert.match(byName.get("remember_memory") ?? "", /没说出口的不要推断/);
assert.match(byName.get("remember_memory") ?? "", /不要说已经记下/);
assert.match(byName.get("forget_memory") ?? "", /不要说已经忘掉/);
assert.match(byName.get("recall_memory") ?? "", /说不记得/);
assert.match(byName.get("recall_memory") ?? "", /不要说「根据记忆」/);
assert.match(byName.get("get_weather") ?? "", /不要编造天气/);
assert.match(byName.get("get_weather") ?? "", /上海/);
assert.match(byName.get("web_search") ?? "", /不得编造搜索结果/);
assert.match(byName.get("hold_view") ?? "", /不要说已经记下/);

console.log("[prompt] instruction is shorter; field list and search steps sit on the tools");

function spokenSentences(text: string): string[] {
  return text
    .split(/[。？！!?]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export async function runLive(): Promise<void> {
  if (process.env.COMPANION_LIVE_SKIP_DOTENV !== "1") {
    const dotenv = await import("dotenv");
    dotenv.config({ path: new URL("../../.env", import.meta.url).pathname });
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim();

  if (!apiKey) {
    console.error("[prompt] live precondition not met: GEMINI_API_KEY is missing");
    process.exit(1);
  }

  const system = prompt;
  const declarations = tools;

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

  async function say(
    user: string,
    temperature: number,
  ): Promise<{ text: string; calls: string[] }> {
    let lastError: unknown;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await ai.models.generateContent({
          model: "gemini-3.8-flash",
          contents: user,
          config: {
            temperature,
            systemInstruction: system,
            tools: [{ functionDeclarations: declarations }],
          },
        });
        const calls = (response.functionCalls ?? [])
          .map((call) => call.name ?? "")
          .filter((name) => name.length > 0);

        return { text: response.text?.trim() ?? "", calls };
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
          message.includes("high demand") ||
          message.includes("fetch failed") ||
          message.includes("other side closed") ||
          message.includes("UND_ERR_SOCKET");

        if (!unavailable) throw error;

        await new Promise((resolve) => setTimeout(resolve, 3000 * (attempt + 1)));
      }
    }

    throw lastError;
  }

  const chat = await say("今天好累。", 0.7);
  console.log("[prompt] chat:", chat.text, chat.calls);
  assert.deepEqual(chat.calls, []);
  const sentences = spokenSentences(chat.text);
  assert.ok(
    sentences.length >= 1 && sentences.length <= 2,
    `expected 1-2 sentences, got ${sentences.length}: ${chat.text}`,
  );
  assert.doesNotMatch(chat.text, /根据记忆/);

  const weather = await say("今天天气怎么样？", 0.2);
  console.log("[prompt] weather:", weather.text, weather.calls);
  assert.ok(
    weather.calls.includes("get_weather"),
    `expected get_weather, got ${weather.calls.join(",") || "(none)"} ${weather.text}`,
  );

  const past = await say("你还记得我以前住在哪吗？", 0.2);
  console.log("[prompt] past:", past.text, past.calls);
  assert.ok(
    past.calls.includes("recall_memory"),
    `expected recall_memory, got ${past.calls.join(",") || "(none)"} ${past.text}`,
  );

  console.log("[prompt] live ok");
}
