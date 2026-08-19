import {
  DEFAULT_CONFIG,
  DEFAULT_STATE,
  ORACLE_CONTRACT_PATH,
  ORACLE_TERMINAL_STATUSES,
  buildWorkerPrompt,
  checkpointPath,
  configKey,
  createExecutionBudget,
  normalizeMaxRedispatches,
  parseRequestPayload,
  parseResponseArtifact,
  parseRuntimePayload,
  requestPath,
  responseFilename,
  responsePath,
  stateKey,
  streamKey
} from "./control.js";

const PANEL_PORT = "patient-oracle-panel";
const CONTENT_PORT = "patient-oracle-content";
const MAX_RESPONSE_ARTIFACT_BYTES = 8 * 1024 * 1024;
const caches = new Map();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === PANEL_PORT) installPanelPort(port);
  if (port.name === CONTENT_PORT) installContentPort(port);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.local.remove([configKey(tabId), stateKey(tabId)]);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  for (const [key, change] of Object.entries(changes)) {
    if (!key.startsWith("patientOracleConfig:")) continue;
    const tabId = Number(key.slice("patientOracleConfig:".length));
    if (!Number.isSafeInteger(tabId)) continue;
    const before = normalizeConfig(change.oldValue || {});
    const after = normalizeConfig(change.newValue || {});
    if (coordinatesKey(before) === coordinatesKey(after)) continue;
    void loadState(tabId).then((state) => {
      if (state.enabled) return stopOracle(tabId, "repository_coordinates_changed");
    }).catch(() => {});
  }
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
    Promise.resolve(handleContentMessage(tabId, message))
      .then((result) => {
        if (message?.messageId) port.postMessage({ type: "PATIENT_ORACLE_ACK", messageId: message.messageId, ok: true, result: result || null });
      })
      .catch((error) => {
        const retryable = error?.name === "PatientOracleRateLimitPause";
        if (message?.messageId) port.postMessage({ type: "PATIENT_ORACLE_ACK", messageId: message.messageId, ok: false, retryable, error: error instanceof Error ? error.message : String(error) });
        if (!retryable) void updateState(tabId, { lastError: error instanceof Error ? error.message : String(error) });
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
  if (!config.githubToken) throw new Error("A GitHub token is required because Patient Oracle now performs the durable GitHub writes itself");
  await assertRepositoryBranchAccessible(tabId, config);
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
  await updateState(tabId, {
    enabled: false,
    dispatching: false,
    executing: false,
    finalizing: false,
    executionToken: null,
    expectedResponseFilename: null,
    stopReason: reason
  });
  return { action: "stopped", reason };
}

async function handleContentMessage(tabId, message) {
  const state = await loadState(tabId);
  if (!state.enabled) return { action: "ignored", reason: "disabled" };

  if (message?.type === "PATIENT_ORACLE_RESPONSE_ARTIFACT") {
    if (!state.executing || !state.executionToken || state.executionToken !== message.executionToken) return { action: "ignored", reason: "stale_execution_token" };
    return finalizeResponseArtifact(tabId, message);
  }

  if (message?.type === "PATIENT_ORACLE_RESPONSE_ARTIFACT_URL") {
    if (!state.executing || !state.executionToken || state.executionToken !== message.executionToken) return { action: "ignored", reason: "stale_execution_token" };
    const text = await fetchGeneratedArtifactUrl(message.url);
    return finalizeResponseArtifact(tabId, { ...message, text });
  }

  if (message?.type === "PATIENT_ORACLE_CHECKPOINT_DUE" && state.executionToken === message.executionToken) {
    await updateState(tabId, { lastStatus: "checkpoint_due", lastReason: "18-minute checkpoint due; waiting for a continue or terminal response artifact" });
    return { action: "checkpoint_due" };
  }

  if (message?.type === "PATIENT_ORACLE_HARD_STOP" && state.executionToken === message.executionToken) {
    await stopOracle(tabId, "20_minute_hard_stop");
    await updateState(tabId, { lastError: "20-minute hard stop reached before a durable file handoff completed" });
    return { action: "stopped", reason: "20_minute_hard_stop" };
  }

  if (message?.type === "PATIENT_ORACLE_TURN_IDLE" && state.executionToken === message.executionToken) {
    await updateState(tabId, { lastStatus: "waiting_for_response_file", lastReason: "ChatGPT is idle; waiting for the generated Patient Oracle response file" });
    return { action: "wait", reason: "response_file" };
  }

  if (message?.type === "PATIENT_ORACLE_ARTIFACT_ERROR" && state.executionToken === message.executionToken) {
    await updateState(tabId, { lastStatus: "waiting_for_response_file", lastError: String(message.error || "Could not read generated response file") });
    return { action: "wait", reason: "artifact_error" };
  }

  if (message?.type === "PATIENT_ORACLE_POLL" && !state.executing && !state.dispatching && !state.finalizing) {
    return pollOracle(tabId, { forceFetch: false, trigger: "content_poll" });
  }

  return { action: "none" };
}

async function pollOracle(tabId, { forceFetch = false, trigger = "poll" } = {}) {
  const state = await loadState(tabId);
  if (!state.enabled || state.dispatching || state.executing || state.finalizing) return { action: "none", trigger };
  const pausedUntil = Date.parse(String(state.rateLimitPausedUntil || ""));
  if (Number.isFinite(pausedUntil) && pausedUntil > Date.now()) return { action: "wait", reason: "rate_limit", retryAt: state.rateLimitPausedUntil, trigger };
  const config = await loadConfig(tabId);
  try {
    let runtime;
    try {
      runtime = await fetchRuntime(tabId, config, forceFetch);
    } catch (error) {
      if (isMissingRuntimeError(error)) return bootstrapRepository(tabId, config);
      throw error;
    }
    return reconcileRuntime(tabId, runtime, config, trigger);
  } catch (error) {
    if (error?.name === "PatientOracleRateLimitPause") return { action: "wait", reason: "rate_limit", trigger };
    throw error;
  }
}

async function reconcileRuntime(tabId, runtime, config, trigger) {
  let state = await loadState(tabId);
  const runChanged = runtime.runId !== state.lastRunId;
  if (!runChanged && state.lastRevision >= 0 && runtime.revision < state.lastRevision) {
    await stopOracle(tabId, "revision_regressed");
    await updateState(tabId, { lastError: `Patient Oracle revision regressed from ${state.lastRevision} to ${runtime.revision}` });
    return { action: "needs_user", reason: "revision_regressed", runtime, trigger };
  }
  if (runChanged) {
    state = await updateState(tabId, { lastRunId: runtime.runId, lastDispatchedRevision: -1, currentRequestId: null, requestDispatchCount: 0 });
  }
  state = await updateState(tabId, {
    lastRunId: runtime.runId,
    lastRevision: runtime.revision,
    lastStatus: runtime.status,
    lastReason: runtime.reason,
    lastCheckedAt: new Date().toISOString(),
    lastError: null
  });
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

async function bootstrapRepository(tabId, config) {
  if (!config.githubToken) throw new Error("GitHub token is required for Patient Oracle bootstrap");
  const contractText = await loadBundledContract();
  const existingContract = await getGitHubFile(tabId, config, ORACLE_CONTRACT_PATH, { allow404: true });
  if (!existingContract) {
    await putGitHubText(tabId, config, ORACLE_CONTRACT_PATH, contractText, "patient-oracle: bootstrap contract");
  }
  const verifiedContract = await getGitHubFile(tabId, config, ORACLE_CONTRACT_PATH);
  if (!verifiedContract.text.includes("Patient Oracle") || !verifiedContract.text.includes("response file")) throw new Error("Patient Oracle contract verification failed after bootstrap write");

  const racedRuntime = await getGitHubFile(tabId, config, config.path, { allow404: true });
  if (racedRuntime) return reconcileRuntime(tabId, parseRuntimePayload(racedRuntime.text), config, "bootstrap_race");

  const now = new Date().toISOString();
  const runtime = {
    version: 1,
    run_id: makeRunId(),
    revision: 0,
    status: "complete",
    reason: "initialized; waiting for caller request",
    updated_at: now
  };
  await putGitHubJson(tabId, config, config.path, runtime, "patient-oracle: bootstrap runtime");
  const verified = parseRuntimePayload((await getGitHubFile(tabId, config, config.path)).text);
  if (verified.runId !== runtime.run_id || verified.revision !== 0 || verified.status !== "complete") throw new Error("Patient Oracle runtime verification failed after bootstrap write");
  await updateState(tabId, {
    lastRunId: verified.runId,
    lastRevision: verified.revision,
    lastStatus: verified.status,
    lastReason: verified.reason,
    lastCheckedAt: new Date().toISOString(),
    lastError: null
  });
  return { action: "bootstrapped", runtime: verified };
}

async function dispatchRequest(tabId, runtime, config, nextCount, trigger) {
  const request = await fetchRequest(tabId, config, runtime.requestId);
  if (request.requestId !== runtime.requestId) throw new Error("runtime/request identity mismatch");
  const resumeState = await fetchResumeState(tabId, config, runtime.requestId, runtime.revision);
  const budget = createExecutionBudget();
  const executionToken = `oracle:${runtime.revision}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  const filename = responseFilename(runtime.requestId);
  const prompt = buildWorkerPrompt(runtime, request, budget, resumeState);
  await updateState(tabId, { dispatching: true, executionToken, expectedResponseFilename: filename, lastError: null });
  try {
    await chrome.tabs.update(tabId, { url: `https://chatgpt.com/?patient-oracle=${encodeURIComponent(executionToken)}` });
    await waitForTabComplete(tabId, 20000);
    await ensureContentScript(tabId);
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "PATIENT_ORACLE_PROMPT",
      prompt,
      executionToken,
      responseFilename: filename,
      checkpointAt: budget.checkpointAt,
      hardStopAt: budget.hardStopAt
    });
    if (!response?.sent) throw dispatchResponseError(response, "Patient Oracle prompt was not dispatched");
  } catch (error) {
    const waiting = await keepOracleWaitingOnRecoverableBlock(tabId, error);
    if (waiting) return waiting;
    await stopOracle(tabId, "dispatch_failed");
    await updateState(tabId, { lastError: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  await updateState(tabId, {
    dispatching: false,
    executing: true,
    finalizing: false,
    executionToken,
    executionStartedAt: budget.startedAt,
    checkpointAt: budget.checkpointAt,
    executionHardStopAt: budget.hardStopAt,
    expectedResponseFilename: filename,
    lastDispatchedRevision: runtime.revision,
    currentRequestId: runtime.requestId,
    requestDispatchCount: nextCount,
    lastDispatchAt: new Date().toISOString(),
    lastStatus: "executing",
    lastReason: "waiting for ChatGPT response artifact"
  });
  return { action: "dispatched", requestId: runtime.requestId, revision: runtime.revision, executionToken, trigger };
}

async function finalizeResponseArtifact(tabId, message) {
  const state = await loadState(tabId);
  if (state.finalizing) return { action: "wait", reason: "already_finalizing" };
  const filename = String(message?.filename || "");
  const text = String(message?.text || "");
  if (filename !== state.expectedResponseFilename) throw new Error(`Unexpected response filename: ${filename}`);
  if (!text || new TextEncoder().encode(text).byteLength > MAX_RESPONSE_ARTIFACT_BYTES) throw new Error("Patient Oracle response artifact is empty or exceeds the 8 MiB handoff limit");
  const artifact = parseResponseArtifact(text, state.currentRequestId);
  await updateState(tabId, { finalizing: true, lastStatus: "finalizing", lastReason: `processing ${artifact.status} response artifact`, lastError: null });
  try {
    const config = await loadConfig(tabId);
    const runtimeFile = await getGitHubFile(tabId, config, config.path);
    const runtime = parseRuntimePayload(runtimeFile.text);
    if (runtime.runId !== state.lastRunId || runtime.revision !== state.lastDispatchedRevision || runtime.status !== "ready" || runtime.requestId !== state.currentRequestId) {
      throw new Error("GitHub runtime changed before response artifact finalization; refusing to overwrite newer state");
    }
    if (artifact.status === "continue") return finalizeContinuation(tabId, config, runtimeFile, runtime, artifact);
    return finalizeTerminalResponse(tabId, config, runtimeFile, runtime, artifact);
  } finally {
    const latest = await loadState(tabId);
    if (latest.finalizing) await updateState(tabId, { finalizing: false });
  }
}

async function finalizeTerminalResponse(tabId, config, runtimeFile, runtime, artifact) {
  const completedAt = artifact.completedAt || new Date().toISOString();
  const durable = {
    version: 1,
    request_id: artifact.requestId,
    status: artifact.status,
    content_type: artifact.contentType,
    ...(artifact.status === "complete" ? { answer: artifact.answer } : { reason: artifact.reason }),
    completed_at: completedAt,
    ...(artifact.metadata ? { metadata: artifact.metadata } : {})
  };
  const path = responsePath(artifact.requestId);
  await putJsonIdempotent(tabId, config, path, durable, `patient-oracle: response ${artifact.requestId}`);
  const verifiedResponse = parseResponseArtifact((await getGitHubFile(tabId, config, path)).text, artifact.requestId);
  if (verifiedResponse.status !== artifact.status) throw new Error("Durable response verification failed");

  const nextRuntime = {
    version: 1,
    run_id: runtime.runId,
    revision: runtime.revision + 1,
    status: artifact.status,
    request_id: artifact.requestId,
    reason: artifact.status === "complete" ? "completed through Patient Oracle response-file handoff" : artifact.reason,
    updated_at: new Date().toISOString()
  };
  await putGitHubJson(tabId, config, config.path, nextRuntime, `patient-oracle: ${artifact.status} ${artifact.requestId}`, runtimeFile.sha);
  const verifiedRuntime = parseRuntimePayload((await getGitHubFile(tabId, config, config.path)).text);
  if (verifiedRuntime.revision !== nextRuntime.revision || verifiedRuntime.status !== artifact.status || verifiedRuntime.requestId !== artifact.requestId) throw new Error("Durable runtime verification failed after response write");
  await updateState(tabId, {
    executing: false,
    finalizing: false,
    executionToken: null,
    expectedResponseFilename: null,
    executionStartedAt: null,
    checkpointAt: null,
    executionHardStopAt: null,
    lastRevision: verifiedRuntime.revision,
    lastStatus: verifiedRuntime.status,
    lastReason: verifiedRuntime.reason,
    lastFinishedAt: new Date().toISOString(),
    lastError: null
  });
  return { action: "complete", status: artifact.status, revision: verifiedRuntime.revision };
}

async function finalizeContinuation(tabId, config, runtimeFile, runtime, artifact) {
  const nextRevision = runtime.revision + 1;
  const checkpoint = {
    version: 1,
    request_id: artifact.requestId,
    from_revision: runtime.revision,
    to_revision: nextRevision,
    reason: artifact.reason,
    resume_state: artifact.resumeState,
    created_at: new Date().toISOString()
  };
  const path = checkpointPath(artifact.requestId, nextRevision);
  await putJsonIdempotent(tabId, config, path, checkpoint, `patient-oracle: checkpoint ${artifact.requestId} r${nextRevision}`);
  const nextRuntime = {
    version: 1,
    run_id: runtime.runId,
    revision: nextRevision,
    status: "ready",
    request_id: artifact.requestId,
    reason: artifact.reason,
    updated_at: new Date().toISOString()
  };
  await putGitHubJson(tabId, config, config.path, nextRuntime, `patient-oracle: continue ${artifact.requestId}`, runtimeFile.sha);
  const verifiedRuntime = parseRuntimePayload((await getGitHubFile(tabId, config, config.path)).text);
  if (verifiedRuntime.revision !== nextRevision || verifiedRuntime.status !== "ready" || verifiedRuntime.requestId !== artifact.requestId) throw new Error("Continuation runtime verification failed");
  await updateState(tabId, {
    executing: false,
    finalizing: false,
    executionToken: null,
    expectedResponseFilename: null,
    executionStartedAt: null,
    checkpointAt: null,
    executionHardStopAt: null,
    lastRevision: nextRevision,
    lastStatus: "ready",
    lastReason: artifact.reason,
    lastFinishedAt: new Date().toISOString(),
    lastError: null
  });
  return pollOracle(tabId, { forceFetch: true, trigger: "continuation" });
}

async function fetchGeneratedArtifactUrl(value) {
  const url = new URL(String(value || ""));
  const allowed = url.protocol === "https:" && (url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com" || url.hostname === "files.oaiusercontent.com" || url.hostname.endsWith(".oaiusercontent.com"));
  if (!allowed) throw new Error("Patient Oracle rejected an unexpected generated-file host");
  const response = await fetch(url.href, { method: "GET", credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error(`Generated response file fetch failed with HTTP ${response.status}`);
  const text = await response.text();
  if (!text.trim()) throw new Error("Generated response file was empty");
  return text;
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
  return parseRequestPayload((await getGitHubFile(tabId, config, requestPath(requestId))).text);
}

async function fetchResumeState(tabId, config, requestId, revision) {
  if (revision < 2) return null;
  const file = await getGitHubFile(tabId, config, checkpointPath(requestId, revision), { allow404: true });
  if (!file) return null;
  let value;
  try { value = JSON.parse(file.text); } catch { throw new Error("Patient Oracle checkpoint is not valid JSON"); }
  if (!value || value.version !== 1 || value.request_id !== requestId || value.to_revision !== revision || value.resume_state === undefined) throw new Error("Patient Oracle checkpoint identity mismatch");
  return value.resume_state;
}

async function getGitHubFile(tabId, config, path, { allow404 = false } = {}) {
  const response = await fetch(contentsUrl(config, path), { method: "GET", headers: githubHeaders(config.githubToken), cache: "no-store" });
  await recordRateLimit(tabId, response);
  await pauseForRateLimitIfNeeded(tabId, response);
  if (response.status === 404 && allow404) return null;
  if (!response.ok) throw githubHttpError(response.status, `read ${path}`);
  const body = await response.json();
  if (body?.type !== "file" || typeof body.content !== "string" || typeof body.sha !== "string") throw new Error(`${path} did not resolve to a GitHub file`);
  return { sha: body.sha, text: base64ToUtf8(body.content.replace(/\n/g, "")) };
}

async function githubRawFetch(tabId, config, path, etag) {
  const headers = githubHeaders(config.githubToken, "application/vnd.github.raw+json");
  if (etag) headers["If-None-Match"] = etag;
  const response = await fetch(contentsUrl(config, path), { method: "GET", headers, cache: "no-store" });
  await recordRateLimit(tabId, response);
  await pauseForRateLimitIfNeeded(tabId, response);
  if (response.status === 304) return { notModified: true, etag, text: "" };
  if (!response.ok) throw githubHttpError(response.status, `read ${path}`);
  return { notModified: false, etag: response.headers.get("etag"), text: await response.text() };
}

async function putGitHubJson(tabId, config, path, value, message, sha = null) {
  return putGitHubText(tabId, config, path, `${JSON.stringify(value, null, 2)}\n`, message, sha);
}

async function putGitHubText(tabId, config, path, text, message, sha = null) {
  const body = { message, branch: config.branch, content: utf8ToBase64(text) };
  if (sha) body.sha = sha;
  const response = await fetch(contentsUrl(config, path, false), {
    method: "PUT",
    headers: { ...githubHeaders(config.githubToken), "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  await recordRateLimit(tabId, response);
  await pauseForRateLimitIfNeeded(tabId, response);
  if (!response.ok) throw githubHttpError(response.status, `write ${path}`);
  return response.json();
}

async function putJsonIdempotent(tabId, config, path, value, message) {
  const existing = await getGitHubFile(tabId, config, path, { allow404: true });
  const wanted = `${JSON.stringify(value, null, 2)}\n`;
  if (!existing) return putGitHubText(tabId, config, path, wanted, message);
  if (canonicalJson(existing.text) === canonicalJson(wanted)) return { idempotent: true };
  throw new Error(`${path} already exists with different content; refusing to overwrite durable history`);
}

async function assertRepositoryBranchAccessible(tabId, config) {
  const url = new URL(`https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents`);
  url.searchParams.set("ref", config.branch);
  const response = await fetch(url.toString(), { method: "GET", headers: githubHeaders(config.githubToken), cache: "no-store" });
  await recordRateLimit(tabId, response);
  await pauseForRateLimitIfNeeded(tabId, response);
  if (response.ok) return;
  if (response.status === 401) throw new Error("GitHub authentication failed; check the extension token");
  if (response.status === 403 || response.status === 429) throw new Error("GitHub preflight is rate-limited");
  if (response.status === 404) throw new Error("GitHub repository or branch cannot be read; check owner, repository, branch, and token access");
  throw new Error(`GitHub repository preflight failed with HTTP ${response.status}`);
}

function dispatchResponseError(response, fallback) {
  const error = new Error(response?.error || fallback);
  error.code = String(response?.code || "");
  return error;
}

function classifyRecoverableDispatchBlock(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || error || "");
  if (code === "composer_not_empty" || /composer is not empty|user draft is protected/i.test(message)) return { status: "waiting_for_empty_composer", reason: "User draft is protected. Clear or send the draft; Patient Oracle will retry automatically." };
  if (code === "approval_pending" || /approval is pending/i.test(message)) return { status: "waiting_for_manual_approval", reason: "A ChatGPT tool approval is pending. Patient Oracle never clicks approval controls." };
  if (code === "chat_busy" || /still generating/i.test(message)) return { status: "waiting_for_chat_idle", reason: "ChatGPT is still generating. Patient Oracle will retry when the tab is idle." };
  return null;
}

async function keepOracleWaitingOnRecoverableBlock(tabId, error) {
  const block = classifyRecoverableDispatchBlock(error);
  if (!block) return null;
  await updateState(tabId, {
    enabled: true,
    dispatching: false,
    executing: false,
    finalizing: false,
    executionToken: null,
    executionStartedAt: null,
    checkpointAt: null,
    executionHardStopAt: null,
    expectedResponseFilename: null,
    lastStatus: block.status,
    lastReason: block.reason,
    lastError: null
  });
  return { action: "wait", reason: block.status };
}

function contentsUrl(config, path, includeRef = true) {
  const encoded = String(path).split("/").map(encodeURIComponent).join("/");
  const url = new URL(`https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${encoded}`);
  if (includeRef) url.searchParams.set("ref", config.branch);
  return url.toString();
}

function githubHeaders(token, accept = "application/vnd.github+json") {
  const headers = { Accept: accept, "X-GitHub-Api-Version": "2022-11-28" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function githubHttpError(status, action) {
  const error = new Error(`GitHub Patient Oracle ${action} failed with HTTP ${status}`);
  error.status = status;
  return error;
}

async function recordRateLimit(tabId, response) {
  const remaining = Number(response.headers.get("x-ratelimit-remaining"));
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  await updateState(tabId, {
    lastCheckedAt: new Date().toISOString(),
    rateLimitRemaining: Number.isFinite(remaining) ? remaining : null,
    rateLimitResetAt: Number.isFinite(reset) ? new Date(reset * 1000).toISOString() : null
  });
}

async function pauseForRateLimitIfNeeded(tabId, response) {
  if (![403, 429].includes(response.status)) return;
  const now = Date.now();
  const retryAfter = Number(response.headers.get("retry-after"));
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  let until = Number.isFinite(retryAfter) && retryAfter > 0 ? now + retryAfter * 1000 : null;
  if (until === null && response.headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset)) until = Math.max(now + 1000, reset * 1000);
  if (until === null && response.status === 429) until = now + 60000;
  if (until === null) return;
  await updateState(tabId, { rateLimitPausedUntil: new Date(until).toISOString(), lastError: null });
  const error = new Error("Patient Oracle GitHub access paused for rate limiting");
  error.name = "PatientOracleRateLimitPause";
  error.untilMs = until;
  throw error;
}

function cacheFor(config) {
  const key = streamKey(config);
  if (!caches.has(key)) caches.set(key, { etag: null, runtime: null, lastFetchAt: 0 });
  return caches.get(key);
}

function effectivePollMs(config) {
  const requested = Number(config.pollIntervalSeconds);
  return Math.max(config.githubToken ? 5 : 90, Number.isFinite(requested) ? Math.floor(requested) : 90) * 1000;
}

async function loadConfig(tabId) {
  const stored = await chrome.storage.local.get(configKey(tabId));
  return normalizeConfig({ ...DEFAULT_CONFIG, ...(stored[configKey(tabId)] || {}) });
}

async function loadState(tabId) {
  const stored = await chrome.storage.local.get(stateKey(tabId));
  return { ...DEFAULT_STATE, ...(stored[stateKey(tabId)] || {}) };
}

async function updateState(tabId, patch) {
  const next = { ...await loadState(tabId), ...patch };
  await chrome.storage.local.set({ [stateKey(tabId)]: next });
  return next;
}

function normalizeConfig(value) {
  const poll = Number(value?.pollIntervalSeconds);
  return {
    owner: String(value?.owner || "").trim(),
    repo: String(value?.repo || "").trim(),
    branch: String(value?.branch || "main").trim() || "main",
    githubToken: String(value?.githubToken || "").trim(),
    path: String(value?.path || DEFAULT_CONFIG.path).replace(/^\/+/, "").trim() || DEFAULT_CONFIG.path,
    pollIntervalSeconds: Number.isFinite(poll) ? Math.max(5, Math.floor(poll)) : DEFAULT_CONFIG.pollIntervalSeconds,
    maxRedispatchesPerRequest: normalizeMaxRedispatches(value?.maxRedispatchesPerRequest)
  };
}

async function findConflictingOwner(tabId, config) {
  const all = await chrome.storage.local.get(null);
  const wanted = streamKey(config);
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith("patientOracleState:") || !value?.enabled) continue;
    const otherTabId = Number(key.slice("patientOracleState:".length));
    if (!Number.isSafeInteger(otherTabId) || otherTabId === tabId) continue;
    const otherConfig = normalizeConfig(all[configKey(otherTabId)] || {});
    if (streamKey(otherConfig) === wanted) return otherTabId;
  }
  return null;
}

async function ensureContentScript(tabId) {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: "PATIENT_ORACLE_PING" });
    if (ping?.ready) return;
  } catch {}
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  const ping = await chrome.tabs.sendMessage(tabId, { type: "PATIENT_ORACLE_PING" });
  if (!ping?.ready) throw new Error("Patient Oracle content script injection failed");
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const done = () => {
      if (timer) clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") done();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((tab) => { if (tab.status === "complete") done(); }).catch(() => {});
    timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Timed out waiting for fresh ChatGPT conversation"));
    }, timeoutMs);
  });
}

async function loadBundledContract() {
  const response = await fetch(chrome.runtime.getURL("CONTRACT.md"));
  if (!response.ok) throw new Error("Could not load bundled Patient Oracle contract");
  return response.text();
}

function canonicalJson(text) {
  try { return JSON.stringify(JSON.parse(text)); } catch { return null; }
}

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function base64ToUtf8(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function makeRunId() {
  return `po-${new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "Z")}-${Math.random().toString(36).slice(2, 10)}`;
}

function coordinatesKey(config) {
  return [config.owner, config.repo, config.branch, config.path].join("/");
}

function isMissingRuntimeError(error) {
  return Number(error?.status) === 404 || /HTTP 404|runtime.*not found|not found/i.test(String(error?.message || error || ""));
}

function normalizeTabId(tabId) {
  const value = Number(tabId);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("A valid ChatGPT tab ID is required");
  return value;
}

function isChatGptUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === "chatgpt.com" || host === "chat.openai.com";
  } catch { return false; }
}
