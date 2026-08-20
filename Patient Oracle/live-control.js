import { createExecutionBudget, parseResponseArtifact, responseFilename } from "./control.js";

export const LIVE_CONFIG_KEY = "patientOracleLiveConfig";
export const LIVE_JOB_STATUSES = new Set([
  "starting",
  "running",
  "waiting_for_response_file",
  "complete",
  "needs_user",
  "blocked",
  "failed",
  "cancelled",
  "timed_out"
]);
export const LIVE_ACTIVE_STATUSES = new Set(["starting", "running", "waiting_for_response_file"]);
export const LIVE_TERMINAL_STATUSES = new Set(["complete", "needs_user", "blocked", "failed", "cancelled", "timed_out"]);

export const DEFAULT_LIVE_CONFIG = Object.freeze({
  version: 1,
  enabled: false,
  maxWorkers: 2,
  closeTabsOnTerminal: true
});

export function normalizeLiveConfig(value = {}) {
  const rawWorkers = Number(value.maxWorkers);
  const maxWorkers = Number.isFinite(rawWorkers) ? Math.max(1, Math.floor(rawWorkers)) : DEFAULT_LIVE_CONFIG.maxWorkers;
  return {
    version: 1,
    enabled: Boolean(value.enabled),
    maxWorkers,
    closeTabsOnTerminal: value.closeTabsOnTerminal === undefined ? true : Boolean(value.closeTabsOnTerminal)
  };
}

export function createLiveJob({ jobId, prompt, responseFormat = "text/markdown", origin = "unknown", parentJobId = null, delegationDepth = 0, nowMs = Date.now() }) {
  const id = normalizeLiveJobId(jobId);
  const text = String(prompt || "");
  if (!text.trim()) throw new Error("Patient Oracle live job prompt must be non-empty");
  const depth = Number(delegationDepth);
  if (!Number.isSafeInteger(depth) || depth < 0) throw new Error("Patient Oracle delegationDepth must be a non-negative integer");
  const parent = parentJobId === null || parentJobId === undefined || parentJobId === "" ? null : normalizeLiveJobId(parentJobId);
  return {
    version: 1,
    jobId: id,
    workerId: `worker:${id}`,
    status: "starting",
    phase: "allocating",
    prompt: text,
    responseFormat: String(responseFormat || "text/markdown").trim() || "text/markdown",
    origin: String(origin || "unknown").trim() || "unknown",
    parentJobId: parent,
    delegationDepth: depth,
    createdAt: new Date(nowMs).toISOString(),
    startedAt: null,
    finishedAt: null,
    tabId: null,
    executionToken: null,
    responseFilename: responseFilename(id),
    contentType: null,
    answer: null,
    reason: null,
    metadata: null,
    lastError: null
  };
}

export function countActiveJobs(jobs) {
  return Array.from(jobs || []).filter((job) => LIVE_ACTIVE_STATUSES.has(job?.status)).length;
}

export function hasWorkerCapacity(jobs, config) {
  return countActiveJobs(jobs) < normalizeLiveConfig(config).maxWorkers;
}

export function buildLiveWorkerPrompt(job, nowMs = Date.now()) {
  const budget = createExecutionBudget(nowMs);
  const filename = responseFilename(job.jobId);
  const formatHint = job.responseFormat ? `Requested response format hint: ${job.responseFormat}.` : "Default to Markdown for prose answers.";
  const prompt = [
    "You are a Patient Oracle live worker in a disposable ChatGPT conversation on a dedicated sub-PC.",
    "Complete the assigned task independently. Do not call Patient Oracle or delegate this task to another Patient Oracle worker.",
    `Job identity: job_id=${job.jobId}.`,
    `Execution started at ${budget.startedAt}. Begin finalization by ${budget.checkpointAt}; the browser hard stop is ${budget.hardStopAt}.`,
    `The only machine-readable result channel is a generated downloadable UTF-8 JSON file named exactly ${filename}.`,
    "Ordinary assistant prose is not the result channel. You may write brief prose in chat, but Patient Oracle only accepts the generated file.",
    "For success, create a JSON object with exactly: version, request_id, status, content_type, answer, completed_at, and optional metadata. Use version 1, request_id equal to the exact job_id, status complete, the full answer, and an ISO-8601 completed_at.",
    "If human input is required, create the file with version, request_id, status needs_user, reason, completed_at, and optional metadata.",
    "If the task is impossible or safely blocked, create the file with version, request_id, status blocked, reason, completed_at, and optional metadata.",
    "Do not use status continue in Live 1.0 foundation mode. Finalize as complete, needs_user, or blocked before the hard stop.",
    "Create and attach the file itself; do not merely paste JSON into the chat message.",
    formatHint,
    `USER REQUEST:\n${job.prompt}`
  ].join("\n\n");
  return { prompt, budget, filename };
}

export function parseLiveResponseArtifact(text, expectedJobId) {
  const artifact = parseResponseArtifact(text, normalizeLiveJobId(expectedJobId));
  if (artifact.status === "continue") throw new Error("Live 1.0 foundation does not accept continue artifacts");
  return artifact;
}

export function publicLiveJob(job, { includeResult = false } = {}) {
  if (!job) return null;
  const value = {
    job_id: job.jobId,
    worker_id: job.workerId,
    status: job.status,
    phase: job.phase || null,
    origin: job.origin || "unknown",
    parent_job_id: job.parentJobId || null,
    delegation_depth: Number(job.delegationDepth || 0),
    created_at: job.createdAt || null,
    started_at: job.startedAt || null,
    finished_at: job.finishedAt || null,
    tab_id: job.tabId !== null && job.tabId !== undefined && Number.isSafeInteger(Number(job.tabId)) ? Number(job.tabId) : null,
    content_type: job.contentType || null,
    reason: job.reason || null,
    error: job.lastError || null
  };
  if (includeResult) {
    value.answer = job.answer ?? null;
    value.metadata = job.metadata ?? null;
  }
  return value;
}

export function normalizeLiveJobId(value) {
  const id = String(value || "").trim();
  if (!id || id.includes("/") || id.includes("..") || !/^[A-Za-z0-9._-]+$/.test(id)) throw new Error("invalid Patient Oracle live job ID");
  return id;
}
