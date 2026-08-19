export const ORACLE_RUNTIME_PATH = ".patient-oracle/runtime.json";
export const ORACLE_CONTRACT_PATH = ".patient-oracle/CONTRACT.md";
export const ORACLE_STATUSES = new Set(["ready", "complete", "needs_user", "blocked"]);
export const ORACLE_TERMINAL_STATUSES = new Set(["complete", "needs_user", "blocked"]);

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
  executionToken: null,
  executionStartedAt: null,
  executionHardStopAt: null,
  checkpointAt: null,
  lastRunId: null,
  lastRevision: -1,
  lastDispatchedRevision: -1,
  currentRequestId: null,
  requestDispatchCount: 0,
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
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("oracle runtime is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("oracle runtime must contain a JSON object");
  }
  const allowedKeys = new Set(["version", "run_id", "revision", "status", "request_id", "reason", "updated_at"]);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length) throw new Error(`oracle runtime contains unsupported fields: ${unknownKeys.join(", ")}`);
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
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("oracle request is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("oracle request must contain a JSON object");
  const allowedKeys = new Set(["version", "request_id", "prompt", "created_at", "response_format", "metadata"]);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length) throw new Error(`oracle request contains unsupported fields: ${unknownKeys.join(", ")}`);
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

export function normalizeMaxRedispatches(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_CONFIG.maxRedispatchesPerRequest;
  return Math.min(20, Math.max(1, Math.floor(parsed)));
}

export function createExecutionBudget(nowMs = Date.now()) {
  const checkpointMs = nowMs + 18 * 60 * 1000;
  const hardStopMs = nowMs + 20 * 60 * 1000;
  return {
    startedAt: new Date(nowMs).toISOString(),
    checkpointAt: new Date(checkpointMs).toISOString(),
    hardStopAt: new Date(hardStopMs).toISOString()
  };
}

export function buildWorkerPrompt(runtime, request, config, budget) {
  const requestPath = `.patient-oracle/requests/${request.requestId}.json`;
  const responsePath = `.patient-oracle/responses/${request.requestId}.json`;
  return [
    "You are the Patient Oracle worker. Treat this ChatGPT conversation as disposable execution state; GitHub is the only durable source of truth.",
    `Target GitHub repository: ${config.owner}/${config.repo}, branch ${config.branch || "main"}.`,
    `Runtime: ${config.path}; run_id=${runtime.runId}; revision=${runtime.revision}; request_id=${runtime.requestId}.`,
    `Read ${ORACLE_CONTRACT_PATH}, then ${config.path}, then ${requestPath}. If current GitHub state differs from this prompt, GitHub is authoritative.`,
    `Write the durable result to ${responsePath}. The extension will not scrape your assistant answer from the DOM.`,
    "For success, write response JSON first, verify it exists, then update runtime.json last with a higher revision and status complete for the same request_id.",
    "If human input or manual permission is required, write durable reason/state and publish needs_user. If safe progress is impossible, publish blocked.",
    `Execution started at ${budget.startedAt}. The 18-minute checkpoint begins at ${budget.checkpointAt}. Hard stop is before ${budget.hardStopAt}.`,
    "At the checkpoint, begin no new long operations. If incomplete, preserve the same request identity, publish a higher ready revision for continuation, and end before 20 minutes.",
    "Never click or attempt to bypass GitHub approval/OAuth/admin controls. If ChatGPT presents an approval decision, wait for the user.",
    "Do not invent repository state, test results, citations, or completed writes. Verify before declaring complete."
  ].join(" ");
}

export function buildBootstrapPrompt(config, budget) {
  return [
    "Initialize the Patient Oracle protocol in the connected GitHub repository.",
    `Target repository: ${config.owner}/${config.repo}, branch ${config.branch || "main"}.`,
    `Create ${ORACLE_CONTRACT_PATH} and ${config.path}. Do not create a fake user request.`,
    "The contract must state that GitHub is the only durable source of truth; requests live under .patient-oracle/requests/<request_id>.json; responses live under .patient-oracle/responses/<request_id>.json; runtime.json is the final authoritative handoff write; revision is monotonic; assistant DOM text is never the durable response channel.",
    "Preserve safety invariants: one owner per stream, no revision regression, no duplicate revision dispatch, execution-token matching, bounded redispatch, protect non-empty user composer text, require visible submission evidence, never auto-click GitHub approval/OAuth/admin controls, pause on GitHub rate limits, use DOM completion only as a wake signal, keep polling as recovery, and stop on repository-coordinate changes.",
    "The contract must include the 20-minute execution law: checkpoint around minute 18, begin no new long work after the checkpoint, persist exact resumable state, never claim incomplete work complete, publish a higher ready revision for the same request when continuation is required, and end before 20 minutes.",
    `Initialize ${config.path} last as strict JSON with exactly version, run_id, revision, status, reason, updated_at. Use version 1, a new non-empty run_id, revision 0, status complete, reason \"initialized; waiting for caller request\", and a current ISO-8601 updated_at.`,
    "Verify both GitHub writes. Do not invent successful writes or repository state.",
    `This bootstrap turn started at ${budget.startedAt}; checkpoint at ${budget.checkpointAt}; hard stop before ${budget.hardStopAt}.`,
    "If GitHub requires manual approval, wait. Never click or bypass the approval yourself."
  ].join(" ");
}

export function streamKey(config) {
  return [config.owner, config.repo, config.branch || "main", config.path || ORACLE_RUNTIME_PATH]
    .map((part) => String(part || "").trim())
    .join("/");
}

export function requestPath(requestId) {
  const id = String(requestId || "").trim();
  if (!id || id.includes("/") || id.includes("..")) throw new Error("invalid oracle request ID");
  return `.patient-oracle/requests/${id}.json`;
}

function normalizeTabId(tabId) {
  const value = Number(tabId);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("A valid Chrome tab ID is required");
  return value;
}
