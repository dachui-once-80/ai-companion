/**
 * 规范化与 hash 契约：纯函数，不打开 SQLite／正式库。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  CONSOLIDATION_MAX_TURN_CHARS,
  canonicalConsolidationPayloadJson,
  normalizeConsolidationOccurredOn,
  normalizeConsolidationTurnText,
} from "../memory/consolidationPayload.ts";
import {
  ConsolidationInputError,
  computeConsolidationPayloadHash,
  readConsolidationRequest,
} from "../memory/consolidate.ts";
import { formatLocalDate } from "../memory/openMemory.ts";

const TODAY = "2026-10-20";

function nodeSha256Hex(utf8: string): string {
  return createHash("sha256").update(utf8, "utf8").digest("hex");
}

// --- 1) 正常日期与 turns ---
{
  assert.equal(normalizeConsolidationOccurredOn(TODAY, TODAY), TODAY);
  assert.equal(normalizeConsolidationOccurredOn("2026-10-19", TODAY), "2026-10-19");
  assert.equal(normalizeConsolidationOccurredOn("2026-10-21", TODAY), "2026-10-21");

  const turns = [
    { role: "user" as const, text: "我周末去看了展，记得一下" },
    { role: "companion" as const, text: "好，我记下了。" },
  ];
  const canonical = canonicalConsolidationPayloadJson(TODAY, turns);
  assert.equal(
    canonical,
    `{"occurredOn":"${TODAY}","turns":[{"role":"user","text":"我周末去看了展，记得一下"},{"role":"companion","text":"好，我记下了。"}]}`,
  );
  const hash = computeConsolidationPayloadHash(TODAY, turns);
  assert.equal(hash, nodeSha256Hex(canonical));
  assert.match(hash, /^[a-f0-9]{64}$/);
  console.log("[consolidation-payload] sample hash", hash);
}

// --- 2) 非法／过旧日期 → todayLocal ---
{
  assert.equal(normalizeConsolidationOccurredOn(undefined, TODAY), TODAY);
  assert.equal(normalizeConsolidationOccurredOn("not-a-date", TODAY), TODAY);
  assert.equal(normalizeConsolidationOccurredOn("2020-01-01", TODAY), TODAY);
  assert.equal(normalizeConsolidationOccurredOn("2026-10-01", TODAY), TODAY);
  assert.equal(normalizeConsolidationOccurredOn("2026-10-18", TODAY), "2026-10-18");
}

// --- 3) trim、截断、空、内部状态 ---
{
  assert.equal(normalizeConsolidationTurnText("  hello  "), "hello");
  assert.equal(normalizeConsolidationTurnText(""), null);
  assert.equal(normalizeConsolidationTurnText("   "), null);
  assert.equal(normalizeConsolidationTurnText("含内部状态的行"), null);
  assert.equal(
    normalizeConsolidationTurnText("x".repeat(CONSOLIDATION_MAX_TURN_CHARS + 50))
      ?.length,
    CONSOLIDATION_MAX_TURN_CHARS,
  );
}

// --- 4) canonical 字段顺序 + UTF-8 ---
{
  const json = canonicalConsolidationPayloadJson(TODAY, [
    { role: "user", text: "中文与 café" },
  ]);
  assert.equal(
    json,
    `{"occurredOn":"${TODAY}","turns":[{"role":"user","text":"中文与 café"}]}`,
  );
  assert.equal(
    computeConsolidationPayloadHash(TODAY, [
      { role: "user", text: "记住：龙井茶和苏州园林" },
    ]),
    nodeSha256Hex(
      canonicalConsolidationPayloadJson(TODAY, [
        { role: "user", text: "记住：龙井茶和苏州园林" },
      ]),
    ),
  );
}

// --- 5) 不二次规范化：canonical／hash 保留已给定 text（含首尾空格）---
{
  const asIfAlreadyNormalized = [
    { role: "user" as const, text: "  keep spaces  " },
  ];
  const canonical = canonicalConsolidationPayloadJson(
    TODAY,
    asIfAlreadyNormalized,
  );
  assert.ok(canonical.includes('"text":"  keep spaces  "'));
  assert.equal(
    computeConsolidationPayloadHash(TODAY, asIfAlreadyNormalized),
    nodeSha256Hex(canonical),
  );
  const trimmed = normalizeConsolidationTurnText("  keep spaces  ");
  assert.equal(trimmed, "keep spaces");
  assert.notEqual(
    computeConsolidationPayloadHash(TODAY, asIfAlreadyNormalized),
    computeConsolidationPayloadHash(TODAY, [
      { role: "user", text: trimmed! },
    ]),
  );
}

// --- 6) readConsolidationRequest：错误 hash → InputError；正确 hash 通过 ---
{
  const serverToday = formatLocalDate();
  const rawTurns = [
    { role: "user", text: "  天气怎么样  " },
    { role: "companion", text: "晴" },
  ];
  const parsed = readConsolidationRequest({
    occurredOn: serverToday,
    turns: rawTurns,
  });
  assert.equal(parsed.today, serverToday);
  assert.deepEqual(parsed.turns, [
    { role: "user", text: "天气怎么样" },
    { role: "companion", text: "晴" },
  ]);

  assert.throws(
    () =>
      readConsolidationRequest({
        occurredOn: serverToday,
        turns: rawTurns,
        batchId: "payload00-0000-4000-8000-000000000001",
        payloadHash: "0".repeat(64),
      }),
    (error: unknown) =>
      error instanceof ConsolidationInputError &&
      /payloadHash does not match/.test(error.message),
  );

  const okHash = computeConsolidationPayloadHash(parsed.today, parsed.turns);
  const ok = readConsolidationRequest({
    occurredOn: serverToday,
    turns: rawTurns,
    batchId: "payload00-0000-4000-8000-000000000002",
    payloadHash: okHash,
  });
  assert.equal(ok.payloadHash, okHash);

  // 方案 A：带 batchId 时保留过旧但合法的日历日（相对 serverToday ≫ 2 天）
  const staleTurns = [{ role: "user" as const, text: "天气怎么样" }];
  const frozenD0 = "2020-01-01";
  const kept = readConsolidationRequest({
    occurredOn: frozenD0,
    turns: staleTurns,
    batchId: "payload00-0000-4000-8000-000000000003",
    payloadHash: computeConsolidationPayloadHash(frozenD0, staleTurns),
  });
  assert.equal(kept.today, frozenD0);

  // 仍发送冻结日，但 hash 按服务器今天计算 → 不匹配
  assert.throws(
    () =>
      readConsolidationRequest({
        occurredOn: frozenD0,
        turns: staleTurns,
        batchId: "payload00-0000-4000-8000-000000000004",
        payloadHash: computeConsolidationPayloadHash(serverToday, staleTurns),
      }),
    (error: unknown) =>
      error instanceof ConsolidationInputError &&
      /payloadHash does not match/.test(error.message),
  );

  // 无 batchId：过旧日期仍两日窗口改写
  const legacy = readConsolidationRequest({
    occurredOn: frozenD0,
    turns: staleTurns,
  });
  assert.equal(legacy.today, serverToday);

  // 带 batchId：非法／非日历日拒绝
  for (const bad of ["not-a-date", "2026-02-31"]) {
    assert.throws(
      () =>
        readConsolidationRequest({
          occurredOn: bad,
          turns: staleTurns,
          batchId: "payload00-0000-4000-8000-000000000005",
          payloadHash: computeConsolidationPayloadHash(frozenD0, staleTurns),
        }),
      (error: unknown) => error instanceof ConsolidationInputError,
    );
  }
}

console.log("[consolidation-payload] offline ok");
