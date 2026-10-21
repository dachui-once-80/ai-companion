/**
 * consolidate payload 契约：与 server `memory/consolidationPayload.ts` 同源。
 * 通过相对路径引用，避免新增 workspace 包或 Vite alias。
 *
 * Hash：浏览器／tsx 均用 Web Crypto（async）；server 请求路径仍用 Node sync。
 * 两边对同一 canonical JSON 取 SHA-256，hex 必须一致（见回归测试）。
 */

export {
  CONSOLIDATION_MAX_TURN_CHARS,
  canonicalConsolidationPayloadJson,
  normalizeConsolidationOccurredOn,
  normalizeConsolidationTurnText,
  type ConsolidationPayloadTurn,
} from "../../../server/src/memory/consolidationPayload.ts";

import {
  canonicalConsolidationPayloadJson,
  type ConsolidationPayloadTurn,
} from "../../../server/src/memory/consolidationPayload.ts";

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** 对已规范化的 occurredOn + turns 做 SHA-256 hex；不再二次规范化。 */
export async function computeConsolidationPayloadHash(
  occurredOn: string,
  turns: readonly ConsolidationPayloadTurn[],
): Promise<string> {
  const canonical = canonicalConsolidationPayloadJson(occurredOn, turns);
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return bytesToHex(digest);
}
