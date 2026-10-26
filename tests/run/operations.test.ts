import assert from "node:assert/strict";
import test from "node:test";

import type { AuditLog } from "../../src/audit.ts";
import {
  externalRead,
  supervisedAuditWrite,
  workflowWrite,
  type WriteReconciliation,
} from "../../src/run/operations.ts";
import type {
  Clock,
  OperatorIO,
  RetryPolicy,
} from "../../src/run/contracts.ts";

const fourRetryPolicy: RetryPolicy = {
  operationRetry: 4,
  agentRetry: 4,
  operationRetryDelay: [10, 20, 40, 80],
  agentRetryDelay: [10, 20, 40, 80],
};

function dependencies() {
  const sleeps: number[] = [];
  let now = 0;
  const clock: Clock = {
    now: () => new Date(now),
    async sleep(milliseconds) {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
  };
  const audit = { append: async () => {} } as unknown as AuditLog;
  const pauses: string[] = [];
  const operator: OperatorIO = {
    write() {},
    async pause(message) {
      pauses.push(message);
      return "q";
    },
  };
  return { audit, clock, operator, pauses, sleeps };
}

test("workflowWrite retries directly with bounded exponential backoff", async () => {
  const { audit, clock, operator, pauses, sleeps } = dependencies();
  let calls = 0;

  await workflowWrite({
    action: async () => {
      calls += 1;
      if (calls < 5) throw new Error("502 Bad Gateway");
    },
    audit,
    clock,
    event: (attempt) => ({
      timestamp: new Date().toISOString(),
      runId: "run",
      project: "project",
      parentTicket: 1,
      phase: "test",
      operation: "write",
      target: "target",
      attempt,
    }),
    operator,
    automaticRetry: {},
    retryPolicy: fourRetryPolicy,
  });

  assert.equal(calls, 5);
  assert.deepEqual(sleeps, [10_000, 20_000, 40_000, 80_000]);
  assert.deepEqual(pauses, []);
});

test("workflowWrite retries an opted-in action regardless of its error message", async () => {
  const { audit, clock, operator, pauses, sleeps } = dependencies();
  let calls = 0;

  await workflowWrite({
    action: async () => {
      calls += 1;
      if (calls === 1)
        throw new Error(
          "! [remote rejected] ticket-229 -> ticket-229 (failed)\nerror: failed to push some refs",
        );
    },
    audit,
    clock,
    event: (attempt) => ({
      timestamp: new Date().toISOString(),
      runId: "run",
      project: "project",
      parentTicket: 1,
      phase: "test",
      operation: "write",
      target: "target",
      attempt,
    }),
    operator,
    automaticRetry: {
      async reconcile() {
        return { outcome: "pending" };
      },
    },
    retryPolicy: fourRetryPolicy,
  });

  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [10_000]);
  assert.deepEqual(pauses, []);
});

test("workflowWrite exhausts the configured retries before Operator Pause", async () => {
  const { audit, clock, operator, pauses, sleeps } = dependencies();
  let calls = 0;

  await assert.rejects(
    workflowWrite({
      action: async () => {
        calls += 1;
        throw new Error("push was rejected");
      },
      audit,
      clock,
      event: (attempt) => ({
        timestamp: new Date().toISOString(),
        runId: "run",
        project: "project",
        parentTicket: 1,
        phase: "test",
        operation: "write",
        target: "target",
        attempt,
      }),
      operator,
      automaticRetry: {
        async reconcile() {
          return { outcome: "pending" };
        },
      },
      retryPolicy: fourRetryPolicy,
    }),
    /operator cancelled/u,
  );

  assert.equal(calls, 5);
  assert.deepEqual(sleeps, [10_000, 20_000, 40_000, 80_000]);
  assert.equal(pauses.length, 1);
});

test("workflowWrite confirms state before the first write and after failure", async () => {
  const { audit, clock, operator, pauses, sleeps } = dependencies();
  let calls = 0;
  let confirmations = 0;
  const reconciliations: WriteReconciliation<void>[] = [
    { outcome: "pending" },
    { outcome: "completed" },
  ];

  await workflowWrite({
    action: async () => {
      calls += 1;
      throw new Error("write response was not observed");
    },
    audit,
    clock,
    event: (attempt) => ({
      timestamp: new Date().toISOString(),
      runId: "run",
      project: "project",
      parentTicket: 1,
      phase: "test",
      operation: "write",
      target: "target",
      attempt,
    }),
    operator,
    automaticRetry: {
      async reconcile() {
        confirmations += 1;
        return reconciliations.shift()!;
      },
    },
    retryPolicy: fourRetryPolicy,
  });

  assert.equal(calls, 1);
  assert.equal(confirmations, 2);
  assert.deepEqual(sleeps, []);
  assert.deepEqual(pauses, []);
});

test("workflowWrite uses configured retry count and clamps the final delay", async () => {
  const { clock, operator, pauses, sleeps, audit } = dependencies();
  let calls = 0;

  await workflowWrite({
    action: async () => {
      calls += 1;
      if (calls < 4) throw new Error("502 Bad Gateway");
    },
    audit,
    clock,
    event: (attempt) => ({
      timestamp: new Date().toISOString(),
      runId: "run",
      project: "project",
      parentTicket: 1,
      phase: "test",
      operation: "write",
      target: "target",
      attempt,
    }),
    operator,
    automaticRetry: {},
    retryPolicy: {
      operationRetry: 3,
      agentRetry: 0,
      operationRetryDelay: [1, 2],
      agentRetryDelay: [1],
    },
  });

  assert.equal(calls, 4);
  assert.deepEqual(sleeps, [1_000, 2_000, 2_000]);
  assert.deepEqual(pauses, []);
});

test("workflowWrite with zero operation retries performs only the initial attempt", async () => {
  const { clock, operator, pauses, sleeps, audit } = dependencies();

  await assert.rejects(
    workflowWrite({
      action: async () => {
        throw new Error("502 Bad Gateway");
      },
      audit,
      clock,
      event: (attempt) => ({
        timestamp: new Date().toISOString(),
        runId: "run",
        project: "project",
        parentTicket: 1,
        phase: "test",
        operation: "write",
        target: "target",
        attempt,
      }),
      operator,
      automaticRetry: {},
      retryPolicy: {
        operationRetry: 0,
        agentRetry: 2,
        operationRetryDelay: [1],
        agentRetryDelay: [1],
      },
    }),
    /operator cancelled/u,
  );
  assert.deepEqual(sleeps, []);
  assert.equal(pauses.length, 1);
});

test("externalRead uses configured retry count and delay clamping", async () => {
  const { audit, clock, operator, pauses, sleeps } = dependencies();
  let calls = 0;
  const result = await externalRead({
    action: async () => {
      calls += 1;
      if (calls < 3) throw new Error("network unavailable");
      return "ok";
    },
    audit,
    clock,
    event: (attempt) => ({
      timestamp: new Date().toISOString(),
      runId: "run",
      project: "project",
      parentTicket: 1,
      phase: "test",
      operation: "read",
      target: "target",
      attempt,
    }),
    operator,
    retryPolicy: {
      operationRetry: 2,
      agentRetry: 0,
      operationRetryDelay: [3],
      agentRetryDelay: [1],
    },
  });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [3_000, 3_000]);
  assert.deepEqual(pauses, []);
});

for (const kind of ["read", "write"] as const) {
  test(`${kind} rejects successful-result text without retrying until Enter`, async () => {
    const deps = dependencies();
    const responses = ['{"result":"trusted"}', "accepted", ""];
    let calls = 0;
    const operation = {
      ...deps,
      action: async () => {
        calls += 1;
        if (calls === 1) throw new Error("unobserved result");
        return "observed";
      },
      event: (attempt: number) => ({
        timestamp: new Date().toISOString(),
        runId: "run",
        project: "project",
        parentTicket: 1,
        phase: "test",
        operation: kind,
        target: "target",
        attempt,
      }),
      operator: {
        write() {},
        async pause() {
          assert.equal(calls, 1);
          return responses.shift() ?? "q";
        },
      },
      retryPolicy: { ...fourRetryPolicy, operationRetry: 0 },
    };
    const result = await (kind === "read"
      ? externalRead(operation)
      : workflowWrite(operation));
    assert.equal(result, "observed");
    assert.equal(calls, 2);
    assert.deepEqual(responses, []);
  });
}

test("audit rejects gap acceptance and skip, retrying only on Enter", async () => {
  const responses = ["accept gap", "s", ""];
  let calls = 0;
  await supervisedAuditWrite(
    async () => {
      calls += 1;
      if (calls === 1) throw new Error("append failed");
    },
    {
      write() {},
      async pause() {
        assert.equal(calls, 1);
        return responses.shift() ?? "q";
      },
    },
  );
  assert.equal(calls, 2);
  assert.deepEqual(responses, []);
});

for (const end of ["q", null]) {
  test(`unsupported operation input followed by ${end ?? "EOF"} cancels without replay`, async () => {
    const deps = dependencies();
    let calls = 0;
    const responses = ["s", '{"outcome":"succeeded"}', end];
    await assert.rejects(
      externalRead({
        ...deps,
        action: async () => {
          calls += 1;
          throw new Error("read failed");
        },
        event: (attempt) => ({
          timestamp: new Date().toISOString(),
          runId: "run",
          project: "project",
          parentTicket: 1,
          phase: "discover",
          operation: "read",
          target: "ticket:9",
          attempt,
        }),
        operator: {
          write() {},
          async pause(message) {
            assert.doesNotMatch(message, /s to skip/u);
            return responses.shift() ?? null;
          },
        },
        retryPolicy: { ...fourRetryPolicy, operationRetry: 0 },
      }),
      /operator cancelled/u,
    );
    assert.equal(calls, 1);
    assert.deepEqual(responses, []);
  });
}

test("an audit result failure after a successful write retries only that append", async () => {
  const deps = dependencies();
  const responses = ["s", "accept gap", ""];
  let writes = 0;
  let appends = 0;
  const audit = {
    async append(event: { result: string }) {
      if (event.result === "succeeded") {
        appends += 1;
        if (appends === 1) throw new Error("uncertain append");
      }
    },
  } as unknown as AuditLog;
  await workflowWrite({
    ...deps,
    audit,
    action: async () => {
      writes += 1;
    },
    event: (attempt) => ({
      timestamp: new Date().toISOString(),
      runId: "run",
      project: "project",
      parentTicket: 1,
      phase: "publish",
      operation: "create",
      target: "ticket:9",
      attempt,
    }),
    operator: {
      skipScope: "Delivery Ticket 9",
      write() {},
      async pause(message) {
        assert.doesNotMatch(message, /s to skip/u);
        assert.equal(writes, 1);
        return responses.shift() ?? "q";
      },
    },
    retryPolicy: fourRetryPolicy,
  });
  assert.equal(writes, 1);
  assert.equal(appends, 2);
  assert.deepEqual(responses, []);
});
