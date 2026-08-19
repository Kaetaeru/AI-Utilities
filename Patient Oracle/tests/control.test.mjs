import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWorkerPrompt,
  checkpointPath,
  createExecutionBudget,
  parseResponseArtifact,
  parseRuntimePayload,
  requestPath,
  responseFilename,
  responsePath
} from "../control.js";

test("execution budget is exactly 18m and 20m", () => {
  const now = Date.parse("2026-08-20T00:00:00.000Z");
  const budget = createExecutionBudget(now);
  assert.equal(Date.parse(budget.checkpointAt) - now, 18 * 60 * 1000);
  assert.equal(Date.parse(budget.hardStopAt) - now, 20 * 60 * 1000);
});

test("ready runtime requires request identity", () => {
  assert.throws(() => parseRuntimePayload(JSON.stringify({ version:1, run_id:"r", revision:1, status:"ready", updated_at:"2026-08-20T00:00:00Z" })), /request_id/);
});

test("request, response, filename, and checkpoint paths reject traversal", () => {
  assert.throws(() => requestPath("../x"));
  assert.throws(() => responsePath("../x"));
  assert.throws(() => responseFilename("../x"));
  assert.equal(requestPath("REQ-1_a.b"), ".patient-oracle/requests/REQ-1_a.b.json");
  assert.equal(responsePath("REQ-1_a.b"), ".patient-oracle/responses/REQ-1_a.b.json");
  assert.equal(responseFilename("REQ-1_a.b"), "patient-oracle-response-REQ-1_a.b.json");
  assert.equal(checkpointPath("REQ-1", 3), ".patient-oracle/checkpoints/REQ-1/revision-3.json");
});

test("worker prompt forbids ChatGPT GitHub I/O and requires a file handoff", () => {
  const prompt = buildWorkerPrompt(
    { runId:"r", revision:2, requestId:"REQ-1" },
    { requestId:"REQ-1", prompt:"Write a long answer", responseFormat:"text/markdown" },
    createExecutionBudget(0)
  );
  assert.match(prompt, /Do not use GitHub, GitHub plugins, connectors, OAuth, or repository tools/);
  assert.match(prompt, /patient-oracle-response-REQ-1\.json/);
  assert.match(prompt, /Create and attach the file itself/);
  assert.match(prompt, /ordinary assistant message text/);
  assert.match(prompt, /resume_state/);
});

test("complete response artifact preserves long-form answer and content type", () => {
  const artifact = parseResponseArtifact(JSON.stringify({
    version: 1,
    request_id: "REQ-1",
    status: "complete",
    content_type: "text/markdown",
    answer: "# Long answer\n\n" + "x".repeat(10000),
    completed_at: "2026-08-20T00:10:00Z"
  }), "REQ-1");
  assert.equal(artifact.status, "complete");
  assert.equal(artifact.contentType, "text/markdown");
  assert.ok(artifact.answer.length > 10000);
});

test("continue response artifact requires exact resumable state", () => {
  assert.throws(() => parseResponseArtifact(JSON.stringify({ version:1, request_id:"REQ-1", status:"continue", reason:"more work" }), "REQ-1"), /resume_state/);
  const artifact = parseResponseArtifact(JSON.stringify({ version:1, request_id:"REQ-1", status:"continue", reason:"more work", resume_state:{ cursor:42 } }), "REQ-1");
  assert.deepEqual(artifact.resumeState, { cursor:42 });
});
