/**
 * consolidation outbox 持久化层（localStorage）。
 * 本阶段仅存储：不发送、不 drain、不接入 RealtimeClient。
 */

import {
  CONSOLIDATION_MAX_TURN_CHARS,
  type ConsolidationPayloadTurn,
} from "./consolidationPayload.ts";

export const CONSOLIDATION_OUTBOX_STORAGE_KEY =
  "ai-companion.consolidationOutbox.v1";

export const CONSOLIDATION_OUTBOX_VERSION = 1;
export const CONSOLIDATION_OUTBOX_MAX_ITEMS = 32;
export const CONSOLIDATION_OUTBOX_MAX_TURNS = 40;
export const CONSOLIDATION_OUTBOX_MAX_SERIALIZED_CHARS = 450_000;

export type ConsolidationOutboxStatus =
  | "pending"
  | "in_flight"
  | "dead_letter";

export type ConsolidationOutboxItem = {
  batchId: string;
  payloadHash: string;
  occurredOn: string;
  turns: ConsolidationPayloadTurn[];
  createdAt: string;
  updatedAt: string;
  attempts: number;
  /** pending 可再次发送的最早时刻（退避）；不是 in_flight 租约到期。 */
  nextAttemptAt: string;
  status: ConsolidationOutboxStatus;
  lastError: string | null;
  leaseOwner: string | null;
  /**
   * in_flight 租约到期时刻（UTC ISO Z）。
   * 旧 localStorage 条目可能缺省此字段 → 解析为 null。
   * null 的 in_flight 不得被猜测抢占（见 drain）。
   */
  leaseExpiresAt: string | null;
};

export type ConsolidationOutboxEnvelope = {
  v: number;
  updatedAt: string;
  items: ConsolidationOutboxItem[];
};

export type ConsolidationOutboxStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type AddConsolidationOutboxInput = {
  batchId: string;
  payloadHash: string;
  occurredOn: string;
  turns: readonly ConsolidationPayloadTurn[];
  /** 可选；缺省用 nowIso */
  createdAt?: string;
  nextAttemptAt?: string;
  status?: ConsolidationOutboxStatus;
  lastError?: string | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
};

export type UpdateConsolidationOutboxInput = {
  status?: ConsolidationOutboxStatus;
  attempts?: number;
  nextAttemptAt?: string;
  lastError?: string | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
};

export class ConsolidationOutboxError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ConsolidationOutboxError";
    this.code = code;
  }
}

export class ConsolidationOutboxCorruptError extends ConsolidationOutboxError {
  constructor(message: string) {
    super("corrupt", message);
    this.name = "ConsolidationOutboxCorruptError";
  }
}

export class ConsolidationOutboxConflictError extends ConsolidationOutboxError {
  constructor(message: string) {
    super("conflict", message);
    this.name = "ConsolidationOutboxConflictError";
  }
}

export class ConsolidationOutboxCapacityError extends ConsolidationOutboxError {
  constructor(message: string) {
    super("capacity", message);
    this.name = "ConsolidationOutboxCapacityError";
  }
}

export class ConsolidationOutboxUnavailableError extends ConsolidationOutboxError {
  constructor(message: string) {
    super("unavailable", message);
    this.name = "ConsolidationOutboxUnavailableError";
  }
}

export class ConsolidationOutboxTransitionError extends ConsolidationOutboxError {
  constructor(message: string) {
    super("invalid_transition", message);
    this.name = "ConsolidationOutboxTransitionError";
  }
}

const BATCH_ID_RE = /^[A-Za-z0-9._:-]+$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * outbox 时间戳：UTC ISO-8601，必须以 Z 结尾（同 Date#toISOString）。
 * 捕获组用于真实日历校验，不单靠 Date.parse（其会接受 02-31 等溢出）。
 */
const ISO_INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const STATUSES = new Set<ConsolidationOutboxStatus>([
  "pending",
  "in_flight",
  "dead_letter",
]);

/**
 * 普通 update 允许的状态转换（不含死信复活）：
 * - pending ↔ in_flight
 * - pending / in_flight → dead_letter
 * - dead_letter 仅可保持 dead_letter（改其它字段）
 * 死信 → pending|in_flight 必须走 reviveDeadLetter。
 */
function assertUpdateStatusTransition(
  from: ConsolidationOutboxStatus,
  to: ConsolidationOutboxStatus,
): void {
  if (from === to) return;

  if (from === "dead_letter") {
    throw new ConsolidationOutboxTransitionError(
      "dead_letter cannot leave via update; use reviveDeadLetter",
    );
  }

  if (to === "pending" || to === "in_flight" || to === "dead_letter") {
    return;
  }

  throw new ConsolidationOutboxTransitionError(
    `invalid status transition: ${from} → ${to}`,
  );
}

function defaultNowIso(): string {
  return new Date().toISOString();
}

function isIsoInstant(value: string): boolean {
  const match = ISO_INSTANT_RE.exec(value);

  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "0";
  const millisecond = Number(fraction.padEnd(3, "0"));

  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    !Number.isInteger(second) ||
    !Number.isInteger(millisecond)
  ) {
    return false;
  }

  if (month < 1 || month > 12) return false;
  if (hour > 23 || minute > 59 || second > 59 || millisecond > 999) return false;

  // 用 UTC 组件回读：Date.UTC 会溢出非法日（如 02-31），回读即可拒绝。
  const utc = new Date(
    Date.UTC(year, month - 1, day, hour, minute, second, millisecond),
  );

  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() === month - 1 &&
    utc.getUTCDate() === day &&
    utc.getUTCHours() === hour &&
    utc.getUTCMinutes() === minute &&
    utc.getUTCSeconds() === second &&
    utc.getUTCMilliseconds() === millisecond
  );
}

function requireIsoInstant(value: string, label: string): void {
  if (!isIsoInstant(value)) {
    throw new ConsolidationOutboxError(
      "invalid_input",
      `${label} must be a UTC ISO-8601 instant ending in Z`,
    );
  }
}

function resolveStorage(
  storage: ConsolidationOutboxStorage | undefined,
): ConsolidationOutboxStorage {
  if (storage) return storage;

  try {
    if (typeof globalThis.localStorage === "undefined") {
      throw new ConsolidationOutboxUnavailableError(
        "localStorage is not available",
      );
    }

    return globalThis.localStorage;
  } catch (error) {
    if (error instanceof ConsolidationOutboxError) throw error;

    throw new ConsolidationOutboxUnavailableError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

function readRaw(
  storage: ConsolidationOutboxStorage,
  key: string,
): string | null {
  try {
    return storage.getItem(key);
  } catch (error) {
    throw new ConsolidationOutboxUnavailableError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

function writeRaw(
  storage: ConsolidationOutboxStorage,
  key: string,
  value: string,
): void {
  if (value.length > CONSOLIDATION_OUTBOX_MAX_SERIALIZED_CHARS) {
    throw new ConsolidationOutboxCapacityError(
      `outbox serialized size exceeds ${CONSOLIDATION_OUTBOX_MAX_SERIALIZED_CHARS} characters`,
    );
  }

  try {
    storage.setItem(key, value);
  } catch (error) {
    throw new ConsolidationOutboxUnavailableError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

function isTurn(value: unknown): value is ConsolidationPayloadTurn {
  if (typeof value !== "object" || value === null) return false;

  const turn = value as Record<string, unknown>;

  if (
    turn.role !== "user" &&
    turn.role !== "companion" &&
    turn.role !== "overheard"
  ) {
    return false;
  }

  if (typeof turn.text !== "string") return false;
  if (turn.text.length === 0) return false;
  if (turn.text.length > CONSOLIDATION_MAX_TURN_CHARS) return false;
  if (turn.text.includes("内部状态")) return false;

  return true;
}

function parseItem(value: unknown): ConsolidationOutboxItem | null {
  if (typeof value !== "object" || value === null) return null;

  const row = value as Record<string, unknown>;

  if (typeof row.batchId !== "string" || !BATCH_ID_RE.test(row.batchId)) {
    return null;
  }

  if (row.batchId.length === 0 || row.batchId.length > 128) return null;

  if (typeof row.payloadHash !== "string" || !HASH_RE.test(row.payloadHash)) {
    return null;
  }

  if (typeof row.occurredOn !== "string" || !DATE_RE.test(row.occurredOn)) {
    return null;
  }

  if (!Array.isArray(row.turns) || row.turns.length === 0) return null;
  if (row.turns.length > CONSOLIDATION_OUTBOX_MAX_TURNS) return null;
  if (!row.turns.every(isTurn)) return null;

  if (typeof row.createdAt !== "string" || !isIsoInstant(row.createdAt)) {
    return null;
  }

  if (typeof row.updatedAt !== "string" || !isIsoInstant(row.updatedAt)) {
    return null;
  }

  if (typeof row.attempts !== "number" || !Number.isFinite(row.attempts)) {
    return null;
  }

  if (row.attempts < 0) return null;

  if (
    typeof row.nextAttemptAt !== "string" ||
    !isIsoInstant(row.nextAttemptAt)
  ) {
    return null;
  }

  if (typeof row.status !== "string" || !STATUSES.has(row.status as ConsolidationOutboxStatus)) {
    return null;
  }

  if (row.lastError !== null && typeof row.lastError !== "string") return null;
  if (row.leaseOwner !== null && typeof row.leaseOwner !== "string") return null;

  // 兼容旧信封：缺省 leaseExpiresAt → null（不可靠租约，drain 不得猜测抢占）。
  let leaseExpiresAt: string | null = null;

  if ("leaseExpiresAt" in row && row.leaseExpiresAt !== undefined) {
    if (row.leaseExpiresAt === null) {
      leaseExpiresAt = null;
    } else if (
      typeof row.leaseExpiresAt === "string" &&
      isIsoInstant(row.leaseExpiresAt)
    ) {
      leaseExpiresAt = row.leaseExpiresAt;
    } else {
      return null;
    }
  }

  return {
    batchId: row.batchId,
    payloadHash: row.payloadHash,
    occurredOn: row.occurredOn,
    turns: row.turns.map((turn) => ({
      role: (turn as ConsolidationPayloadTurn).role,
      text: (turn as ConsolidationPayloadTurn).text,
    })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    status: row.status as ConsolidationOutboxStatus,
    lastError: row.lastError as string | null,
    leaseOwner: row.leaseOwner as string | null,
    leaseExpiresAt,
  };
}

function parseEnvelope(raw: string): ConsolidationOutboxEnvelope {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConsolidationOutboxCorruptError(
      "outbox JSON is not parseable; storage left unchanged",
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConsolidationOutboxCorruptError(
      "outbox envelope is not an object; storage left unchanged",
    );
  }

  const record = parsed as Record<string, unknown>;

  if (record.v !== CONSOLIDATION_OUTBOX_VERSION) {
    throw new ConsolidationOutboxCorruptError(
      `unsupported outbox version ${String(record.v)}; storage left unchanged`,
    );
  }

  if (typeof record.updatedAt !== "string" || !isIsoInstant(record.updatedAt)) {
    throw new ConsolidationOutboxCorruptError(
      "outbox updatedAt missing or invalid; storage left unchanged",
    );
  }

  if (!Array.isArray(record.items)) {
    throw new ConsolidationOutboxCorruptError(
      "outbox items missing; storage left unchanged",
    );
  }

  if (record.items.length > CONSOLIDATION_OUTBOX_MAX_ITEMS) {
    throw new ConsolidationOutboxCorruptError(
      "outbox exceeds max items; storage left unchanged",
    );
  }

  const items: ConsolidationOutboxItem[] = [];
  const seen = new Set<string>();

  for (const entry of record.items) {
    const item = parseItem(entry);

    if (!item) {
      throw new ConsolidationOutboxCorruptError(
        "outbox contains an invalid item; storage left unchanged",
      );
    }

    if (seen.has(item.batchId)) {
      throw new ConsolidationOutboxCorruptError(
        "outbox contains duplicate batchId; storage left unchanged",
      );
    }

    seen.add(item.batchId);
    items.push(item);
  }

  return {
    v: CONSOLIDATION_OUTBOX_VERSION,
    updatedAt: record.updatedAt,
    items,
  };
}

function emptyEnvelope(nowIso: string): ConsolidationOutboxEnvelope {
  return {
    v: CONSOLIDATION_OUTBOX_VERSION,
    updatedAt: nowIso,
    items: [],
  };
}

function serializeEnvelope(envelope: ConsolidationOutboxEnvelope): string {
  return JSON.stringify({
    v: envelope.v,
    updatedAt: envelope.updatedAt,
    items: envelope.items.map((item) => ({
      batchId: item.batchId,
      payloadHash: item.payloadHash,
      occurredOn: item.occurredOn,
      turns: item.turns.map((turn) => ({
        role: turn.role,
        text: turn.text,
      })),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      attempts: item.attempts,
      nextAttemptAt: item.nextAttemptAt,
      status: item.status,
      lastError: item.lastError,
      leaseOwner: item.leaseOwner,
      leaseExpiresAt: item.leaseExpiresAt,
    })),
  });
}

function validateAddInput(input: AddConsolidationOutboxInput): void {
  if (typeof input.batchId !== "string" || !input.batchId.trim()) {
    throw new ConsolidationOutboxError("invalid_input", "batchId is required");
  }

  const batchId = input.batchId.trim();

  if (batchId.length > 128 || !BATCH_ID_RE.test(batchId)) {
    throw new ConsolidationOutboxError("invalid_input", "batchId is invalid");
  }

  if (typeof input.payloadHash !== "string" || !HASH_RE.test(input.payloadHash)) {
    throw new ConsolidationOutboxError(
      "invalid_input",
      "payloadHash must be a sha256 hex digest",
    );
  }

  if (typeof input.occurredOn !== "string" || !DATE_RE.test(input.occurredOn)) {
    throw new ConsolidationOutboxError(
      "invalid_input",
      "occurredOn must be YYYY-MM-DD",
    );
  }

  if (!Array.isArray(input.turns) || input.turns.length === 0) {
    throw new ConsolidationOutboxError("invalid_input", "turns are required");
  }

  if (input.turns.length > CONSOLIDATION_OUTBOX_MAX_TURNS) {
    throw new ConsolidationOutboxError(
      "invalid_input",
      `at most ${CONSOLIDATION_OUTBOX_MAX_TURNS} turns`,
    );
  }

  for (const turn of input.turns) {
    if (!isTurn(turn)) {
      throw new ConsolidationOutboxError(
        "invalid_input",
        "turn is invalid, empty, too long, or not normalized",
      );
    }
  }

  if (input.status !== undefined && !STATUSES.has(input.status)) {
    throw new ConsolidationOutboxError("invalid_input", "status is invalid");
  }

  if (input.createdAt !== undefined) {
    requireIsoInstant(input.createdAt, "createdAt");
  }

  if (input.nextAttemptAt !== undefined) {
    requireIsoInstant(input.nextAttemptAt, "nextAttemptAt");
  }

  if (
    input.leaseExpiresAt !== undefined &&
    input.leaseExpiresAt !== null
  ) {
    requireIsoInstant(input.leaseExpiresAt, "leaseExpiresAt");
  }
}

export type ConsolidationOutboxOptions = {
  storage?: ConsolidationOutboxStorage;
  storageKey?: string;
  now?: () => string;
};

/**
 * 前端 consolidation outbox。构造时不读盘；首次读写才访问 Storage。
 */
export class ConsolidationOutbox {
  private readonly storage: ConsolidationOutboxStorage;
  private readonly storageKey: string;
  private readonly now: () => string;

  constructor(options: ConsolidationOutboxOptions = {}) {
    this.storage = resolveStorage(options.storage);
    this.storageKey = options.storageKey ?? CONSOLIDATION_OUTBOX_STORAGE_KEY;
    this.now = options.now ?? defaultNowIso;
  }

  /** 读取完整信封；无 key → 空信封（不写盘）。损坏 → 抛错且不覆盖。 */
  load(): ConsolidationOutboxEnvelope {
    const raw = readRaw(this.storage, this.storageKey);

    if (raw === null || raw === "") {
      return emptyEnvelope(this.now());
    }

    return parseEnvelope(raw);
  }

  list(): ConsolidationOutboxItem[] {
    return this.load().items.map(cloneItem);
  }

  listDeadLetters(): ConsolidationOutboxItem[] {
    return this.list().filter((item) => item.status === "dead_letter");
  }

  get(batchId: string): ConsolidationOutboxItem | null {
    const found = this.load().items.find((item) => item.batchId === batchId);
    return found ? cloneItem(found) : null;
  }

  /**
   * 持久化成功后才返回条目。
   * 同 batchId+hash → 幂等返回已有；同 ID 异 hash → Conflict。
   */
  add(input: AddConsolidationOutboxInput): ConsolidationOutboxItem {
    validateAddInput(input);

    const batchId = input.batchId.trim();
    const envelope = this.load();
    const existing = envelope.items.find((item) => item.batchId === batchId);

    if (existing) {
      if (existing.payloadHash !== input.payloadHash) {
        throw new ConsolidationOutboxConflictError(
          "batchId was already used with a different payloadHash",
        );
      }

      return cloneItem(existing);
    }

    if (envelope.items.length >= CONSOLIDATION_OUTBOX_MAX_ITEMS) {
      throw new ConsolidationOutboxCapacityError(
        `outbox is full (max ${CONSOLIDATION_OUTBOX_MAX_ITEMS} items); refusing to drop existing records`,
      );
    }

    const nowIso = this.now();
    requireIsoInstant(nowIso, "now");

    const item: ConsolidationOutboxItem = {
      batchId,
      payloadHash: input.payloadHash,
      occurredOn: input.occurredOn,
      turns: input.turns.map((turn) => ({ role: turn.role, text: turn.text })),
      createdAt: input.createdAt ?? nowIso,
      updatedAt: nowIso,
      attempts: 0,
      nextAttemptAt: input.nextAttemptAt ?? nowIso,
      status: input.status ?? "pending",
      lastError: input.lastError ?? null,
      leaseOwner: input.leaseOwner ?? null,
      leaseExpiresAt: input.leaseExpiresAt ?? null,
    };

    const next: ConsolidationOutboxEnvelope = {
      v: CONSOLIDATION_OUTBOX_VERSION,
      updatedAt: nowIso,
      items: [...envelope.items, item],
    };

    this.persist(next);
    // persist 已返回即写入完成。其后的拷贝失败不得再抛，否则调用方会把成功写成不确定。
    try {
      return cloneItem(item);
    } catch (error) {
      console.warn(
        "[Memory] consolidation outbox add persisted but clone failed:",
        error,
      );
      return item;
    }
  }

  update(
    batchId: string,
    patch: UpdateConsolidationOutboxInput,
  ): ConsolidationOutboxItem {
    if (patch.status !== undefined && !STATUSES.has(patch.status)) {
      throw new ConsolidationOutboxError("invalid_input", "status is invalid");
    }

    if (
      patch.attempts !== undefined &&
      (typeof patch.attempts !== "number" ||
        !Number.isFinite(patch.attempts) ||
        patch.attempts < 0)
    ) {
      throw new ConsolidationOutboxError("invalid_input", "attempts is invalid");
    }

    if (patch.nextAttemptAt !== undefined) {
      requireIsoInstant(patch.nextAttemptAt, "nextAttemptAt");
    }

    if (
      patch.leaseExpiresAt !== undefined &&
      patch.leaseExpiresAt !== null
    ) {
      requireIsoInstant(patch.leaseExpiresAt, "leaseExpiresAt");
    }

    const envelope = this.load();
    const index = envelope.items.findIndex((item) => item.batchId === batchId);

    if (index < 0) {
      throw new ConsolidationOutboxError("not_found", `batchId not found: ${batchId}`);
    }

    const current = envelope.items[index]!;
    const nextStatus = patch.status ?? current.status;
    assertUpdateStatusTransition(current.status, nextStatus);

    const nowIso = this.now();
    requireIsoInstant(nowIso, "updatedAt");

    const updated: ConsolidationOutboxItem = {
      ...current,
      status: nextStatus,
      attempts: patch.attempts ?? current.attempts,
      nextAttemptAt: patch.nextAttemptAt ?? current.nextAttemptAt,
      lastError:
        patch.lastError !== undefined ? patch.lastError : current.lastError,
      leaseOwner:
        patch.leaseOwner !== undefined ? patch.leaseOwner : current.leaseOwner,
      leaseExpiresAt:
        patch.leaseExpiresAt !== undefined
          ? patch.leaseExpiresAt
          : current.leaseExpiresAt,
      updatedAt: nowIso,
    };

    const items = envelope.items.slice();
    items[index] = updated;

    this.persist({
      v: CONSOLIDATION_OUTBOX_VERSION,
      updatedAt: nowIso,
      items,
    });

    return cloneItem(updated);
  }

  /**
   * 显式将 dead_letter 恢复为 pending（人工处理）。
   * 普通 update 不得完成此转换。
   */
  reviveDeadLetter(batchId: string): ConsolidationOutboxItem {
    const envelope = this.load();
    const index = envelope.items.findIndex((item) => item.batchId === batchId);

    if (index < 0) {
      throw new ConsolidationOutboxError("not_found", `batchId not found: ${batchId}`);
    }

    const current = envelope.items[index]!;

    if (current.status !== "dead_letter") {
      throw new ConsolidationOutboxTransitionError(
        "reviveDeadLetter requires status dead_letter",
      );
    }

    const nowIso = this.now();
    requireIsoInstant(nowIso, "updatedAt");

    const updated: ConsolidationOutboxItem = {
      ...current,
      status: "pending",
      nextAttemptAt: nowIso,
      lastError: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: nowIso,
    };

    const items = envelope.items.slice();
    items[index] = updated;

    this.persist({
      v: CONSOLIDATION_OUTBOX_VERSION,
      updatedAt: nowIso,
      items,
    });

    return cloneItem(updated);
  }

  /** 仅删除明确的 batchId；不存在则返回 false。 */
  remove(batchId: string): boolean {
    const envelope = this.load();
    const nextItems = envelope.items.filter((item) => item.batchId !== batchId);

    if (nextItems.length === envelope.items.length) {
      return false;
    }

    const nowIso = this.now();
    this.persist({
      v: CONSOLIDATION_OUTBOX_VERSION,
      updatedAt: nowIso,
      items: nextItems,
    });

    return true;
  }

  private persist(envelope: ConsolidationOutboxEnvelope): void {
    writeRaw(this.storage, this.storageKey, serializeEnvelope(envelope));
  }
}

function cloneItem(item: ConsolidationOutboxItem): ConsolidationOutboxItem {
  return {
    ...item,
    turns: item.turns.map((turn) => ({ role: turn.role, text: turn.text })),
  };
}

/** 测试用内存 Storage。 */
export function createMemoryOutboxStorage(
  initial?: Record<string, string>,
): ConsolidationOutboxStorage & { store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(initial ?? {}));

  return {
    store,
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
    removeItem(key: string) {
      store.delete(key);
    },
  };
}
