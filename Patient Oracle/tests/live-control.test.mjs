import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LIVE_CONFIG,
  buildLiveWorkerPrompt,
  countActiveJobs,
  createLiveJob,
  hasWorkerCapacity,
  normalizeLiveConfig,
  parseLiveResponseArtifact,
  publicLiveJob
} from "../live-control.js";

test("live config defaults to two workers and disabled intake", () => {
  assert.deepEqual(normalizeLiveConfig({}), DEFAULT_LIVE_CONFIG);
  assert.equal(normalizeLiveConfig({ maxWorkers: "5", enabled: true }).maxWorkers, 5);
});

test("live jobs are fresh ephemeral worker identities", () => {
  const job = createLiveJob({ jobId: "PO-TEST-1", prompt: "hello", origin: "test", nowMs: 0 });
  assert.equal(job.status, "starting");
  assert.equal(job.workerId, "worker:PO-TEST-1");
  assert.equal(job.responseFilename, "patient-oracle-response-PO-TEST-1.json");
  assert.equal(job.createdAt, "1970-01-01T00:00:00.000Z");
});

test("capacity counts only active live jobs", () => {
  const jobs = [
    { status: "running" },
    { status: "waiting_for_response_file" },
    { status: "complete" }
  ];
  assert.equal(countActiveJobs(jobs), 2);
  assert.equal(hasWorkerCapacity(jobs, { maxWorkers: 2 }), false);
  assert.equal(hasWorkerCapacity(jobs, { maxWorkers: 3 }), true);
});

test("live worker prompt demands exact file and forbids recursive Oracle delegation", () => {
  const job = createLiveJob({ jobId: "PO-TEST-2", prompt: "Analyze X", responseFormat: "text/markdown", nowMs: 0 });
  const built = buildLiveWorkerPrompt(job, 0);
  assert.match(built.prompt, /patient-oracle-response-PO-TEST-2\.json/);
  assert.match(built.prompt, /Do not call Patient Oracle/);
  assert.match(built.prompt, /USER REQUEST:\nAnalyze X/);
});

test("live response parser accepts terminal response and rejects continue", () => {
  const complete = parseLiveResponseArtifact(JSON.stringify({
    version: 1,
    request_id: "PO-TEST-3",
    status: "complete",
    content_type: "text/markdown",
    answer: "OK",
    completed_at: "2026-08-20T00:00:00Z"
  }), "PO-TEST-3");
  assert.equal(complete.answer, "OK");
  assert.throws(() => parseLiveResponseArtifact(JSON.stringify({
    version: 1,
    request_id: "PO-TEST-3",
    status: "continue",
    reason: "more",
    resume_state: { x: 1 }
  }), "PO-TEST-3"), /does not accept continue/);
});

test("public job snapshot hides prompt and execution token", () => {
  const job = createLiveJob({ jobId: "PO-TEST-4", prompt: "secret prompt", nowMs: 0 });
  job.executionToken = "secret-token";
  job.answer = "answer";
  const summary = publicLiveJob(job);
  assert.equal("prompt" in summary, false);
  assert.equal("executionToken" in summary, false);
  assert.equal("answer" in summary, false);
  const result = publicLiveJob(job, { includeResult: true });
  assert.equal(result.answer, "answer");
});
