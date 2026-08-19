export const ORACLE_RUNTIME_PATH = ".patient-oracle/runtime.json";
export const ORACLE_CONTRACT_PATH = ".patient-oracle/CONTRACT.md";
export const ORACLE_STATUSES = new Set(["ready", "complete", "needs_user", "blocked"]);
export const ORACLE_TERMINAL_STATUSES = new Set(["complete", "needs_user", "blocked"]);
export const HANDOFF_STATUSES = new Set(["complete", "needs_user", "blocked", "continue"]);

export const DEFAULT_CONFIG = Object.freeze({
  owner: "",
  repo: "",
  branch: "main",
  githubToken: "",
  path: ORACLE_RUNTIME_PATH,
  pollIntervalSeconds: 90,
  maxRedispatchesPerRequest: 6
});

export const DEFAULT_STATE = Object.freeze({
  enabled: false,
  streamKey: null,
  dispatching: false,
  executing: false,
  finalizing: false,
  executionToken: null,
  executionStartedAt: null,
  executionHardStopAt: null,
  checkpointAt: null,
  lastRunId: null,
  lastRevision: -1,
  lastDispatchedRevision: -1,
  currentRequestId: null,
  requestDispatchCount: 0,
  expectedResponseFilename: null,
  lastStatus: null,
  lastReason: null,
  lastCheckedAt: null,
  lastDispatchAt: null,
  lastFinishedAt: null,
  rateLimitPausedUntil: null,
  rateLimitRemaining: null,
  rateLimitResetAt: null,
  stopReason: null,
  lastError: null
});

export function configKey(tabId) {
  return `patientOracleConfig:${normalizeTabId(tabId)}`;
}

export function stateKey(tabId) {
  return `patientOracleState:${normalizeTabId(tabId)}`;
}

export function parseRuntimePayload(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("oracle runtime is not valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("oracle runtime must contain a JSON object");
  rejectUnknown(value, ["version", "run_id", "revision", "status", "request_id", "reason", "updated_at"], "oracle runtime");
  if (value.version !== 1) throw new Error("oracle runtime version must be 1");
  if (typeof value.run_id !== "string" || !value.run_id.trim()) throw new Error("oracle runtime run_id must be a non-empty string");
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error("oracle runtime revision must be a non-negative integer");
  if (!ORACLE_STATUSES.has(value.status)) throw new Error(`Unsupported oracle runtime status: ${String(value.status)}`);
  if (typeof value.updated_at !== "string" || !Number.isFinite(Date.parse(value.updated_at))) throw new Error("oracle runtime updated_at must be an ISO-8601 date-time string");
  if (value.reason !== undefined && typeof value.reason !== "string") throw new Error("oracle runtime reason must be a string when present");
  const requestId = typeof value.request_id === "string" ? value.request_id.trim() : "";
  if (value.status === "ready" && !requestId) throw new Error("ready oracle runtime requires a non-empty request_id");
  if (value.request_id !== undefined && !requestId) throw new Error("oracle runtime request_id must be non-empty when present");
  return {
    version: 1,
    runId: value.run_id.trim(),
    revision: value.revision,
    status: value.status,
    requestId,
    reason: typeof value.reason === "string" ? value.reason : "",
    updatedAt: value.updated_at
  };
}

export function parseRequestPayload(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("oracle request is not valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("oracle request must contain a JSON object");
  rejectUnknown(value, ["version", "request_id", "prompt", "created_at", "response_format", "metadata"], "oracle request");
  if (value.version !== 1) throw new Error("oracle request version must be 1");
  if (typeof value.request_id !== "string" || !value.request_id.trim()) throw new Error("oracle request request_id must be a non-empty string");
  if (typeof value.prompt !== "string" || !value.prompt.trim()) throw new Error("oracle request prompt must be a non-empty string");
  if (typeof value.created_at !== "string" || !Number.isFinite(Date.parse(value.created_at))) throw new Error("oracle request created_at must be an ISO-8601 date-time string");
  if (value.response_format !== undefined && typeof value.response_format !== "string") throw new Error("oracle request response_format must be a string when present");
  if (value.metadata !== undefined && (!value.metadata || typeof value.metadata !== "object" || Array.isArray(value.metadata))) throw new Error("oracle request metadata must be an object when present");
  return {
    version: 1,
    requestId: value.request_id.trim(),
    prompt: value.prompt,
    createdAt: value.created_at,
    responseFormat: typeof value.response_format === "string" ? value.response_format : "",
    metadata: value.metadata || null
  };
}

export function parseResponseArtifact(text, expectedRequestId) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("Patient Oracle response artifact is not valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Patient Oracle response artifact must be a JSON object");
  rejectUnknown(value, ["version", "request_id", "status", "content_type", "answer", "reason", "resume_state", "completed_at", "metadata"], "response artifact");
  if (value.version !== 1) throw new Error("response artifact version must be 1");
  if (typeof value.request_id !== "string" || value.request_id.trim() !== String(expectedRequestId || "").trim()) throw new Error("response artifact request_id mismatch");
  if (!HANDOFF_STATUSES.has(value.status)) throw new Error(`unsupported response artifact status: ${String(value.status)}`);
  if (value.content_type !== undefined && (typeof value.content_type !== "string" || !value.content_type.trim())) throw new Error("response artifact content_type must be a non-empty string when present");
  if (value.answer !== undefined && typeof value.answer !== "string") throw new Error("response artifact answer must be a string when present");
  if (value.reason !== undefined && typeof value.reason !== "string") throw new Error("response artifact reason must be a string when present");
  if (value.completed_at !== undefined && (typeof value.completed_at !== "string" || !Number.isFinite(Date.parse(value.completed_at)))) throw new Error("response artifact completed_at must be ISO-8601 when present");
  if (value.metadata !== undefined && (!value.metadata || typeof value.metadata !== "object" || Array.isArray(value.metadata))) throw new Error("response artifact metadata must be an object when present");
  if (value.status === "complete" && !String(value.answer || "").trim()) throw new Error("complete response artifact requires a non-empty answer");
  if (["needs_user", "blocked"].includes(value.status) && !String(value.reason || "").trim()) throw new Error(`${value.status} response artifact requires reason`);
  if (value.status === "continue" && (!String(value.reason || "").trim() || value.resume_state === undefined || value.resume_state === null)) throw new Error("continue response artifact requires reason and resume_state");
  return {
    version: 1,
    requestId: value.request_id.trim(),
    status: value.status,
    contentType: String(value.content_type || "text/markdown").trim(),
    answer: typeof value.answer === "string" ? value.answer : "",
    reason: typeof value.reason === "string" ? value.reason : "",
    resumeState: value.resume_state ?? null,
    completedAt: typeof value.completed_at === "string" ? value.completed_at : "",
    metadata: value.metadata || null
  };
}

export function normalizeMaxRedispatches(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_CONFIG.maxRedispatchesPerRequest;
  return Math.min(20, Math.max(1, Math.floor(parsed)));
}

export function createExecutionBudget(nowMs = Date.now()) {
  return {
    startedAt: new Date(nowMs).toISOString(),
    checkpointAt: new Date(nowMs + 18 * 60 * 1000).toISOString(),
    hardStopAt: new Date(nowMs + 20 * 60 * 1000).toISOString()
  };
}

export function responseFilename(requestId) {
  const id = normalizeRequestId(requestId);
  return `patient-oracle-response-${id}.json`;
}

export function buildWorkerPrompt(runtime, request, budget, resumeState = null) {
  const filename = responseFilename(request.requestId);
  const formatHint = request.responseFormat ? `Requested response format hint: ${request.responseFormat}.` : "Default to Markdown for prose answers.";
  const resume = resumeState === null ? "" : `\nContinuation state from the previous turn:\n${JSON.stringify(resumeState)}`;
  return [
    "You are the Patient Oracle worker in a disposable ChatGPT conversation.",
    "Do not use GitHub, GitHub plugins, connectors, OAuth, or repository tools in this turn. The browser extension is the only GitHub reader/writer.",
    `Request identity: run_id=${runtime.runId}; revision=${runtime.revision}; request_id=${request.requestId}.`,
    `Execution started at ${budget.startedAt}. Checkpoint is ${budget.checkpointAt}. Hard stop is before ${budget.hardStopAt}.`,
    "At the checkpoint begin no new long work. If the request cannot finish safely, preserve exact resumable state instead of pretending completion.",
    `The only machine-readable handoff is a generated downloadable UTF-8 JSON file named exactly ${filename}.`,
    "Do not rely on ordinary assistant message text as the result channel. You may explain briefly in chat, but the extension ignores that text.",
    "For success, the file must be a JSON object with exactly: version, request_id, status, content_type, answer, completed_at, and optional metadata. Use version 1, the exact request_id, status complete, a useful MIME-like content_type (normally text/markdown), the full answer string, and a current ISO-8601 completed_at.",
    "For human input, create the same file with status needs_user and reason instead of answer. For an unsafe/impossible execution state, use status blocked and reason.",
    "For continuation before the 20-minute hard stop, create the same file with status continue, reason, and resume_state containing exact resumable state. The extension will persist the checkpoint and publish a higher ready revision for the same request.",
    "Create and attach the file itself; do not merely paste the JSON into the chat message.",
    formatHint,
    `USER REQUEST:\n${request.prompt}${resume}`
  ].join("\n\n");
}

export function streamKey(config) {
  return [config.owner, config.repo, config.branch || "main", config.path || ORACLE_RUNTIME_PATH]
    .map((part) => String(part || "").trim()).join("/");
}

export function requestPath(requestId) {
  return `.patient-oracle/requests/${normalizeRequestId(requestId)}.json`;
}

export function responsePath(requestId) {
  return `.patient-oracle/responses/${normalizeRequestId(requestId)}.json`;
}

export function checkpointPath(requestId, revision) {
  const id = normalizeRequestId(requestId);
  const rev = Number(revision);
  if (!Number.isSafeInteger(rev) || rev < 1) throw new Error("invalid checkpoint revision");
  return `.patient-oracle/checkpoints/${id}/revision-${rev}.json`;
}

function rejectUnknown(value, allowed, label) {
  const set = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !set.has(key));
  if (unknown.length) throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}`);
}

function normalizeRequestId(value) {
  const id = String(value || "").trim();
  if (!id || id.includes("/") || id.includes("..") || !/^[A-Za-z0-9._-]+$/.test(id)) throw new Error("invalid oracle request ID");
  return id;
}

function normalizeTabId(tabId) {
  const value = Number(tabId);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("A valid Chrome tab ID is required");
  return value;
}
