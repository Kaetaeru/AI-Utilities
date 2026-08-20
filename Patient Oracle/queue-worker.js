import { DEFAULT_CONFIG, stateKey } from "./control.js";
import { ORACLE_QUEUE_PATH, parseQueuePayload, removeQueueItem } from "./queue-protocol.js";

const SERVER_CONFIG_KEY = "patientOracleServerConfig";
const USER_INTENT_KEY = "patientOracleUserIntent";
const QUEUE_ALARM = "patient-oracle-queue-watchdog";
const QUEUE_WATCHDOG_MINUTES = 1;
const MAX_STALE_HEAD_SKIPS = 20;
let drainPromise = null;

void initializeQueueWorker();
chrome.runtime.onStartup.addListener(() => { setTimeout(() => { void drainQueue("chrome_startup"); }, 1500); });
chrome.runtime.onInstalled.addListener(() => { void initializeQueueWorker(); });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === QUEUE_ALARM) void drainQueue("queue_watchdog");
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[SERVER_CONFIG_KEY]?.newValue?.enabled) setTimeout(() => { void drainQueue("server_config_enabled"); }, 750);
  for (const [key, change] of Object.entries(changes)) {
    if (!key.startsWith("patientOracleState:")) continue;
    const state = change.newValue;
    if (!state?.enabled || state.dispatching || state.executing || state.finalizing) continue;
    if (["complete", "needs_user", "blocked", "ready", "waiting_for_dispatch_retry"].includes(String(state.lastStatus || ""))) {
      setTimeout(() => { void drainQueue("worker_state_idle"); }, 100);
    }
  }
});

async function initializeQueueWorker() {
  await chrome.alarms.create(QUEUE_ALARM, { periodInMinutes: QUEUE_WATCHDOG_MINUTES });
  setTimeout(() => { void drainQueue("initialize"); }, 1500);
}

export async function drainQueue(trigger = "manual") {
  if (drainPromise) return drainPromise;
  drainPromise = drainQueueInternal(trigger).finally(() => { drainPromise = null; });
  return drainPromise;
}

async function drainQueueInternal(trigger) {
  const stored = await chrome.storage.local.get([SERVER_CONFIG_KEY, USER_INTENT_KEY]);
  const server = normalizeServerConfig(stored[SERVER_CONFIG_KEY]);
  const intentStarted = Boolean(stored[USER_INTENT_KEY]?.started);
  if (!server.enabled) return { action: "disabled", trigger };
  if (!intentStarted) return { action: "user_stopped", trigger };
  validateConfig(server.config);

  let runtimeFile = await getGitHubFile(server.config, server.config.path);
  let runtime = parseRuntime(runtimeFile.text);

  if (runtime.status === "ready") {
    const queueFile = await getGitHubFile(server.config, ORACLE_QUEUE_PATH, true);
    if (!queueFile) return { action: "active", requestId: runtime.request_id, trigger };
    const queue = parseQueuePayload(queueFile.text);
    if (queue.items[0]?.request_id === runtime.request_id) {
      await removeQueuedRequest(server.config, runtime.request_id);
      return { action: "cleaned_active_head", requestId: runtime.request_id, trigger };
    }
    return { action: "active", requestId: runtime.request_id, trigger };
  }

  for (let skipped = 0; skipped < MAX_STALE_HEAD_SKIPS; skipped += 1) {
    const queueFile = await getGitHubFile(server.config, ORACLE_QUEUE_PATH, true);
    if (!queueFile) return { action: "queue_empty", trigger };
    const queue = parseQueuePayload(queueFile.text);
    const head = queue.items[0];
    if (!head) return { action: "queue_empty", trigger };

    const responseFile = await getGitHubFile(server.config, responsePath(head.request_id), true);
    if (responseFile) {
      await removeQueuedRequest(server.config, head.request_id);
      continue;
    }

    const requestFile = await getGitHubFile(server.config, requestPath(head.request_id), true);
    if (!requestFile) {
      await recordWorkerError(server.workerTabId, `Queue head ${head.request_id} has no durable request file; leaving it queued for manual repair.`);
      return { action: "blocked_missing_request", requestId: head.request_id, trigger };
    }

    runtimeFile = await getGitHubFile(server.config, server.config.path);
    runtime = parseRuntime(runtimeFile.text);
    if (runtime.status === "ready") return { action: "active", requestId: runtime.request_id, trigger };

    const nextRuntime = {
      version: 1,
      run_id: runtime.run_id,
      revision: runtime.revision + 1,
      status: "ready",
      request_id: head.request_id,
      reason: "activated from Patient Oracle FIFO queue",
      updated_at: new Date().toISOString()
    };

    try {
      await putGitHubJson(server.config, server.config.path, nextRuntime, `patient-oracle: activate ${head.request_id}`, runtimeFile.sha);
    } catch (error) {
      if (isConflict(error)) return { action: "runtime_raced", requestId: head.request_id, trigger };
      throw error;
    }

    const cleanup = await removeQueuedRequest(server.config, head.request_id);
    await recordWorkerError(server.workerTabId, null);
    return {
      action: "activated",
      requestId: head.request_id,
      revision: nextRuntime.revision,
      queueCleanupPending: !cleanup.removed,
      trigger
    };
  }

  return { action: "wait", reason: "too_many_stale_queue_heads", trigger };
}

async function removeQueuedRequest(config, requestId) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const file = await getGitHubFile(config, ORACLE_QUEUE_PATH, true);
    if (!file) return { removed: false, reason: "queue_missing" };
    const queue = parseQueuePayload(file.text);
    const result = removeQueueItem(queue, requestId);
    if (!result.removed) return { removed: false, reason: "not_queued" };
    try {
      await putGitHubJson(config, ORACLE_QUEUE_PATH, result.queue, `patient-oracle: dequeue ${requestId}`, file.sha);
      return { removed: true };
    } catch (error) {
      if (!isConflict(error)) throw error;
      await sleep(80 + attempt * 40);
    }
  }
  return { removed: false, reason: "queue_conflict" };
}

async function recordWorkerError(tabId, message) {
  if (!Number.isSafeInteger(Number(tabId))) return;
  const key = stateKey(Number(tabId));
  const stored = await chrome.storage.local.get(key);
  const current = stored[key];
  if (!current) return;
  await chrome.storage.local.set({ [key]: { ...current, lastError: message, ...(message ? { lastStatus: "needs_user", lastReason: message } : {}) } });
}

async function getGitHubFile(config, path, allow404 = false) {
  const response = await fetch(contentsUrl(config, path, true), { method: "GET", headers: githubHeaders(config.githubToken), cache: "no-store" });
  if (response.status === 404 && allow404) return null;
  if (!response.ok) throw await githubError(response, `read ${path}`);
  const body = await response.json();
  if (body?.type !== "file" || typeof body.content !== "string" || typeof body.sha !== "string") throw new Error(`${path} did not resolve to a GitHub file`);
  return { sha: body.sha, text: base64ToUtf8(body.content.replace(/\n/g, "")) };
}

async function putGitHubJson(config, path, value, message, sha = null) {
  const body = { message, branch: config.branch, content: utf8ToBase64(`${JSON.stringify(value, null, 2)}\n`) };
  if (sha) body.sha = sha;
  const response = await fetch(contentsUrl(config, path, false), {
    method: "PUT",
    headers: { ...githubHeaders(config.githubToken), "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw await githubError(response, `write ${path}`);
}

function parseRuntime(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("Patient Oracle queue worker runtime is not valid JSON"); }
  if (!value || value.version !== 1 || typeof value.run_id !== "string" || !Number.isSafeInteger(value.revision) || value.revision < 0 || !["ready", "complete", "needs_user", "blocked"].includes(value.status)) throw new Error("Patient Oracle queue worker runtime is invalid");
  if (value.status === "ready" && !String(value.request_id || "").trim()) throw new Error("Patient Oracle queue worker ready runtime requires request_id");
  return value;
}

function normalizeServerConfig(value) {
  const raw = value?.config || {};
  const config = {
    owner: String(raw.owner || "").trim(),
    repo: String(raw.repo || "").trim(),
    branch: String(raw.branch || "main").trim() || "main",
    githubToken: String(raw.githubToken || "").trim(),
    path: String(raw.path || DEFAULT_CONFIG.path).replace(/^\/+/, "").trim() || DEFAULT_CONFIG.path
  };
  const tabId = Number(value?.workerTabId);
  return { enabled: Boolean(value?.enabled), workerTabId: Number.isSafeInteger(tabId) ? tabId : null, config };
}

function validateConfig(config) {
  if (!config.owner || !config.repo || !config.githubToken) throw new Error("Patient Oracle FIFO queue requires configured Server Mode GitHub access");
  if (/[^\x21-\x7E]/.test(config.githubToken)) throw new Error("Patient Oracle FIFO queue GitHub token must be the actual ASCII token value");
}

function contentsUrl(config, path, includeRef) {
  const encoded = String(path).split("/").map(encodeURIComponent).join("/");
  const url = new URL(`https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${encoded}`);
  if (includeRef) url.searchParams.set("ref", config.branch);
  return url.toString();
}

function githubHeaders(token) {
  return { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" };
}

async function githubError(response, action) {
  let detail = "";
  try { const body = await response.json(); detail = body?.message ? `: ${body.message}` : ""; } catch {}
  const error = new Error(`GitHub ${action} failed with HTTP ${response.status}${detail}`);
  error.status = response.status;
  return error;
}

function requestPath(requestId) { return `.patient-oracle/requests/${normalizeId(requestId)}.json`; }
function responsePath(requestId) { return `.patient-oracle/responses/${normalizeId(requestId)}.json`; }
function normalizeId(value) { const id = String(value || "").trim(); if (!id || id.includes("/") || id.includes("..") || !/^[A-Za-z0-9._-]+$/.test(id)) throw new Error("invalid request id"); return id; }
function isConflict(error) { return [409, 422].includes(Number(error?.status)); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function utf8ToBase64(text) { const bytes = new TextEncoder().encode(text); let binary = ""; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(binary); }
function base64ToUtf8(base64) { const binary = atob(base64); const bytes = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i); return new TextDecoder().decode(bytes); }
