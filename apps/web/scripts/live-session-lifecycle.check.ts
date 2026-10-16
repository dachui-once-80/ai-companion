import assert from "node:assert/strict";
import {
  adoptOrReleaseLiveSession,
  releaseLiveSession,
} from "../src/realtime/liveSessionLifecycle.ts";

// --- release：正常 close ---
{
  let closed = 0;
  releaseLiveSession({
    close() {
      closed += 1;
    },
  });
  assert.equal(closed, 1);
}

// --- release：null / undefined 安全 ---
releaseLiveSession(null);
releaseLiveSession(undefined);

// --- release：close 抛错不外泄 ---
releaseLiveSession({
  close() {
    throw new Error("WebSocket is not connected");
  },
});

// --- release：可重复 ---
{
  let closed = 0;
  const session = {
    close() {
      closed += 1;
      if (closed > 1) throw new Error("already closed");
    },
  };
  releaseLiveSession(session);
  releaseLiveSession(session);
  assert.equal(closed, 2);
}

// --- adopt：当前代次接管，不提前 close ---
{
  let closed = 0;
  let assigned: unknown = null;
  const session = {
    close() {
      closed += 1;
    },
  };

  const adopted = adoptOrReleaseLiveSession({
    session,
    isCurrent: true,
    assign: (next) => {
      assigned = next;
    },
  });

  assert.equal(adopted, true);
  assert.equal(assigned, session);
  assert.equal(closed, 0);
}

// --- 取消后迟到成功：必须 close，且不得 assign ---
{
  let closed = 0;
  let assigned: unknown = null;
  const late = {
    close() {
      closed += 1;
    },
  };

  const adopted = adoptOrReleaseLiveSession({
    session: late,
    isCurrent: false,
    assign: (next) => {
      assigned = next;
    },
  });

  assert.equal(adopted, false);
  assert.equal(assigned, null);
  assert.equal(closed, 1);
}

// --- 连续两次连接：旧结果 isCurrent=false 被释放，新结果接管 ---
{
  const closed: string[] = [];
  let current: string | null = null;

  const oldSession = {
    close() {
      closed.push("old");
    },
  };
  const newSession = {
    close() {
      closed.push("new");
    },
  };

  assert.equal(
    adoptOrReleaseLiveSession({
      session: oldSession,
      isCurrent: false,
      assign: (next) => {
        current = next === oldSession ? "old" : "other";
      },
    }),
    false,
  );

  assert.equal(
    adoptOrReleaseLiveSession({
      session: newSession,
      isCurrent: true,
      assign: (next) => {
        current = next === newSession ? "new" : "other";
      },
    }),
    true,
  );

  assert.equal(current, "new");
  assert.deepEqual(closed, ["old"]);
}

console.log("[live-session-lifecycle] adopt/release and cancel-late-connect ok");
