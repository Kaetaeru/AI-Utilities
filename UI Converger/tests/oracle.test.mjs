import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ORACLE_COORDINATES,
  buildCallerArgs,
  makeOracleRequestId,
  normalizeCallerResult
} from "../src/oracle.mjs";

test("deployed Patient Oracle mailbox coordinates are the defaults", () => {
  assert.deepEqual(DEFAULT_ORACLE_COORDINATES, {
    owner: "Kaetaeru",
    repo: "AI-Utilities",
    branch: "agent/patient-oracle-e2e"
  });
});

test("UI Converger creates stable durable request IDs", () => {
  assert.equal(makeOracleRequestId("20260820170700-a1b2c3", "plan", 1), "REQ-UI-CONVERGER-20260820170700-a1b2c3-PLAN-001");
  assert.equal(makeOracleRequestId("20260820170700-a1b2c3", "iteration", 2), "REQ-UI-CONVERGER-20260820170700-a1b2c3-ITER-002");
});

test("ask and wait both carry the exact durable request ID", () => {
  const base = {
    owner: "Kaetaeru",
    repo: "AI-Utilities",
    branch: "agent/patient-oracle-e2e",
    requestId: "REQ-X",
    timeoutSeconds: 1800,
    pollSeconds: 5,
    prompt: "hello",
    responseFormat: "application/json"
  };
  const ask = buildCallerArgs("ask", base);
  const wait = buildCallerArgs("wait", base);
  assert.deepEqual(ask.slice(0, 2), [ask[0], "ask"]);
  assert.ok(ask.includes("--id"));
  assert.equal(ask[ask.indexOf("--id") + 1], "REQ-X");
  assert.ok(ask.includes("--prompt"));
  assert.equal(wait[wait.indexOf("--id") + 1], "REQ-X");
  assert.equal(wait.includes("--prompt"), false);
});

test("needs_user and blocked remain structured terminal results", () => {
  assert.deepEqual(normalizeCallerResult({ request_id: "REQ-X", status: "needs_user", reason: "operator input" }, "REQ-X"), {
    requestId: "REQ-X",
    status: "needs_user",
    reason: "operator input",
    completedAt: null
  });
  assert.equal(normalizeCallerResult({ request_id: "REQ-X", status: "blocked", reason: "unsafe state" }, "REQ-X").status, "blocked");
});
