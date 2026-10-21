/**
 * web／server 对同一 canonical 得到相同 SHA-256（web=subtle async，Node createHash）。
 * 只导入纯 consolidationPayload 模块，不加载 consolidate.ts／SQLite。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  canonicalConsolidationPayloadJson,
  computeConsolidationPayloadHash as webHash,
  normalizeConsolidationOccurredOn,
  normalizeConsolidationTurnText,
} from "../src/realtime/consolidationPayload.ts";
import {
  canonicalConsolidationPayloadJson as serverCanonical,
  normalizeConsolidationOccurredOn as serverNormalizeDate,
  normalizeConsolidationTurnText as serverNormalizeText,
} from "../../server/src/memory/consolidationPayload.ts";

const TODAY = "2026-10-20";

function nodeSha256Hex(utf8: string): string {
  return createHash("sha256").update(utf8, "utf8").digest("hex");
}

const vectors: Array<{
  name: string;
  occurredOn: string;
  turns: Array<{ role: "user" | "companion" | "overheard"; text: string }>;
}> = [
  {
    name: "plain-ascii",
    occurredOn: TODAY,
    turns: [
      { role: "user", text: "remember the cafe" },
      { role: "companion", text: "ok" },
    ],
  },
  {
    name: "chinese-utf8",
    occurredOn: TODAY,
    turns: [
      { role: "user", text: "记住：龙井茶和苏州园林" },
      { role: "companion", text: "好，记下了。" },
    ],
  },
  {
    name: "already-normalized-spaces",
    occurredOn: TODAY,
    turns: [{ role: "user", text: "  keep spaces  " }],
  },
];

for (const vector of vectors) {
  const webJson = canonicalConsolidationPayloadJson(
    vector.occurredOn,
    vector.turns,
  );
  const serverJson = serverCanonical(vector.occurredOn, vector.turns);
  assert.equal(webJson, serverJson, `${vector.name}: canonical mismatch`);

  const fromNode = nodeSha256Hex(webJson);
  const fromWeb = await webHash(vector.occurredOn, vector.turns);

  assert.equal(fromWeb, fromNode, `${vector.name}: web subtle vs node`);
  console.log(`[consolidation-payload:web] ${vector.name} ${fromWeb}`);
}

assert.equal(
  normalizeConsolidationOccurredOn("2020-01-01", TODAY),
  serverNormalizeDate("2020-01-01", TODAY),
);
assert.equal(
  normalizeConsolidationTurnText("  x  "),
  serverNormalizeText("  x  "),
);

console.log("[consolidation-payload:web] ok");
