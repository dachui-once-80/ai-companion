/**
 * 身份加载的请求序号门闩：过期响应不能覆盖更新的名字。
 * 抽成纯逻辑，便于用轻量 tsx 脚本覆盖竞态时序，不必上大型测试框架。
 */
export type IdentityGate = {
  /** 发起一次身份请求时领取序号。 */
  begin(): number;
  /** 本地权威更新（如改名成功）作废进行中的请求。 */
  invalidate(): void;
  /** 响应回来时：未卸载且序号仍是最新才可写状态。 */
  shouldApply(seq: number, dropped: boolean): boolean;
  current(): number;
};

export function createIdentityGate(): IdentityGate {
  let seq = 0;

  return {
    begin() {
      seq += 1;
      return seq;
    },
    invalidate() {
      seq += 1;
    },
    shouldApply(token, dropped) {
      return !dropped && token === seq;
    },
    current() {
      return seq;
    },
  };
}
