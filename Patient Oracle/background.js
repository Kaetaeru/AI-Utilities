import {
  DEFAULT_CONFIG,
  DEFAULT_STATE,
  ORACLE_TERMINAL_STATUSES,
  buildBootstrapPrompt,
  buildWorkerPrompt,
  configKey,
  createExecutionBudget,
  normalizeMaxRedispatches,
  parseRequestPayload,
  parseRuntimePayload,
  requestPath,
  stateKey,
  streamKey
} from "./control.js";

const PANEL_PORT = "patient-oracle-panel";
const CONTENT_PORT = "patient-oracle-content";
const RECOVERY_IDLE_MS = 1500;
const MIN_EXECUTION_MS = 5000;
const caches = new Map();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === PANEL_PORT) installPanelPort(port);
  if (port.name === CONTENT_PORT) installContentPort(port);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.local.remove([configKey(tabId), stateKey(tabId)]);
});

function installPanelPort(port) {
  port.onMessage.addListener((message) => {
    const requestId = String(message?.requestId || "");
    handlePanelMessage(message)
      .then((result) => port.postMessage({ requestId, ok: true, ...result }))
      .catch((error) => port.postMessage({ requestId, ok: false, error: error instanceof Error ? error.message : String(error) }));
  });
}

function installContentPort(port) {
  const tabId = port.sender?.tab?.id;
  if (!Number.isSafeInteger(tabId)) return;
  port.onMessage.addListener((message) => {
    void handleContentMessage(tabId, message).catch((error) => {
      void updateState(tabId, { lastError: error instanceof Error ? error.message : String(error) });
    });
  });
}

async function handlePanelMessage(message) {
  const tabId = normalizeTabId(message?.tabId);
  if (message?.type === "PATIENT_ORACLE_STATUS") return { config: await loadConfig(tabId), state: await loadState(tabId) };
  if (message?.type === "PATIENT_ORACLE_SAVE") {
    const state = await loadState(tabId);
    if (state.enabled) throw new Error("Stop Patient Oracle before changing settings");
    const config = normalizeConfig(message.config);
    await chrome.storage.local.set({ [configKey(tabId)]: config });
    return { config };
  }
  if (message?.type === "PATIENT_ORACLE_START") return startOracle(tabId);
  if (message?.type === "PATIENT_ORACLE_STOP") return stopOracle(tabId, "manual");
  throw new Error(`Unsupported Patient Oracle panel message: ${String(message?.type || "")}`);
}

async function startOracle(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isChatGptUrl(tab.url || "")) throw new Error("Open Patient Oracle from an active ChatGPT tab");
  const config = await loadConfig(tabId);
  if (!config.owner || !config.repo) throw new Error("GitHub owner and repository are required");
  await assertRepositoryBranchAccessible(config);
  const conflict = await findConflictingOwner(tabId, config);
  if (conflict !== null) throw new Error(`This Patient Oracle stream is already owned by tab ${conflict}`);
  const previous = await loadState(tabId);
  const key = streamKey(config);
  await updateState(tabId, {
    ...DEFAULT_STATE,
    enabled: true,
    streamKey: key,
    lastRunId: previous.streamKey === key ? previous.lastRunId : null,
    lastRevision: previous.streamKey === key ? previous.lastRevision : -1,
    lastDispatchedRevision: previous.streamKey === key ? previous.lastDispatchedRevision : -1,
    stopReason: null,
    lastError: null
  });
  await ensureContentScript(tabId);
  return pollOracle(tabId, { forceFetch: true, trigger: "start" });
}

async function stopOracle(tabId, reason) {
  await updateState(tabId, { enabled: false, dispatching: false, executing: false, executionToken: null, stopReason: reason });
  return { action: "stopped", reason };
}

async function handleContentMessage(tabId, message) {
  const state = await loadState(tabId);
  if (!state.enabled) return;
  if (message?.type === "PATIENT_ORACLE_TURN_FINISHED") {
    if (!state.executing || (state.executionToken && state.executionToken !== message.executionToken)) return;
    const wasBootstrap = state.lastStatus === "bootstrapping";
    await updateState(tabId, { executing: false, executionToken: null, lastFinishedAt: new Date().toISOString() });
    try {
      return await pollOracle(tabId, { forceFetch: true, trigger: "turn_finished" });
    } catch (error) {
      if (wasBootstrap && isMissingRuntimeError(error)) {
        await stopOracle(tabId, "bootstrap_incomplete");
        await updateState(tabId, { lastError: "Bootstrap turn ended without creating the durable runtime" });
        return;
      }
      throw error;
    }
  }
  if (message?.type === "PATIENT_ORACLE_CHECKPOINT_DUE" && state.executionToken === message.executionToken) {
    await updateState(tabId, { lastReason: "18-minute checkpoint due" });
    return;
  }
  if (message?.type === "PATIENT_ORACLE_HARD_STOP" && state.executionToken === message.executionToken) {
    await stopOracle(tabId, "20_minute_hard_stop");
    await updateState(tabId, { lastError: message.approvalVisible ? "20-minute hard stop reached while GitHub approval remained pending" : "20-minute hard stop reached before a durable GitHub handoff was observed" });
    return;
  }
  if (message?.type === "PATIENT_ORACLE_POLL") {
    const dispatchAt = Date.parse(String(state.lastDispatchAt || ""));
    const age = Number.isFinite(dispatchAt) ? Date.now() - dispatchAt : 0;
    if (state.executing && !message.approvalVisible && Number(message.idleStableForMs || 0) >= RECOVERY_IDLE_MS && age >= MIN_EXECUTION_MS) {
      await updateState(tabId, { executing: false, executionToken: null, lastFinishedAt: new Date().toISOString() });
      return pollOracle(tabId, { forceFetch: true, trigger: "idle_recovery" });
    }
    if (!state.executing) return pollOracle(tabId, { forceFetch: false, trigger: "content_poll" });
  }
}

async function pollOracle(tabId, { forceFetch = false, trigger = "poll" } = {}) {
  const state = await loadState(tabId);
  if (!state.enabled || state.dispatching || state.executing) return { action: "none", trigger };
  const pausedUntil = Date.parse(String(state.rateLimitPausedUntil || ""));
  if (Number.isFinite(pausedUntil) && pausedUntil > Date.now()) return { action: "wait", reason: "rate_limit", retryAt: state.rateLimitPausedUntil, trigger };
  const config = await loadConfig(tabId);
  let runtime;
  try {
    runtime = await fetchRuntime(tabId, config, forceFetch);
  } catch (error) {
    if (isMissingRuntimeError(error) && state.lastStatus !== "bootstrapping") return bootstrapOracle(tabId, config);
    throw error;
  }
  return reconcileRuntime(tabId, runtime, config, trigger);
}

async function reconcileRuntime(tabId, runtime, config, trigger) {
  let state = await loadState(tabId);
  const runChanged = runtime.runId !== state.lastRunId;
  if (!runChanged && state.lastRevision >= 0 && runtime.revision < state.lastRevision) {
    await stopOracle(tabId, "revision_regressed");
    await updateState(tabId, { lastError: `Patient Oracle revision regressed from ${state.lastRevision} to ${runtime.revision}` });
    return { action: "needs_user", reason: "revision_regressed", runtime, trigger };
  }
  if (runChanged) state = await updateState(tabId, { lastRunId: runtime.runId, lastDispatchedRevision: -1, currentRequestId: null, requestDispatchCount: 0 });
  state = await updateState(tabId, { lastRunId: runtime.runId, lastRevision: runtime.revision, lastStatus: runtime.status, lastReason: runtime.reason, lastCheckedAt: new Date().toISOString(), lastError: null });
  if (ORACLE_TERMINAL_STATUSES.has(runtime.status)) return { action: "wait", reason: runtime.status, runtime, trigger };
  if (runtime.status !== "ready") return { action: "none", runtime, trigger };
  if (runtime.revision <= Number(state.lastDispatchedRevision ?? -1)) return { action: "none", reason: "already_dispatched", runtime, trigger };
  const nextCount = runtime.requestId === state.currentRequestId ? Number(state.requestDispatchCount || 0) + 1 : 1;
  if (nextCount > config.maxRedispatchesPerRequest) {
    await stopOracle(tabId, "request_redispatch_limit");
    await updateState(tabId, { lastError: `Request ${runtime.requestId} exceeded the local ${config.maxRedispatchesPerRequest}-dispatch circuit breaker` });
    return { action: "needs_user", reason: "request_redispatch_limit", runtime, trigger };
  }
  return dispatchRequest(tabId, runtime, config, nextCount, trigger);
}

async function bootstrapOracle(tabId, config) {
  const budget = createExecutionBudget();
  const executionToken = `oracle-bootstrap:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  const prompt = buildBootstrapPrompt(config, budget);
  await updateState(tabId, { enabled: true, dispatching: true, executing: false, executionToken, executionStartedAt: budget.startedAt, checkpointAt: budget.checkpointAt, executionHardStopAt: budget.hardStopAt, lastStatus: "bootstrapping", lastDispatchAt: new Date().toISOString() });
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "PATIENT_ORACLE_PROMPT", prompt, executionToken, checkpointAt: budget.checkpointAt, hardStopAt: budget.hardStopAt });
    if (!response?.sent) throw new Error(response?.error || "Patient Oracle bootstrap prompt was not dispatched");
  } catch (error) {
    await stopOracle(tabId, "bootstrap_send_failed");
    await updateState(tabId, { lastError: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  await updateState(tabId, { dispatching: false, executing: true });
  return { action: "bootstrapping", executionToken };
}

async function dispatchRequest(tabId, runtime, config, nextCount, trigger) {
  const request = await fetchRequest(tabId, config, runtime.requestId);
  if (request.requestId !== runtime.requestId) throw new Error("runtime/request identity mismatch");
  const budget = createExecutionBudget();
  const executionToken = `oracle:${runtime.revision}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  const prompt = buildWorkerPrompt(runtime, request, config, budget);
  await updateState(tabId, { dispatching: true, executionToken, lastError: null });
  try {
    await chrome.tabs.update(tabId, { url: "https://chatgpt.com/" });
    await waitForTabComplete(tabId, 20000);
    await ensureContentScript(tabId);
    const response = await chrome.tabs.sendMessage(tabId, { type: "PATIENT_ORACLE_PROMPT", prompt, executionToken, checkpointAt: budget.checkpointAt, hardStopAt: budget.hardStopAt });
    if (!response?.sent) throw new Error(response?.error || "Patient Oracle prompt was not dispatched");
  } catch (error) {
    await stopOracle(tabId, "dispatch_failed");
    await updateState(tabId, { lastError: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  await updateState(tabId, { dispatching: false, executing: true, executionToken, executionStartedAt: budget.startedAt, checkpointAt: budget.checkpointAt, executionHardStopAt: budget.hardStopAt, lastDispatchedRevision: runtime.revision, currentRequestId: runtime.requestId, requestDispatchCount: nextCount, lastDispatchAt: new Date().toISOString(), lastStatus: "executing" });
  return { action: "dispatched", requestId: runtime.requestId, revision: runtime.revision, executionToken, trigger };
}

async function fetchRuntime(tabId, config, forceFetch) {
  const cache = cacheFor(config);
  const intervalMs = effectivePollMs(config);
  if (!forceFetch && cache.runtime && Date.now() - cache.lastFetchAt < intervalMs) return cache.runtime;
  const result = await githubRawFetch(tabId, config, config.path, cache.etag);
  if (result.notModified && cache.runtime) return cache.runtime;
  cache.etag = result.etag;
  cache.lastFetchAt = Date.now();
  cache.runtime = parseRuntimePayload(result.text);
  return cache.runtime;
}

async function fetchRequest(tabId, config, requestId) {
  const result = await githubRawFetch(tabId, config, requestPath(requestId), null);
  return parseRequestPayload(result.text);
}

async function githubRawFetch(tabId, config, path, etag) {
  const url = contentsUrl(config, path);
  const headers = githubHeaders(config.githubToken, "application/vnd.github.raw+json");
  if (etag) headers["If-None-Match"] = etag;
  const response = await fetch(url, { method: "GET", headers, cache: "no-store" });
  await recordRateLimit(tabId, response);
  await pauseForRateLimitIfNeeded(tabId, response);
  if (response.status === 304) return { notModified: true, etag, text: "" };
  if (!response.ok) {
    const error = new Error(`GitHub Patient Oracle request failed with HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return { notModified: false, etag: response.headers.get("etag"), text: await response.text() };
}

async function assertRepositoryBranchAccessible(config) {
  const url = new URL(`https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents`);
  url.searchParams.set("ref", config.branch);
  const response = await fetch(url.toString(), { method: "GET", headers: githubHeaders(config.githubToken), cache: "no-store" });
  if (response.ok) return;
  if (response.status === 401) throw new Error("GitHub authentication failed; check the extension token");
  if (response.status === 403 || response.status === 429) throw new Error("GitHub preflight is rate-limited; Patient Oracle will not bootstrap until repository identity can be verified");
  if (response.status === 404) throw new Error("GitHub repository or branch cannot be read; check owner, repository, branch, and token access");
  throw new Error(`GitHub repository preflight failed with HTTP ${response.status}`);
}

function contentsUrl(config, path) {
  const encoded = String(path).split("/").map(encodeURIComponent).join("/");
  const url = new URL(`https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${encoded}`);
  url.searchParams.set("ref", config.branch);
  return url.toString();
}
function githubHeaders(token, accept = "application/vnd.github+json") { const headers = { Accept: accept, "X-GitHub-Api-Version": "2022-11-28" }; if (token) headers.Authorization = `Bearer ${token}`; return headers; }
async function recordRateLimit(tabId, response) { const remaining = Number(response.headers.get("x-ratelimit-remaining")); const reset = Number(response.headers.get("x-ratelimit-reset")); await updateState(tabId, { lastCheckedAt: new Date().toISOString(), rateLimitRemaining: Number.isFinite(remaining) ? remaining : null, rateLimitResetAt: Number.isFinite(reset) ? new Date(reset * 1000).toISOString() : null }); }
async function pauseForRateLimitIfNeeded(tabId, response) { if (![403,429].includes(response.status)) return; const now = Date.now(); const retryAfter = Number(response.headers.get("retry-after")); const reset = Number(response.headers.get("x-ratelimit-reset")); let until = Number.isFinite(retryAfter) && retryAfter > 0 ? now + retryAfter * 1000 : null; if (until === null && response.headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset)) until = Math.max(now + 1000, reset * 1000); if (until === null && response.status === 429) until = now + 60000; if (until === null) return; await updateState(tabId, { rateLimitPausedUntil: new Date(until).toISOString(), lastError: null }); const error = new Error("Patient Oracle GitHub polling paused for rate limiting"); error.name = "PatientOracleRateLimitPause"; error.untilMs = until; throw error; }
function cacheFor(config) { const key = streamKey(config); if (!caches.has(key)) caches.set(key, { etag: null, runtime: null, lastFetchAt: 0 }); return caches.get(key); }
function effectivePollMs(config) { const requested = Number(config.pollIntervalSeconds); return Math.max(config.githubToken ? 5 : 90, Number.isFinite(requested) ? Math.floor(requested) : 90) * 1000; }
async function loadConfig(tabId) { const stored = await chrome.storage.local.get(configKey(tabId)); return normalizeConfig({ ...DEFAULT_CONFIG, ...(stored[configKey(tabId)] || {}) }); }
async function loadState(tabId) { const stored = await chrome.storage.local.get(stateKey(tabId)); return { ...DEFAULT_STATE, ...(stored[stateKey(tabId)] || {}) }; }
async function updateState(tabId, patch) { const next = { ...await loadState(tabId), ...patch }; await chrome.storage.local.set({ [stateKey(tabId)]: next }); return next; }
function normalizeConfig(value) { const poll = Number(value?.pollIntervalSeconds); return { owner: String(value?.owner || "").trim(), repo: String(value?.repo || "").trim(), branch: String(value?.branch || "main").trim() || "main", githubToken: String(value?.githubToken || "").trim(), path: String(value?.path || DEFAULT_CONFIG.path).replace(/^\/+/, "").trim() || DEFAULT_CONFIG.path, pollIntervalSeconds: Number.isFinite(poll) ? Math.max(5, Math.floor(poll)) : DEFAULT_CONFIG.pollIntervalSeconds, maxRedispatchesPerRequest: normalizeMaxRedispatches(value?.maxRedispatchesPerRequest) }; }
async function findConflictingOwner(tabId, config) { const all = await chrome.storage.local.get(null); const wanted = streamKey(config); for (const [key, value] of Object.entries(all)) { if (!key.startsWith("patientOracleState:") || !value?.enabled) continue; const otherTabId = Number(key.slice("patientOracleState:".length)); if (!Number.isSafeInteger(otherTabId) || otherTabId === tabId) continue; const otherConfig = normalizeConfig(all[configKey(otherTabId)] || {}); if (streamKey(otherConfig) === wanted) return otherTabId; } return null; }
async function ensureContentScript(tabId) { try { const ping = await chrome.tabs.sendMessage(tabId, { type: "PATIENT_ORACLE_PING" }); if (ping?.ready) return; } catch {} await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] }); const ping = await chrome.tabs.sendMessage(tabId, { type: "PATIENT_ORACLE_PING" }); if (!ping?.ready) throw new Error("Patient Oracle content script injection failed"); }
function waitForTabComplete(tabId, timeoutMs) { return new Promise((resolve, reject) => { let timer = null; const done = () => { if (timer) clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpdated); resolve(); }; const onUpdated = (updatedTabId, changeInfo) => { if (updatedTabId === tabId && changeInfo.status === "complete") done(); }; chrome.tabs.onUpdated.addListener(onUpdated); chrome.tabs.get(tabId).then((tab) => { if (tab.status === "complete") done(); }).catch(() => {}); timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpdated); reject(new Error("Timed out waiting for fresh ChatGPT conversation")); }, timeoutMs); }); }
function isMissingRuntimeError(error) { return Number(error?.status) === 404 || /HTTP 404|runtime.*not found|not found/i.test(String(error?.message || error || "")); }
function normalizeTabId(tabId) { const value = Number(tabId); if (!Number.isSafeInteger(value) || value < 0) throw new Error("A valid ChatGPT tab ID is required"); return value; }
function isChatGptUrl(url) { try { const host = new URL(url).hostname; return host === "chatgpt.com" || host === "chat.openai.com"; } catch { return false; } }
