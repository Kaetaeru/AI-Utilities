import test from "node:test";
import assert from "node:assert/strict";
import { buildWorkerPrompt, createExecutionBudget, parseRuntimePayload, requestPath } from "../control.js";

test("execution budget is exactly 18m and 20m", () => {
  const now = Date.parse("2026-08-20T00:00:00.000Z");
  const budget = createExecutionBudget(now);
  assert.equal(Date.parse(budget.checkpointAt) - now, 18 * 60 * 1000);
  assert.equal(Date.parse(budget.hardStopAt) - now, 20 * 60 * 1000);
});

test("ready runtime requires request identity", () => {
  assert.throws(() => parseRuntimePayload(JSON.stringify({ version:1, run_id:"r", revision:1, status:"ready", updated_at:"2026-08-20T00:00:00Z" })), /request_id/);
});

test("request path rejects traversal", () => {
  assert.throws(() => requestPath("../x"));
  assert.equal(requestPath("REQ-1_a.b"), ".patient-oracle/requests/REQ-1_a.b.json");
});

test("worker prompt keeps GitHub durable and approval manual", () => {
  const prompt = buildWorkerPrompt(
    { runId:"r", revision:2, requestId:"REQ-1" },
    { requestId:"REQ-1" },
    { owner:"o", repo:"r", branch:"main", path:".patient-oracle/runtime.json" },
    createExecutionBudget(0)
  );
  assert.match(prompt, /GitHub is the only durable source of truth/);
  assert.match(prompt, /will not scrape your assistant answer from the DOM/);
  assert.match(prompt, /Never click.*GitHub approval/);
});
