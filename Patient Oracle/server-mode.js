import { DEFAULT_CONFIG, DEFAULT_STATE, configKey, responsePath, stateKey, streamKey } from "./control.js";

export const SERVER_CONFIG_KEY = "patientOracleServerConfig";
export const SERVER_STATE_KEY = "patientOracleServerState";
export const SERVER_ALARM = "patient-oracle-server-watchdog";
const SERVER_URL = "https://chatgpt.com/?patient-oracle-server=1";
const WATCHDOG_MINUTES = 1;
let ensurePromise = null;

void initializeServerMode();

chrome.runtime.onStartup.addListener(() => { void ensureServerWorker("chrome_startup"); });
chrome.runtime.onInstalled.addListener(() => { void initializeServerMode(); });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === SERVER_ALARM) void ensureServerWorker("watchdog");
});
chrome.tabs.onRemoved.addListener((tabId) => { void handleWorkerTabRemoved(tabId); });
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[SERVER_CONFIG_KEY]) void ensureServerWorker("server_config_changed");
  void mirrorWorkerStateChanges(changes);
});

async function initializeServerMode() {
  await chrome.alarms.create(SERVER_ALARM, { periodInMinutes: WATCHDOG_MINUTES });
  return ensureServerWorker("initialize");
}

export async function ensureServerWorker(trigger = "manual") {
  if (ensurePromise) return ensurePromise;
  ensurePromise = ensureServerWorkerInternal(trigger).finally(() => { ensurePromise = null; });
  return ensurePromise;
}

async function ensureServerWorkerInternal(trigger) {
  const server = await loadServerConfig();
  if (!server.enabled) return { action: "disabled", trigger };
  validateConfig(server.config);

  let tab = await getWorkerTab(server.workerTabId);
  const oldWorkerTabId = server.workerTabId;
  let created = false;
  if (!tab) {
    tab = await chrome.tabs.create({ url: SERVER_URL, active: false, pinned: true });
    created = true;
    await waitForTabComplete(tab.id, 30000);
  }
  await chrome.tabs.update(tab.id, { pinned: true, autoDiscardable: false });

  const nextServer = { ...server, workerTabId: tab.id, updatedAt: new Date().toISOString() };
  if (oldWorkerTabId !== tab.id) await chrome.storage.local.set({ [SERVER_CONFIG_KEY]: nextServer });
  await chrome.storage.local.set({ [configKey(tab.id)]: nextServer.config });

  const stored = await chrome.storage.local.get([stateKey(tab.id), SERVER_STATE_KEY]);
  let currentState = stored[stateKey(tab.id)] || null;
  const snapshot = normalizeServerSnapshot(stored[SERVER_STATE_KEY]);

  if (!currentState) {
    let previous = snapshot?.state || null;
    if (previous?.enabled) previous = await recoverInterruptedReadyRevision(nextServer.config, previous);
    currentState = restoreState(previous, nextServer.config);
    await chrome.storage.local.set({ [stateKey(tab.id)]: currentState });
  }

  await ensureContentScripts(tab.id);
  await saveServerSnapshot(tab.id, currentState);
  return { action: created ? "created_worker" : "worker_ready", tabId: tab.id, trigger };
}

async function handleWorkerTabRemoved(tabId) {
  const server = await loadServerConfig();
  if (!server.enabled || Number(server.workerTabId) !== Number(tabId)) return;
  await chrome.storage.local.set({
    [SERVER_CONFIG_KEY]: { ...server, workerTabId: null, updatedAt: new Date().toISOString() }
  });
  setTimeout(() => { void ensureServerWorker("worker_tab_closed"); }, 500);
}

async function mirrorWorkerStateChanges(changes) {
  const server = await loadServerConfig();
  if (!server.enabled || !Number.isSafeInteger(server.workerTabId)) return;
  const stateChange = changes[stateKey(server.workerTabId)];
  if (stateChange?.newValue) await saveServerSnapshot(server.workerTabId, stateChange.newValue);
  const configChange = changes[configKey(server.workerTabId)];
  if (configChange?.newValue) {
    const config = normalizeConfig(configChange.newValue);
    await chrome.storage.local.set({
      [SERVER_CONFIG_KEY]: { ...server, config, updatedAt: new Date().toISOString() }
    });
  }
}

async function saveServerSnapshot(tabId, state) {
  await chrome.storage.local.set({
    [SERVER_STATE_KEY]: {
      version: 1,
      workerTabId: tabId,
      savedAt: new Date().toISOString(),
      state: sanitizeState(state)
    }
  });
}

function sanitizeState(value) {
  const state = { ...DEFAULT_STATE, ...(value || {}) };
  return {
    enabled: Boolean(state.enabled),
    streamKey: state.streamKey || null,
    lastRunId: state.lastRunId || null,
    lastRevision: Number.isSafeInteger(Number(state.lastRevision)) ? Number(state.lastRevision) : -1,
    lastDispatchedRevision: Number.isSafeInteger(Number(state.lastDispatchedRevision)) ? Number(state.lastDispatchedRevision) : -1,
    currentRequestId: state.currentRequestId || null,
    requestDispatchCount: Number(state.requestDispatchCount || 0),
    lastStatus: state.lastStatus || null,
    lastReason: state.lastReason || null,
    lastCheckedAt: state.lastCheckedAt || null,
    lastDispatchAt: state.lastDispatchAt || null,
    lastFinishedAt: state.lastFinishedAt || null,
    stopReason: state.stopReason || null,
    lastError: state.lastError || null
  };
}

function restoreState(previous, config) {
  const old = sanitizeState(previous || { enabled: true });
  return {
    ...DEFAULT_STATE,
    enabled: old.enabled,
    streamKey: streamKey(config),
    lastRunId: old.lastRunId,
    lastRevision: old.lastRevision,
    lastDispatchedRevision: old.lastDispatchedRevision,
    currentRequestId: old.currentRequestId,
    requestDispatchCount: old.requestDispatchCount,
    lastStatus: old.lastStatus,
    lastReason: old.lastReason,
    lastCheckedAt: old.lastCheckedAt,
    lastDispatchAt: old.lastDispatchAt,
    lastFinishedAt: old.lastFinishedAt,
    stopReason: old.enabled ? null : old.stopReason,
    lastError: old.enabled ? null : old.lastError,
    dispatching: false,
    executing: false,
    finalizing: false,
    executionToken: null,
    expectedResponseFilename: null,
    executionStartedAt: null,
    checkpointAt: null,
    executionHardStopAt: null
  };
}

async function recoverInterruptedReadyRevision(config, previous) {
  if (!previous.lastRunId || Number(previous.lastDispatchedRevision) < 0) return previous;
  const runtimeFile = await getGitHubRuntimeFile(config);
  const runtime = parseRuntime(runtimeFile.text);
  if (runtime.run_id !== previous.lastRunId || runtime.status !== "ready") return previous;
  const dispatched = Number(previous.lastDispatchedRevision);
  if (runtime.revision < dispatched) {
    return { ...previous, enabled: false, stopReason: "revision_regressed", lastError: `Patient Oracle revision regressed from ${dispatched} to ${runtime.revision}` };
  }
  if (runtime.revision > dispatched) return { ...previous, lastRevision: runtime.revision, lastStatus: runtime.status, lastReason: runtime.reason || null };
  if (String(runtime.request_id || "") !== String(previous.currentRequestId || "")) return previous;

  const durableResponseFile = await getGitHubFile(config, responsePath(runtime.request_id), true);
  if (durableResponseFile) {
    const response = parseDurableResponse(durableResponseFile.text, runtime.request_id);
    const terminal = {
      version: 1,
      run_id: runtime.run_id,
      revision: runtime.revision + 1,
      status: response.status,
      request_id: runtime.request_id,
      reason: response.status === "complete" ? "server recovery found durable response artifact" : response.reason,
      updated_at: new Date().toISOString()
    };
    await putGitHubRuntimeFile(config, runtimeFile.sha, terminal);
    const verifiedTerminal = parseRuntime((await getGitHubRuntimeFile(config)).text);
    if (verifiedTerminal.revision !== terminal.revision || verifiedTerminal.status !== terminal.status || verifiedTerminal.request_id !== terminal.request_id) {
      throw new Error("Patient Oracle could not verify terminal recovery from durable response");
    }
    return { ...previous, lastRevision: terminal.revision, lastStatus: terminal.status, lastReason: terminal.reason, lastError: null };
  }

  const next = {
    version: 1,
    run_id: runtime.run_id,
    revision: runtime.revision + 1,
    status: "ready",
    request_id: runtime.request_id,
    reason: "server recovery after browser or worker-tab interruption",
    updated_at: new Date().toISOString()
  };
  await putGitHubRuntimeFile(config, runtimeFile.sha, next);
  const verified = parseRuntime((await getGitHubRuntimeFile(config)).text);
  if (verified.run_id !== next.run_id || verified.revision !== next.revision || verified.status !== "ready" || verified.request_id !== next.request_id) {
    throw new Error("Patient Oracle could not verify the server recovery revision");
  }
  return { ...previous, lastRevision: next.revision, lastStatus: "ready", lastReason: next.reason, lastError: null };
}

async function ensureContentScripts(tabId) {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: "PATIENT_ORACLE_PING" });
    if (!ping?.ready) throw new Error("content script ping failed");
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js", "artifact-preview-v2.js"] });
  }
}

async function getWorkerTab(tabId) {
  if (tabId === null || tabId === undefined || !Number.isSafeInteger(Number(tabId))) return null;
  try {
    const tab = await chrome.tabs.get(Number(tabId));
    return isChatGptUrl(tab.url || "") ? tab : null;
  } catch {
    return null;
  }
}

async function loadServerConfig() {
  const stored = await chrome.storage.local.get(SERVER_CONFIG_KEY);
  return normalizeServerConfig(stored[SERVER_CONFIG_KEY]);
}

function normalizeServerConfig(value) {
  const config = normalizeConfig(value?.config || {});
  return {
    version: 1,
    enabled: Boolean(value?.enabled),
    workerTabId: value?.workerTabId !== null && value?.workerTabId !== undefined && Number.isSafeInteger(Number(value.workerTabId)) ? Number(value.workerTabId) : null,
    config,
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : null
  };
}

function normalizeServerSnapshot(value) {
  if (!value || value.version !== 1 || !value.state) return null;
  return { version: 1, workerTabId: Number(value.workerTabId), savedAt: value.savedAt || null, state: sanitizeState(value.state) };
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
    maxRedispatchesPerRequest: Math.min(20, Math.max(1, Math.floor(Number(value?.maxRedispatchesPerRequest) || DEFAULT_CONFIG.maxRedispatchesPerRequest)))
  };
}

function validateConfig(config) {
  if (!config.owner || !config.repo) throw new Error("Patient Oracle Server Mode requires GitHub owner and repository");
  if (!config.githubToken) throw new Error("Patient Oracle Server Mode requires a GitHub token");
  if (/[^\x21-\x7E]/.test(config.githubToken)) throw new Error("Patient Oracle Server Mode GitHub token must be the actual ASCII token value");
}

async function getGitHubFile(config, path, allow404 = false) {
  const response = await fetch(contentsUrl(config, path, true), { method: "GET", headers: githubHeaders(config.githubToken), cache: "no-store" });
  if (response.status === 404 && allow404) return null;
  if (!response.ok) throw new Error(`Patient Oracle server recovery could not read ${path}: HTTP ${response.status}`);
  const body = await response.json();
  if (body?.type !== "file" || typeof body.content !== "string") throw new Error(`Patient Oracle server recovery ${path} did not resolve to a file`);
  return { sha: body.sha || null, text: base64ToUtf8(body.content.replace(/\n/g, "")) };
}

function parseDurableResponse(text, requestId) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("Patient Oracle durable response is not valid JSON"); }
  if (!value || value.version !== 1 || value.request_id !== requestId || !["complete", "needs_user", "blocked"].includes(value.status)) throw new Error("Patient Oracle durable response identity or status is invalid");
  if (value.status === "complete" && !String(value.answer || "").trim()) throw new Error("Patient Oracle durable complete response requires answer");
  if (value.status !== "complete" && !String(value.reason || "").trim()) throw new Error(`Patient Oracle durable ${value.status} response requires reason`);
  return value;
}

function contentsUrl(config, path, includeRef) {
  const encoded = String(path).split("/").map(encodeURIComponent).join("/");
  const url = new URL(`https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${encoded}`);
  if (includeRef) url.searchParams.set("ref", config.branch);
  return url.toString();
}

async function getGitHubRuntimeFile(config) {
  const response = await fetch(runtimeUrl(config, true), { method: "GET", headers: githubHeaders(config.githubToken), cache: "no-store" });
  if (!response.ok) throw new Error(`Patient Oracle server recovery could not read runtime: HTTP ${response.status}`);
  const body = await response.json();
  if (body?.type !== "file" || typeof body.content !== "string" || typeof body.sha !== "string") throw new Error("Patient Oracle server recovery runtime did not resolve to a file");
  return { sha: body.sha, text: base64ToUtf8(body.content.replace(/\n/g, "")) };
}

async function putGitHubRuntimeFile(config, sha, runtime) {
  const body = {
    message: `patient-oracle: server recover ${runtime.request_id}`,
    branch: config.branch,
    content: utf8ToBase64(`${JSON.stringify(runtime, null, 2)}\n`),
    sha
  };
  const response = await fetch(runtimeUrl(config, false), {
    method: "PUT",
    headers: { ...githubHeaders(config.githubToken), "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Patient Oracle server recovery could not update runtime: HTTP ${response.status}`);
}

function runtimeUrl(config, includeRef) {
  const path = String(config.path || DEFAULT_CONFIG.path).split("/").map(encodeURIComponent).join("/");
  const url = new URL(`https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${path}`);
  if (includeRef) url.searchParams.set("ref", config.branch);
  return url.toString();
}

function githubHeaders(token) {
  return { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" };
}

function parseRuntime(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("Patient Oracle server recovery runtime is not valid JSON"); }
  if (!value || value.version !== 1 || typeof value.run_id !== "string" || !Number.isSafeInteger(value.revision) || value.revision < 0 || !["ready", "complete", "needs_user", "blocked"].includes(value.status)) throw new Error("Patient Oracle server recovery runtime is invalid");
  if (value.status === "ready" && !String(value.request_id || "").trim()) throw new Error("Patient Oracle server recovery ready runtime requires request_id");
  return value;
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

function isChatGptUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === "chatgpt.com" || host === "chat.openai.com";
  } catch {
    return false;
  }
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
      reject(new Error("Timed out creating Patient Oracle server worker tab"));
    }, timeoutMs);
  });
}
