/**
 * 提醒 speak 租约：claim / settle 的共享逻辑（路由与离线测试共用）。
 *
 * 租约身份 = 领取时写入的 updatedAt（ISO 毫秒），settle 必须原样带回为 claimedAt。
 * 无独立 claim token 列（避免迁移）；身份靠条件 UPDATE 校验，不靠 SELECT 后 JS 判断。
 */

import { and, eq } from "drizzle-orm";

import { db } from "../db";
import { tasks } from "../db/schema";
import { asideStore } from "./AsideStore";
import {
  dueRef,
  dueReminderLine,
  shouldProtectUnheardAside,
} from "./aside";

/** @returns 领取成功时的 claimedAt（= updatedAt）；失败 null */
export function claimQueuedReminder(
  id: string,
  next: "speaking" | "true",
): string | null {
  const claimedAt = new Date().toISOString();
  const claimed = db
    .update(tasks)
    .set({
      reminderSent: next,
      updatedAt: claimedAt,
    })
    .where(and(eq(tasks.id, id), eq(tasks.reminderSent, "queued")))
    .run();

  return claimed.changes > 0 ? claimedAt : null;
}

function finishSpeakingLease(id: string, claimedAt: string): boolean {
  const result = db
    .update(tasks)
    .set({
      reminderSent: "true",
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(tasks.id, id),
        eq(tasks.reminderSent, "speaking"),
        eq(tasks.updatedAt, claimedAt),
      ),
    )
    .run();

  return result.changes > 0;
}

function deferSpeakingLease(id: string, claimedAt: string): boolean {
  const result = db
    .update(tasks)
    .set({
      reminderSent: "queued",
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(tasks.id, id),
        eq(tasks.reminderSent, "speaking"),
        eq(tasks.updatedAt, claimedAt),
      ),
    )
    .run();

  return result.changes > 0;
}

function reminderSentOf(id: string): string | null {
  const row = db.select().from(tasks).where(eq(tasks.id, id)).get();
  return row?.reminderSent ?? null;
}

export type SettleReminderBody = {
  id?: unknown;
  heard?: unknown;
  claimedAt?: unknown;
};

export type SettleReminderHttp = {
  status: number;
  json: {
    success: boolean;
    deferred?: boolean;
    stale?: boolean;
    line?: string | null;
    leftAt?: string | null;
    error?: string;
  };
};

/**
 * 生产 settle 路由与测试共用的入口。
 * speaking 必须带 claimedAt；finish / deferred 均条件 UPDATE。
 */
export function settleReminderFromBody(
  body: SettleReminderBody,
): SettleReminderHttp {
  if (typeof body.id !== "string" || !body.id.trim()) {
    return {
      status: 400,
      json: { success: false, error: "id is required" },
    };
  }

  if (typeof body.heard !== "boolean") {
    return {
      status: 400,
      json: { success: false, error: "heard must be a boolean" },
    };
  }

  const id = body.id.trim();
  const heard = body.heard;
  const claimedAt =
    typeof body.claimedAt === "string" && body.claimedAt.trim()
      ? body.claimedAt.trim()
      : null;

  try {
    const task = db.select().from(tasks).where(eq(tasks.id, id)).get();

    if (!task) {
      return {
        status: 404,
        json: { success: false, error: "未找到待办" },
      };
    }

    // 已完成：幂等成功（不要求 claimedAt）。
    if (task.reminderSent === "true") {
      return {
        status: 200,
        json: {
          success: true,
          deferred: false,
          line: null,
          leftAt: null,
        },
      };
    }

    // 非 speaking（含回收后的 queued）：旧领取者不得完成。
    if (task.reminderSent !== "speaking") {
      return {
        status: 409,
        json: {
          success: false,
          stale: true,
          error: "stale reminder claim",
        },
      };
    }

    // speaking 必须携带租约身份。
    if (!claimedAt) {
      return {
        status: 409,
        json: {
          success: false,
          stale: true,
          error: "claimedAt required for speaking lease",
        },
      };
    }

    const matter = {
      id: task.id,
      title: task.title,
      dueAt: task.dueAt,
      reminderAt: task.reminderAt,
    };
    const ref = dueRef(matter);
    const line = dueReminderLine(task.title);

    if (heard) {
      if (!finishSpeakingLease(id, claimedAt)) {
        if (reminderSentOf(id) === "true") {
          return {
            status: 200,
            json: {
              success: true,
              deferred: false,
              line: null,
              leftAt: null,
            },
          };
        }

        return {
          status: 409,
          json: {
            success: false,
            stale: true,
            error: "stale reminder claim",
          },
        };
      }

      asideStore.noteSpoken(ref.key, ref.revision);
      return {
        status: 200,
        json: {
          success: true,
          deferred: false,
          line: null,
          leftAt: null,
        },
      };
    }

    if (
      line &&
      !asideStore.hasSpoken(ref.key, ref.revision) &&
      shouldProtectUnheardAside({
        current: asideStore.current(),
        nowMs: Date.now(),
      })
    ) {
      if (!deferSpeakingLease(id, claimedAt)) {
        if (reminderSentOf(id) === "true") {
          return {
            status: 200,
            json: {
              success: true,
              deferred: false,
              line: null,
              leftAt: null,
            },
          };
        }

        return {
          status: 409,
          json: {
            success: false,
            stale: true,
            error: "stale reminder claim",
          },
        };
      }

      return {
        status: 200,
        json: {
          success: true,
          deferred: true,
          line: null,
          leftAt: null,
        },
      };
    }

    // 先原子 finish，再 leave，避免租约失败时误写 Aside。
    if (!finishSpeakingLease(id, claimedAt)) {
      if (reminderSentOf(id) === "true") {
        return {
          status: 200,
          json: {
            success: true,
            deferred: false,
            line: null,
            leftAt: null,
          },
        };
      }

      return {
        status: 409,
        json: {
          success: false,
          stale: true,
          error: "stale reminder claim",
        },
      };
    }

    let leftAt: string | null = null;

    if (line && !asideStore.hasSpoken(ref.key, ref.revision)) {
      leftAt = new Date().toISOString();
      asideStore.leave({
        text: line,
        leftAt,
        matterKey: ref.key,
        matterRevision: ref.revision,
      });
      console.log("[Reminder] left", line);
    }

    return {
      status: 200,
      json: {
        success: true,
        deferred: false,
        line: leftAt ? line : null,
        leftAt,
      },
    };
  } catch (error) {
    console.error("[Reminder] settle failed:", error);
    return {
      status: 500,
      json: { success: false, error: "记录提醒结果失败" },
    };
  }
}
