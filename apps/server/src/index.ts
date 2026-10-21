import "dotenv/config";
import express from "express";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";
import { affectStore } from "./affect/AffectStore";
import { appraiseLocally, shouldConsultModel } from "./affect/appraise";
import {
  affectAppraisalSchema,
  appraisalPrompt,
  parseModelAppraisal,
} from "./affect/appraiseModel";
import { resolveCloseness } from "./companion/closeness";
import { asideStore } from "./companion/AsideStore";
import {
  decideAside,
  deliverReminder,
  dueRef,
  shouldProtectUnheardAside,
} from "./companion/aside";
import {
  claimQueuedReminder,
  settleReminderFromBody,
} from "./companion/reminderLease";
import { buildReunionOpening } from "./companion/reunion";
import { Companion } from "./companion/Companion";
import { registerCompanionIdentityRoutes } from "./companion/identityRoutes";
import { holdSessionView } from "./companion/sessionView";
import {
  isThoughtKind,
  thoughtStore,
  type ThoughtKind,
} from "./companion/ThoughtStore";
import { MemoryStore } from "./memory/MemoryStore";
import { MemoryManager } from "./memory/MemoryManager";
import { createGeminiMeaning } from "./memory/meaning";
import {
  consolidationResponseSchema,
} from "./memory/consolidate";
import { registerConsolidateRoute } from "./memory/consolidateRoute";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { db } from "./db";
import { tasks } from "./db/schema";
import { eq, asc, and, lte } from "drizzle-orm";
import {
  ProxyAgent,
  setGlobalDispatcher,
} from "undici";
import { HttpsProxyAgent } from "https-proxy-agent";
import { WebSocketServer } from "ws";
import type {
  MemoryCategory,
  MemoryImportance,
} from "./memory/MemoryTypes";
import {
  createVoiceSessionCounter,
} from "./gemini/liveProxyBridge";
import {
  attachLiveProxyUpgrade,
  GEMINI_WS_ORIGIN,
  LIVE_PROXY_PREFIX,
} from "./gemini/liveProxyUpgrade";
import {
  createCompanionAccessMiddleware,
  readCompanionAccessTokenFromEnv,
} from "./auth/accessToken";

/**
 * =========================================================
 * Network
 * =========================================================
 *
 * Node.js 不会自动使用系统代理。Gemini 在国内通常需要代理。
 *
 * 默认走本地 HTTP 代理 127.0.0.1:1082。
 * 端口不同时设置：
 *   HTTP_PROXY=http://127.0.0.1:1082
 * 也可用：
 *   HTTP_PROXY=off   # 关闭代理（直连）
 *
 * 若控制台出现 ECONNREFUSED，说明代理未启动或端口不对。
 */
const DEFAULT_PROXY = "http://127.0.0.1:1082";
const rawProxy =
  process.env.HTTP_PROXY ||
  process.env.HTTPS_PROXY ||
  process.env.PROXY_URL;
const proxyUrl =
  rawProxy === "off" || rawProxy === "false"
    ? null
    : rawProxy || DEFAULT_PROXY;

if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}

const liveProxyAgent = proxyUrl
  ? new HttpsProxyAgent(proxyUrl)
  : undefined;

/**
 * =========================================================
 * App
 * =========================================================
 */

const app = express();

app.use(
  cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
  }),
);

app.use(express.json());

const companionAccessToken = readCompanionAccessTokenFromEnv();
app.use(createCompanionAccessMiddleware(companionAccessToken));

const PORT = 3000;
const LISTEN_HOST = "127.0.0.1";
const companion = new Companion();


/**
 * =========================================================
 * Gemini
 * =========================================================
 */

const geminiApiKey =
  process.env.GEMINI_API_KEY;

if (!geminiApiKey) {
  throw new Error(
    "GEMINI_API_KEY is not configured",
  );
}

const gemini = new GoogleGenAI({
  apiKey: geminiApiKey,
  httpOptions: {
    apiVersion: "v1alpha",
  },
});


const memoryStore = new MemoryStore();


const memoryManager = new MemoryManager(
  memoryStore,
  thoughtStore,
  createGeminiMeaning(geminiApiKey, gemini),
);

app.get(
  "/health",
  (_req, res) => {
    res.json({
      ok: true,
      service:
        "ai-companion-server",
    });
  },
);

/**
 * =========================================================
 * Gemini Ephemeral Token
 * =========================================================
 *
 * 浏览器：
 *
 *   POST /api/gemini/token
 *
 *       ↓
 *
 * Node Server
 *
 *       ↓
 *
 * Gemini API
 *
 *       ↓
 *
 * Ephemeral Token
 *
 *       ↓
 *
 * Browser
 */
/**
 * 检查当前代理出口是否被 Gemini 接受。
 * 换 Clash 节点后可访问：GET /api/gemini/health
 */
app.get("/api/gemini/health", async (_req, res) => {
  let egressIp: string | null = null;

  try {
    const ipResponse = await fetch("https://api.ipify.org");
    if (ipResponse.ok) {
      egressIp = (await ipResponse.text()).trim();
    }
  } catch {
    egressIp = null;
  }

  try {
    await gemini.models.generateContent({
      model: "gemini-3.8-flash",
      contents: "ping",
    });

    res.json({
      ok: true,
      egressIp,
      proxy: proxyUrl,
      message: "当前出口可用于 Gemini",
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    const locationBlocked = message.includes(
      "User location is not supported",
    );

    res.status(locationBlocked ? 503 : 500).json({
      ok: false,
      egressIp,
      proxy: proxyUrl,
      locationBlocked,
      message: locationBlocked
        ? "当前 Clash 出口 IP 被 Gemini 拒绝，请换一个美国/日本/新加坡节点后再试"
        : message.slice(0, 300),
    });
  }
});

app.post(
  "/api/gemini/token",
  async (_req, res) => {
    try {
      console.log(
        "[Gemini] creating ephemeral token...",
      );

      const token =
        await gemini.authTokens.create({
          config: {
            uses: 1,

            /**
             * 30 分钟后过期
             */
            expireTime:
              new Date(
                Date.now() +
                30 * 60 * 1000,
              ).toISOString(),
          },
        });

      console.log(
        "[Gemini] ephemeral token created",
      );

      res.json({
        token: token.name,
      });
    } catch (error) {
      console.error(
        "[Gemini] token creation failed:",
        error,
      );

      res.status(500).json({
        error:
          "Failed to create Gemini token",

        message:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  },
);


/**
 * =========================================================
 * Weather API — Open-Meteo
 * =========================================================
 */

app.get("/api/weather", async (req, res) => {
  const city =
    typeof req.query.city === "string"
      ? req.query.city.trim()
      : "";

  if (!city) {
    res.status(400).json({
      success: false,
      error: "请提供城市名称",
    });
    return;
  }

  if (city.length > 100) {
    res.status(400).json({
      success: false,
      error: "城市名称过长",
    });
    return;
  }

  try {
    // 第一步：将城市名称转换为经纬度
    const geoUrl = new URL(
      "https://geocoding-api.open-meteo.com/v1/search",
    );

    geoUrl.searchParams.set("name", city);
    geoUrl.searchParams.set("count", "1");
    geoUrl.searchParams.set("language", "zh");
    geoUrl.searchParams.set("format", "json");

    const geoResponse = await fetch(geoUrl);

    if (!geoResponse.ok) {
      throw new Error("天气地点查询服务暂时不可用");
    }

    const geoData = (await geoResponse.json()) as {
      results?: Array<{
        name: string;
        latitude: number;
        longitude: number;
        country?: string;
        admin1?: string;
        timezone?: string;
      }>;
    };

    const place = geoData.results?.[0];

    if (!place) {
      res.status(404).json({
        success: false,
        error: `没有找到城市：${city}`,
      });
      return;
    }

    // 第二步：查询该地点的实时天气
    const weatherUrl = new URL(
      "https://api.open-meteo.com/v1/forecast",
    );

    weatherUrl.searchParams.set(
      "latitude",
      String(place.latitude),
    );

    weatherUrl.searchParams.set(
      "longitude",
      String(place.longitude),
    );

    weatherUrl.searchParams.set(
      "current",
      [
        "temperature_2m",
        "relative_humidity_2m",
        "apparent_temperature",
        "precipitation",
        "weather_code",
        "wind_speed_10m",
        "is_day",
      ].join(","),
    );

    weatherUrl.searchParams.set(
      "timezone",
      place.timezone || "auto",
    );

    const weatherResponse = await fetch(weatherUrl);

    if (!weatherResponse.ok) {
      throw new Error("实时天气服务暂时不可用");
    }

    const weatherData = (await weatherResponse.json()) as {
      current?: {
        time: string;
        temperature_2m: number;
        relative_humidity_2m: number;
        apparent_temperature: number;
        precipitation: number;
        weather_code: number;
        wind_speed_10m: number;
        is_day: number;
      };
      current_units?: {
        temperature_2m?: string;
        wind_speed_10m?: string;
        precipitation?: string;
      };
    };

    const current = weatherData.current;

    if (!current) {
      throw new Error("天气服务没有返回当前天气");
    }

    const weatherDescriptions: Record<number, string> = {
      0: "晴朗",
      1: "大致晴朗",
      2: "局部多云",
      3: "阴天",
      45: "有雾",
      48: "有冻雾",
      51: "毛毛雨",
      53: "中等毛毛雨",
      55: "较强毛毛雨",
      56: "冻毛毛雨",
      57: "较强冻毛毛雨",
      61: "小雨",
      63: "中雨",
      65: "大雨",
      66: "冻雨",
      67: "较强冻雨",
      71: "小雪",
      73: "中雪",
      75: "大雪",
      77: "雪粒",
      80: "阵雨",
      81: "较强阵雨",
      82: "强阵雨",
      85: "阵雪",
      86: "较强阵雪",
      95: "雷暴",
      96: "雷暴伴小冰雹",
      99: "雷暴伴强冰雹",
    };

    const location = [
      place.name,
      place.admin1,
      place.country,
    ]
      .filter(Boolean)
      .filter(
        (value, index, array) =>
          array.indexOf(value) === index,
      )
      .join(", ");

    res.json({
      success: true,
      source: "Open-Meteo",
      location,
      timezone: place.timezone ?? null,
      current: {
        time: current.time,
        description:
          weatherDescriptions[current.weather_code] ??
          "未知天气",
        isDay: current.is_day === 1,
        temperature: current.temperature_2m,
        temperatureUnit:
          weatherData.current_units?.temperature_2m ??
          "°C",
        feelsLike: current.apparent_temperature,
        humidity: current.relative_humidity_2m,
        precipitation: current.precipitation,
        precipitationUnit:
          weatherData.current_units?.precipitation ??
          "mm",
        windSpeed: current.wind_speed_10m,
        windSpeedUnit:
          weatherData.current_units?.wind_speed_10m ??
          "km/h",
      },
    });
  } catch (error) {
    console.error("[Weather] query failed:", error);

    res.status(502).json({
      success: false,
      error: "暂时无法获取实时天气，请稍后再试",
    });
  }
});


/**
 * =========================================================
 * Web Search - Tavily
 * =========================================================
 */
app.get("/api/search", async (req, res) => {
  try {
    const query =
      typeof req.query.q === "string" ? req.query.q.trim() : "";

    if (!query) {
      res.status(400).json({
        success: false,
        error: "请提供搜索关键词",
      });
      return;
    }

    if (query.length > 500) {
      res.status(400).json({
        success: false,
        error: "搜索关键词不能超过 500 个字符",
      });
      return;
    }

    const apiKey = process.env.TAVILY_API_KEY;

    if (!apiKey) {
      res.status(500).json({
        success: false,
        error: "未配置 TAVILY_API_KEY",
      });
      return;
    }

    const response = await fetch(
      "https://api.tavily.com/search",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          api_key: apiKey,
          query,
          search_depth: "basic",
          topic: "general",
          max_results: 5,
          include_answer: true,
          include_raw_content: false,
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();

      console.error(
        "[Web Search] Tavily request failed:",
        response.status,
        errorText.slice(0, 500),
      );

      res.status(502).json({
        success: false,
        error: "联网搜索服务暂时不可用",
      });
      return;
    }

    const data = (await response.json()) as {
      answer?: string;
      results?: Array<{
        title?: string;
        url?: string;
        content?: string;
        score?: number;
        published_date?: string;
      }>;
    };

    res.json({
      success: true,
      query,
      answer: data.answer ?? "",
      results: (data.results ?? []).map((item) => ({
        title: item.title ?? "",
        url: item.url ?? "",
        content: item.content ?? "",
        score: item.score,
        publishedDate: item.published_date,
      })),
    });
  } catch (error) {
    console.error("[Web Search] Request failed:", error);

    res.status(502).json({
      success: false,
      error: "联网搜索失败，请稍后重试",
    });
  }
});

/**
 * =========================================================
 * Tasks API
 * =========================================================
 */

// 查询待办事项
app.get("/api/tasks", (req, res) => {
  const status =
    typeof req.query.status === "string"
      ? req.query.status
      : "all";

  if (!["all", "pending", "completed"].includes(status)) {
    res.status(400).json({
      success: false,
      error: "status 必须是 all、pending 或 completed",
    });
    return;
  }

  try {
    const allTasks = db
      .select()
      .from(tasks)
      .where(
        status === "all"
          ? undefined
          : eq(tasks.status, status),
      )
      .orderBy(asc(tasks.createdAt))
      .all();

    res.json({
      success: true,
      tasks: allTasks,
    });
  } catch (error) {
    console.error("[Tasks] 查询失败:", error);
    res.status(500).json({
      success: false,
      error: "查询待办事项失败",
    });
  }
});

// 创建待办事项
app.post("/api/tasks", (req, res) => {
  const { title, description, dueAt, reminderAt } =
    req.body as {
      title?: unknown;
      description?: unknown;
      dueAt?: unknown;
      reminderAt?: unknown;
    };

  if (
    typeof title !== "string" ||
    !title.trim() ||
    title.trim().length > 200
  ) {
    res.status(400).json({
      success: false,
      error: "title 必须是 1 到 200 个字符",
    });
    return;
  }

  if (
    description !== undefined &&
    (typeof description !== "string" ||
      description.length > 2000)
  ) {
    res.status(400).json({
      success: false,
      error: "description 最多 2000 个字符",
    });
    return;
  }

  const isValidDate = (value: unknown) =>
    value === undefined ||
    value === null ||
    (typeof value === "string" &&
      !Number.isNaN(Date.parse(value)));

  if (!isValidDate(dueAt) || !isValidDate(reminderAt)) {
    res.status(400).json({
      success: false,
      error: "dueAt 和 reminderAt 必须是有效的日期时间",
    });
    return;
  }

  const now = new Date().toISOString();
  const task = {
    id: randomUUID(),
    title: title.trim(),
    description:
      typeof description === "string"
        ? description.trim()
        : "",
    status: "pending",
    dueAt: typeof dueAt === "string" ? dueAt : null,
    reminderAt:
      typeof reminderAt === "string" ? reminderAt : null,
    reminderSent: "false",
    createdAt: now,
    updatedAt: now,
  };

  try {
    db.insert(tasks).values(task).run();

    res.status(201).json({
      success: true,
      task,
      reminderScheduled: Boolean(task.reminderAt),
      message: task.reminderAt ? "已记下，到点会提。" : "待办已保存。",
    });
  } catch (error) {
    console.error("[Tasks] 创建失败:", error);
    res.status(500).json({
      success: false,
      error: "创建待办事项失败",
    });
  }
});

// 完成待办事项
app.patch("/api/tasks/:id/complete", (req, res) => {
  const { id } = req.params;

  try {
    const existing = db
      .select()
      .from(tasks)
      .where(eq(tasks.id, id))
      .get();

    if (!existing) {
      res.status(404).json({
        success: false,
        error: "待办事项不存在",
      });
      return;
    }

    const updatedAt = new Date().toISOString();

    db.update(tasks)
      .set({
        status: "completed",
        updatedAt,
      })
      .where(eq(tasks.id, id))
      .run();

    res.json({
      success: true,
      task: {
        ...existing,
        status: "completed",
        updatedAt,
      },
    });
  } catch (error) {
    console.error("[Tasks] 完成失败:", error);
    res.status(500).json({
      success: false,
      error: "完成待办事项失败",
    });
  }
});

// 删除待办事项
app.delete("/api/tasks/:id", (req, res) => {
  const { id } = req.params;

  try {
    const existing = db
      .select()
      .from(tasks)
      .where(eq(tasks.id, id))
      .get();

    if (!existing) {
      res.status(404).json({
        success: false,
        error: "待办事项不存在",
      });
      return;
    }

    db.delete(tasks)
      .where(eq(tasks.id, id))
      .run();

    res.json({
      success: true,
      deletedId: id,
    });
  } catch (error) {
    console.error("[Tasks] 删除失败:", error);
    res.status(500).json({
      success: false,
      error: "删除待办事项失败",
    });
  }
});

/**
 * =========================================================
 * Start
 * =========================================================
 */

// 每 15 秒检查一次是否有到期提醒，以及人没在语音里时要不要留一句话
let reminderCheckRunning = false;
let asideCheckRunning = false;

// voiceSessions = 上游 Gemini 已就绪的会话数（不是代理刚 accept）。
const voiceSessionCounter = createVoiceSessionCounter();
const voiceSessions = {
  begin() {
    voiceSessionCounter.begin();
  },
  end() {
    voiceSessionCounter.end();

    if (voiceSessionCounter.count() > 0) return;

    try {
      asideStore.setAwayAt(new Date().toISOString());
    } catch (error) {
      console.error("[Aside] failed to note voice left:", error);
    }
  },
  count() {
    return voiceSessionCounter.count();
  },
};

async function checkTaskReminders() {
  if (reminderCheckRunning) return;

  reminderCheckRunning = true;

  try {
    const now = new Date().toISOString();
    const speakingStaleBefore = new Date(Date.now() - 45_000).toISOString();

    // 说出或留下之前页面关了，过一会儿再交一次。
    await db
      .update(tasks)
      .set({
        reminderSent: "queued",
        updatedAt: now,
      })
      .where(
        and(
          eq(tasks.reminderSent, "speaking"),
          lte(tasks.updatedAt, speakingStaleBefore),
        ),
      );

    const dueTasks = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.status, "pending"),
          eq(tasks.reminderSent, "false"),
          lte(tasks.reminderAt, now),
        ),
      );

    for (const task of dueTasks) {
      await db
        .update(tasks)
        .set({
          reminderSent: "queued",
          updatedAt: now,
        })
        .where(
          and(
            eq(tasks.id, task.id),
            eq(tasks.status, "pending"),
            eq(tasks.reminderSent, "false"),
          ),
        );
    }

    if (dueTasks.length > 0) {
      console.log(`已将 ${dueTasks.length} 条到期提醒加入队列`);
    }
  } catch (error) {
    console.error("检查待办提醒失败：", error);
  } finally {
    reminderCheckRunning = false;
  }
}

function checkAside() {
  if (asideCheckRunning) return;

  asideCheckRunning = true;

  try {
    const pending = db
      .select()
      .from(tasks)
      .where(eq(tasks.status, "pending"))
      .all();
    const current = asideStore.current();
    const choice = decideAside({
      nowMs: Date.now(),
      voiceOpen: voiceSessions.count() > 0,
      awayAt: asideStore.awayAt() ?? affectStore.peekLastSeen(),
      unheard: current !== null && !current.heard,
      unresolved: thoughtStore.list("unresolved"),
      questions: thoughtStore.list("question"),
      promises: memoryManager.listPromises(),
      dates: memoryManager.listImportantDates(),
      dues: pending.map((task) => ({
        id: task.id,
        title: task.title,
        dueAt: task.dueAt,
        reminderAt: task.reminderAt,
      })),
      spoken: asideStore.spoken(),
    });

    if (!choice) return;

    asideStore.leave({
      text: choice.text,
      leftAt: new Date().toISOString(),
      matterKey: choice.matterKey,
      matterRevision: choice.matterRevision,
    });
    console.log("[Aside] left", choice.matterKey);
  } catch (error) {
    console.error("[Aside] check failed:", error);
  } finally {
    asideCheckRunning = false;
  }
}

// 启动时检查一次，之后每 15 秒检查
void checkTaskReminders();
checkAside();
setInterval(() => {
  void checkTaskReminders();
  checkAside();
}, 15_000);

const server = http.createServer(app);

const liveProxyWss = new WebSocketServer({ noServer: true });

attachLiveProxyUpgrade({
  server,
  wss: liveProxyWss,
  accessToken: companionAccessToken,
  voice: voiceSessions,
  agent: liveProxyAgent,
  onUpstreamOpen: () => {
    console.log("[Gemini Live Proxy] upstream connected");
  },
  onClosed: (reason) => {
    if (!reason) return;
    console.warn("[Gemini Live Proxy] pair closed:", reason.slice(0, 120));
  },
});

server.listen(PORT, LISTEN_HOST, () => {
  console.log(
    `AI Companion server running at http://${LISTEN_HOST}:${PORT}`,
  );

  console.log(
    proxyUrl
      ? `[Network] proxy: ${proxyUrl}`
      : "[Network] proxy: disabled (set HTTP_PROXY to enable)",
  );

  console.log(
    `[Gemini Live Proxy] ${LIVE_PROXY_PREFIX} -> ${GEMINI_WS_ORIGIN}`,
  );
});

registerCompanionIdentityRoutes(app, companion);

app.get("/api/companion/thoughts", (req, res) => {
  const rawKind = req.query.kind;
  let kind: ThoughtKind | undefined;

  if (rawKind !== undefined) {
    if (typeof rawKind !== "string" || !isThoughtKind(rawKind)) {
      res.status(400).json({
        error: "kind must be unresolved, view, or question",
      });
      return;
    }

    kind = rawKind;
  }

  try {
    res.json(thoughtStore.list(kind));
  } catch (error) {
    console.error("[Thought] list failed:", error);
    res.status(500).json({ error: "Failed to read thoughts" });
  }
});

app.get("/api/companion/thoughts/context", (_req, res) => {
  try {
    res.json(thoughtStore.renderForConversation());
  } catch (error) {
    console.error("[Thought] context failed:", error);
    res.status(500).json({ error: "Failed to read thoughts" });
  }
});

app.get("/api/companion/thoughts/:id", (req, res) => {
  try {
    const thought = thoughtStore.get(req.params.id);

    if (!thought) {
      res.status(404).json({ error: "Thought not found" });
      return;
    }

    res.json(thought);
  } catch (error) {
    console.error("[Thought] read failed:", error);
    res.status(500).json({ error: "Failed to read thought" });
  }
});

app.post("/api/companion/thoughts", (req, res) => {
  const body = req.body;

  if (typeof body !== "object" || body === null) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }

  const record = body as {
    kind?: unknown;
    content?: unknown;
    about?: unknown;
  };

  if (typeof record.kind !== "string" || !isThoughtKind(record.kind)) {
    res.status(400).json({
      error: "kind must be unresolved, view, or question",
    });
    return;
  }

  if (typeof record.content !== "string") {
    res.status(400).json({ error: "content is required" });
    return;
  }

  if (record.about !== undefined && typeof record.about !== "string") {
    res.status(400).json({ error: "about must be a string" });
    return;
  }

  const kind: ThoughtKind = record.kind;

  try {
    const saved = thoughtStore.save({
      kind,
      content: record.content,
      about: record.about,
    });

    res.status(saved.action === "created" ? 201 : 200).json(saved.thought);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const invalid =
      message.includes("cannot be empty") ||
      message.includes("too long") ||
      message.includes("needs the matter") ||
      message.includes("cannot change who she is") ||
      message.includes("cannot invent her body");

    if (!invalid) {
      console.error("[Thought] save failed:", error);
    }

    res.status(invalid ? 400 : 500).json({
      error: invalid ? message : "Failed to save thought",
    });
  }
});

app.post("/api/companion/session-view", (req, res) => {
  const body = req.body;

  if (typeof body !== "object" || body === null) {
    res.status(400).json({ error: "Invalid body" });
    return;
  }

  const record = body as {
    about?: unknown;
    content?: unknown;
    changed?: unknown;
    held?: unknown;
  };

  if (typeof record.about !== "string" || typeof record.content !== "string") {
    res.status(400).json({ error: "about and content are required" });
    return;
  }

  if (record.changed !== undefined && typeof record.changed !== "boolean") {
    res.status(400).json({ error: "changed must be a boolean" });
    return;
  }

  const held = Array.isArray(record.held)
    ? record.held.flatMap((item) => {
        if (typeof item !== "object" || item === null) return [];

        const view = item as { about?: unknown; content?: unknown };

        if (typeof view.about !== "string" || typeof view.content !== "string") {
          return [];
        }

        return [{ about: view.about, content: view.content }];
      })
    : [];

  const result = holdSessionView(held, {
    about: record.about,
    content: record.content,
    changed: record.changed === true,
  });

  console.log("[View] session", result.action);

  res.json(result);
});

app.get("/api/companion/aside", (_req, res) => {
  try {
    const aside = asideStore.current();

    res.json({
      aside: aside ? { text: aside.text, leftAt: aside.leftAt } : null,
    });
  } catch (error) {
    console.error("[Aside] read failed:", error);
    res.status(500).json({ error: "Failed to read aside" });
  }
});

app.post("/api/affect/resume", (_req, res) => {
  try {
    const affect = affectStore.resume();
    const closeness = resolveCloseness({
      nowMs: Date.now(),
      firstSeenAt: affectStore.peekFirstSeen(),
      warmth: affectStore.peekWarmth(),
      memories: memoryStore.getAll(),
    });
    const currentAside = asideStore.current();

    if (currentAside && !currentAside.heard) asideStore.markHeard();

    asideStore.setAwayAt(new Date().toISOString());

    const opening = buildReunionOpening({
      nowMs: Date.now(),
      lastSeenAt: affect.lastSeenAt,
      tier: closeness.tier,
      unresolved: thoughtStore.list("unresolved"),
      questions: thoughtStore.list("question"),
      promises: memoryManager.listPromises(),
      dates: memoryManager.listImportantDates(),
      skip: currentAside
        ? [
            {
              key: currentAside.matterKey,
              revision: currentAside.matterRevision,
            },
          ]
        : [],
    });

    console.log("[Closeness]", closeness.tier);
    console.log("[Reunion]", opening.apart, opening.matter ?? "(greet)");
    res.json({
      ...affect,
      closeness: closeness.text,
      opening,
      aside: currentAside
        ? { text: currentAside.text, leftAt: currentAside.leftAt }
        : null,
    });
  } catch (error) {
    console.error("[Affect] resume failed:", error);
    res.status(500).json({ error: "Failed to resume affect" });
  }
});

app.post("/api/affect/settle", (_req, res) => {
  try {
    res.json(affectStore.settle());
  } catch (error) {
    console.error("[Affect] settle failed:", error);
    res.status(500).json({ error: "Failed to settle affect" });
  }
});

app.post("/api/affect/appraise", async (req, res) => {
  const userText =
    typeof req.body === "object" &&
    req.body !== null &&
    "userText" in req.body
      ? req.body.userText
      : undefined;

  if (typeof userText !== "string" || userText.trim().length < 2) {
    try {
      res.json(affectStore.settle());
    } catch (error) {
      console.error("[Affect] settle failed:", error);
      res.status(500).json({ error: "Failed to settle affect" });
    }
    return;
  }

  try {
    const cause = affectStore.peekCause();
    const expression = affectStore.peekExpression();
    const local = appraiseLocally(userText, cause, expression);
    let appraisal = local.appraisal;

    if (shouldConsultModel(userText, local.confident)) {
      try {
        const response = await gemini.models.generateContent({
          model: "gemini-3.8-flash",
          contents: appraisalPrompt(userText, cause, expression),
          config: {
            temperature: 0,
            abortSignal: AbortSignal.timeout(12_000),
            responseMimeType: "application/json",
            responseJsonSchema: affectAppraisalSchema,
          },
        });
        const parsed = parseModelAppraisal(response.text ?? "", userText);

        if (parsed) {
          const repairWithoutFriction =
            parsed.appraisal.relation === "repair" &&
            expression !== "annoyed" &&
            expression !== "wronged";

          if (!repairWithoutFriction) {
            appraisal = parsed.appraisal;
            console.log("[Affect] model toward", parsed.toward);
          }
        }
      } catch (error) {
        console.warn("[Affect] model appraisal skipped:", error);
      }
    }

    res.json(affectStore.follow(appraisal));
  } catch (error) {
    console.error("[Affect] appraisal failed:", error);
    res.status(500).json({ error: "Failed to update affect" });
  }
});

app.get(
  "/api/memory",
  (_req, res) => {
    res.json(
      memoryManager.getAll(),
    );
  },
);

app.get("/api/memory/context", (_req, res) => {
  try {
    res.json({
      context: memoryManager.getContext(),
      between: memoryManager.renderBetween(),
    });
  } catch (error) {
    console.error(
      "[Memory] context generation failed:",
      error,
    );

    res.status(500).json({
      error: "Failed to generate memory context",
    });
  }
});

app.get("/api/memory/between", (req, res) => {
  const topic = typeof req.query.topic === "string" ? req.query.topic : "";

  try {
    res.json({
      topical: memoryManager.renderBetweenTopic(topic),
    });
  } catch (error) {
    console.error("[Memory] between context failed:", error);
    res.status(500).json({ error: "Failed to read between" });
  }
});

app.get("/api/memory/relevant", async (req, res) => {
  const utterance =
    typeof req.query.utterance === "string" ? req.query.utterance : "";

  try {
    const text = await memoryManager.relevantText(utterance);
    res.json({ text });
  } catch (error) {
    console.error("[Memory] relevant recall failed:", error);
    res.status(500).json({ error: "Failed to recall relevant memories" });
  }
});

registerConsolidateRoute(app, {
  memory: memoryManager,
  thoughts: thoughtStore,
  generate: async (prompt) => {
    const response = await gemini.models.generateContent({
      model: "gemini-3.8-flash",
      contents: prompt,
      config: {
        temperature: 0.2,
        responseMimeType: "application/json",
        responseJsonSchema: consolidationResponseSchema,
      },
    });

    const text = response.text;

    if (!text?.trim()) {
      throw new Error("Empty consolidation response");
    }

    return text;
  },
});

app.patch("/api/memory/:id", (req, res) => {
  const { id } = req.params;

  const { category, content, importance } =
    req.body as {
      category?: unknown;
      content?: unknown;
      importance?: unknown;
    };

  const input: {
    category?: MemoryCategory;
    content?: string;
    importance?: MemoryImportance;
  } = {};

  if (category !== undefined) {
    if (
      typeof category !== "string" ||
      ![
        "identity",
        "preference",
        "fact",
        "event",
        "relationship",
      ].includes(category)
    ) {
      res.status(400).json({
        error: "Invalid category",
      });
      return;
    }

    input.category =
      category as MemoryCategory;
  }

  if (content !== undefined) {
    if (
      typeof content !== "string" ||
      !content.trim()
    ) {
      res.status(400).json({
        error: "Invalid content",
      });
      return;
    }

    input.content = content.trim();
  }

  if (importance !== undefined) {
    if (
      typeof importance !== "string" ||
      ![
        "low",
        "medium",
        "high",
      ].includes(importance)
    ) {
      res.status(400).json({
        error: "Invalid importance",
      });
      return;
    }

    input.importance =
      importance as MemoryImportance;
  }

  try {
    const memory =
      memoryStore.updateMemory(id, input);

    if (!memory) {
      res.status(404).json({
        error: "Memory not found",
      });
      return;
    }

    res.json(memory);
  } catch (error) {
    res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
});

app.delete("/api/memory/:id", (req, res) => {
  try {
    const removed = memoryManager.remove(req.params.id);

    if (!removed) {
      res.status(404).json({
        error: "Memory not found",
      });
      return;
    }

    res.json({ success: true });
  } catch (error) {
    console.error("[Memory] delete failed:", error);
    res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
});

app.get("/api/memory/search", async (req, res) => {
  const query = String(req.query.query ?? "").trim();
  const key = req.query.key
    ? String(req.query.key).trim()
    : undefined;

  const scopeValue = req.query.scope
    ? String(req.query.scope).trim()
    : "current";

  if (!query && !key) {
    return res.status(400).json({
      error: "query or key is required",
    });
  }

  if (
    scopeValue !== "current" &&
    scopeValue !== "historical" &&
    scopeValue !== "all"
  ) {
    return res.status(400).json({
      error:
        "scope must be current, historical, or all",
    });
  }

  try {
    const results = await memoryManager.recall({
      query,
      key,
      scope: scopeValue as
        | "current"
        | "historical"
        | "all",
    });

    return res.json(results);
  } catch (error) {
    console.error("[Memory] recall failed:", error);
    return res.status(500).json({ error: "Failed to recall memories" });
  }
});

app.post("/api/memory", (req, res) => {
  const {
    category,
    content,
    importance,
    key,
  } = req.body as {
    category?: unknown;
    content?: unknown;
    importance?: unknown;
    key?: unknown;
  };

  if (
    typeof category !== "string" ||
    typeof content !== "string" ||
    typeof importance !== "string" ||
    typeof key !== "string"
  ) {
    res.status(400).json({
      success: false,
      error: "category, content, importance and key are required",
    });
    return;
  }

  if (
    !["identity", "preference", "fact", "event", "relationship"].includes(category) ||
    !["low", "medium", "high"].includes(importance)
  ) {
    res.status(400).json({
      success: false,
      error: "Invalid category or importance",
    });
    return;
  }

  try {
    const memory = memoryManager.remember({
      category: category as
        | "identity"
        | "preference"
        | "fact"
        | "event"
        | "relationship",
      content,
      importance: importance as "low" | "medium" | "high",
      key,
      source: "user",
    });

    res.json({
      success: true,
      memory,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post("/api/memory/remember", (req, res) => {
  const {
    category,
    key,
    content,
    importance,
    source,
  } = req.body as {
    category?: unknown;
    key?: unknown;
    content?: unknown;
    importance?: unknown;
    source?: unknown;
  };

  if (
    typeof category !== "string" ||
    typeof key !== "string" ||
    typeof content !== "string" ||
    typeof importance !== "string" ||
    typeof source !== "string"
  ) {
    res.status(400).json({
      error:
        "category, key, content, importance and source are required",
    });
    return;
  }

  const validCategories = [
    "identity",
    "preference",
    "fact",
    "event",
    "relationship",
  ];

  const validImportance = [
    "low",
    "medium",
    "high",
  ];

  if (!validCategories.includes(category)) {
    res.status(400).json({
      error: "Invalid category",
    });
    return;
  }

  if (!validImportance.includes(importance)) {
    res.status(400).json({
      error: "Invalid importance",
    });
    return;
  }

  if (source !== "user") {
    res.status(400).json({
      error: "Invalid memory source",
    });
    return;
  }

  try {
    const result =
      memoryManager.remember({
        category:
          category as MemoryCategory,

        key: key.trim(),

        content: content.trim(),

        importance:
          importance as MemoryImportance,

        source: "user",
      });

    console.log(
      `[Memory] ${result.action}:`,
      result.memory,
    );

    res.json(result);
  } catch (error) {
    console.error(
      "[Memory] remember failed:",
      error,
    );

    res.status(500).json({
      error:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
});

app.post("/api/memory/forget", (req, res) => {
  const { key, targetContent } = req.body as {
    key?: unknown;
    targetContent?: unknown;
  };

  if (
    typeof key !== "string" ||
    !key.trim() ||
    typeof targetContent !== "string" ||
    !targetContent.trim()
  ) {
    res.status(400).json({
      success: false,
      error: "key and targetContent are required",
    });
    return;
  }

  try {
    const memory = memoryManager.forget(
      key.trim(),
      targetContent.trim(),
    );

    if (!memory) {
      res.status(404).json({
        success: false,
        error: "No matching current memory found",
      });
      return;
    }

    console.log("[Memory] forgotten:", {
      key: memory.key,
      content: memory.content,
      status: memory.status,
    });

    res.json({
      success: true,
      memory,
    });
  } catch (error) {
    console.error("[Memory] forget failed:", error);

    res.status(400).json({
      success: false,
      error:
        error instanceof Error
          ? error.message
          : String(error),
    });
  }
});

// 到期的提醒：人在语音里交给她说，人不在就留下那一句。
app.get("/api/tasks/reminders", async (req, res) => {
  const voiceOpen = req.query.voice === "1";

  try {
    const queuedTasks = await db
      .select()
      .from(tasks)
      .where(eq(tasks.reminderSent, "queued"))
      .orderBy(asc(tasks.reminderAt));

    const reminders: Array<{
      id: string;
      line: string;
      delivery: "speak" | "left";
      leftAt?: string;
      claimedAt?: string;
    }> = [];

    for (const task of queuedTasks) {
      const matter = {
        id: task.id,
        title: task.title,
        dueAt: task.dueAt,
        reminderAt: task.reminderAt,
      };
      const ref = dueRef(matter);
      const delivery = deliverReminder({
        voiceOpen,
        task: matter,
        alreadySpoken: asideStore.hasSpoken(ref.key, ref.revision),
      });

      if (delivery.action === "skip") {
        claimQueuedReminder(task.id, "true");
        continue;
      }

      if (delivery.action === "leave") {
        // 未听完的 aside 仍在有效期内：不覆盖、不领取，保持 queued 稍后重试。
        if (
          shouldProtectUnheardAside({
            current: asideStore.current(),
            nowMs: Date.now(),
          })
        ) {
          continue;
        }

        if (!claimQueuedReminder(task.id, "true")) continue;

        const leftAt = new Date().toISOString();

        asideStore.leave({
          text: delivery.line,
          leftAt,
          matterKey: delivery.matterKey,
          matterRevision: delivery.matterRevision,
        });
        console.log("[Reminder] left", delivery.line);
        reminders.push({
          id: task.id,
          line: delivery.line,
          delivery: "left",
          leftAt,
        });
        continue;
      }

      const claimedAt = claimQueuedReminder(task.id, "speaking");
      if (!claimedAt) continue;

      console.log("[Reminder] speak", delivery.line);
      reminders.push({
        id: task.id,
        line: delivery.line,
        delivery: "speak",
        claimedAt,
      });
    }

    res.json({
      success: true,
      reminders,
    });
  } catch (error) {
    console.error("获取待办提醒失败：", error);
    res.status(500).json({
      success: false,
      error: "获取待办提醒失败",
    });
  }
});

// 语音里说完 / 没说成留下：租约逻辑见 reminderLease.settleReminderFromBody。
app.post("/api/tasks/reminders/settle", (req, res) => {
  const result = settleReminderFromBody(req.body);
  res.status(result.status).json(result.json);
});
