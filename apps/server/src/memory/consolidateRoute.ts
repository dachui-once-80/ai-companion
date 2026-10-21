/**
 * `/api/memory/consolidate` 路由注册（生产与 HTTP 离线集成测试共用）。
 * 依赖由调用方注入；本模块不打开数据库、不读 .env、不创建 Express app。
 */

import type { Express, Request, Response } from "express";

import type { ThoughtStore } from "../companion/ThoughtStore";
import type { MemoryManager } from "./MemoryManager";
import {
  consolidateConversation,
  httpBodyForConsolidationError,
} from "./consolidate";

export type ConsolidateRouteDeps = {
  memory: MemoryManager;
  thoughts: ThoughtStore;
  generate: (prompt: string) => Promise<string>;
};

/**
 * 在已有 Express app 上注册 consolidate POST。
 * handler 在请求时读取 `deps` 当前字段，便于测试替换 memory／generate。
 */
export function registerConsolidateRoute(
  app: Express,
  deps: ConsolidateRouteDeps,
): void {
  app.post("/api/memory/consolidate", async (req: Request, res: Response) => {
    try {
      const result = await consolidateConversation({
        body: req.body,
        memory: deps.memory,
        thoughts: deps.thoughts,
        generate: deps.generate,
      });

      console.log("[Memory] consolidated:", result.saved);
      res.json(result);
    } catch (error) {
      const mapped = httpBodyForConsolidationError(error);

      if (mapped.status === 200 && "retryAfterMs" in mapped.json) {
        const seconds = Math.max(
          1,
          Math.round(Number(mapped.json.retryAfterMs) / 1000),
        );
        console.warn(
          `[Memory] consolidation paused for ${seconds}s (quota)`,
        );
        res.json(mapped.json);
        return;
      }

      if (mapped.status >= 500) {
        console.error("[Memory] consolidation failed:", error);
      }

      res.status(mapped.status).json(mapped.json);
    }
  });
}
