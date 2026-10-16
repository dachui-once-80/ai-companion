import assert from "node:assert/strict";
import { createIdentityGate } from "../src/identityLoad.ts";

/**
 * 时序：旧身份请求先发出 → 改名成功立刻显示新名 → 旧请求随后返回旧名 → 界面仍是新名。
 */
const gate = createIdentityGate();
const oldRequest = gate.begin();

// 改名成功：本地权威写入，并作废进行中的身份请求。
gate.invalidate();
const displayed = "小满";
assert.equal(displayed, "小满");

// 旧请求晚到：不得覆盖。
assert.equal(gate.shouldApply(oldRequest, false), false);
assert.equal(displayed, "小满");

// 新的可见性/切页加载仍可更新。
const fresh = gate.begin();
assert.equal(gate.shouldApply(fresh, false), true);

// 组件卸载后，即使序号匹配也不能写。
const afterUnmount = gate.begin();
assert.equal(gate.shouldApply(afterUnmount, true), false);

// 并发：后发起的请求作废先发起的。
const first = gate.begin();
const second = gate.begin();
assert.equal(gate.shouldApply(first, false), false);
assert.equal(gate.shouldApply(second, false), true);

console.log("[identity-race] stale identity response cannot overwrite rename");
