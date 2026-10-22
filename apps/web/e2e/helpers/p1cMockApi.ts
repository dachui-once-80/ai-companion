/**
 * P1-C mock 路由。纯函数，不监听端口，不转发请求。
 */

import { createHash } from "node:crypto";
import { CONSOLIDATION_SAVED_KEYS } from "../../src/realtime/consolidateResult.ts";
import { assertExplicitListenPort } from "./p1cApiOrigin.ts";

export type P1cMode = "success" | "disconnect";

export type P1cTurnSummary = {
  role: string;
  textLength: number;
  textHash: string;
};

export type P1cConsolidateLog = {
  url: string;
  batchId: string | null;
  payloadHash: string | null;
  occurredOn: string | null;
  turns: P1cTurnSummary[] | null;
  responseStatus: number | null;
  outcome: "responded" | "disconnected";
  enteredAt: string;
  receivedAt: string;
  closedAt: string | null;
};

export type P1cUnexpectedLog = {
  method: string;
  path: string;
  status: 404 | 413;
};

export type P1cDecision =
  | {
      kind: "json";
      status: number;
      body: unknown;
      unexpected: P1cUnexpectedLog | null;
      consolidate: P1cConsolidateLog | null;
    }
  | {
      kind: "disconnect";
      consolidate: P1cConsolidateLog;
    };

export function p1cConsolidationSuccessBody(): {
  saved: Record<(typeof CONSOLIDATION_SAVED_KEYS)[number], number>;
} {
  const saved = {} as Record<(typeof CONSOLIDATION_SAVED_KEYS)[number], number>;

  for (const key of CONSOLIDATION_SAVED_KEYS) {
    saved[key] = 0;
  }

  return { saved };
}

export const P1C_IDENTITY_BODY = { currentName: "p1c" } as const;

export const P1C_AFFECT_BODY = {
  expression: "calm",
  cause: "p1c",
  mood: "steady",
  updatedAt: "2026-10-21T06:00:00.000Z",
} as const;

export const P1C_REMINDERS_BODY = { success: true, reminders: [] } as const;

export const P1C_ASIDE_BODY = {} as const;

function pathnameOf(url: string): string {
  const path = new URL(url, "http://127.0.0.1").pathname.replace(/\/+$/, "");

  return path.length > 0 ? path : "/";
}

export function summarizeP1cTurns(
  turns: readonly { role: string; text: string }[],
): P1cTurnSummary[] {
  return turns.map((turn) => ({
    role: turn.role,
    textLength: turn.text.length,
    textHash: createHash("sha256").update(turn.text).digest("hex"),
  }));
}

function readTurnSummaries(value: unknown): P1cTurnSummary[] | null {
  if (!Array.isArray(value)) return null;

  const turns: { role: string; text: string }[] = [];

  for (const turn of value) {
    if (typeof turn !== "object" || turn === null) {
      turns.push({ role: "", text: "" });
      continue;
    }

    const record = turn as { role?: unknown; text?: unknown };

    turns.push({
      role: typeof record.role === "string" ? record.role : "",
      text: typeof record.text === "string" ? record.text : "",
    });
  }

  return summarizeP1cTurns(turns);
}

function readBatch(body: string): {
  batchId: string | null;
  payloadHash: string | null;
  occurredOn: string | null;
  turns: P1cTurnSummary[] | null;
} {
  try {
    const parsed = JSON.parse(body) as {
      batchId?: unknown;
      payloadHash?: unknown;
      occurredOn?: unknown;
      turns?: unknown;
    };

    return {
      batchId: typeof parsed.batchId === "string" ? parsed.batchId : null,
      payloadHash:
        typeof parsed.payloadHash === "string" ? parsed.payloadHash : null,
      occurredOn: typeof parsed.occurredOn === "string" ? parsed.occurredOn : null,
      turns: readTurnSummaries(parsed.turns),
    };
  } catch {
    return { batchId: null, payloadHash: null, occurredOn: null, turns: null };
  }
}

export function decideP1cRequest(input: {
  method: string;
  url: string;
  body: string;
  mode: P1cMode;
  enteredAt: string;
  receivedAt: string;
}): P1cDecision {
  const method = input.method.toUpperCase();
  const path = pathnameOf(input.url);

  if (input.body.length > 262_144) {
    return {
      kind: "json",
      status: 413,
      body: { error: "p1c_unexpected_request" },
      unexpected: { method, path, status: 413 },
      consolidate: null,
    };
  }

  if (method === "POST" && path === "/api/memory/consolidate") {
    const identity = readBatch(input.body);
    const base = {
      url: input.url,
      batchId: identity.batchId,
      payloadHash: identity.payloadHash,
      occurredOn: identity.occurredOn,
      turns: identity.turns,
      enteredAt: input.enteredAt,
      receivedAt: input.receivedAt,
      closedAt: null,
    };

    if (input.mode === "disconnect") {
      return {
        kind: "disconnect",
        consolidate: {
          ...base,
          responseStatus: null,
          outcome: "disconnected",
        },
      };
    }

    return {
      kind: "json",
      status: 200,
      body: p1cConsolidationSuccessBody(),
      unexpected: null,
      consolidate: {
        ...base,
        responseStatus: 200,
        outcome: "responded",
      },
    };
  }

  if (method === "GET" && path === "/api/companion/identity") {
    return {
      kind: "json",
      status: 200,
      body: P1C_IDENTITY_BODY,
      unexpected: null,
      consolidate: null,
    };
  }

  if (method === "POST" && path === "/api/affect/settle") {
    return {
      kind: "json",
      status: 200,
      body: P1C_AFFECT_BODY,
      unexpected: null,
      consolidate: null,
    };
  }

  if (method === "GET" && path === "/api/tasks/reminders") {
    return {
      kind: "json",
      status: 200,
      body: P1C_REMINDERS_BODY,
      unexpected: null,
      consolidate: null,
    };
  }

  if (method === "GET" && path === "/api/companion/aside") {
    return {
      kind: "json",
      status: 200,
      body: P1C_ASIDE_BODY,
      unexpected: null,
      consolidate: null,
    };
  }

  const status = 404;

  return {
    kind: "json",
    status,
    body: { error: "p1c_unexpected_request" },
    unexpected: { method, path, status },
    consolidate: null,
  };
}

export function assertP1cListenPort(port: number): void {
  assertExplicitListenPort(port);
}
