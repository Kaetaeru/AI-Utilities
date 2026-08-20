import {
  DEFAULT_LIVE_CONFIG,
  LIVE_ACTIVE_STATUSES,
  LIVE_CONFIG_KEY,
  buildLiveWorkerPrompt,
  countActiveJobs,
  createLiveJob,
  normalizeLiveConfig,
  normalizeLiveJobId,
  parseLiveResponseArtifact,
  publicLiveJob
} from "./live-control.js";
import { getLiveJob, listLiveJobs, pruneLiveJobs, putLiveJob } from "./live-store.js";

const MAX_RESPONSE_ARTIFACT_BYTES = 8 * 1024 * 1024;
const CHATGPT_URL = "https://chatgpt.com/";
const LIVE_MESSAGE_TYPES = new Set([
  "PATIENT_ORACLE_LIVE_STATUS",
  "PATIENT_ORACLE_LIVE_SET_CONFIG",
  "PATIENT_ORACLE_LIVE_START",
  "PATIENT_ORACLE_LIVE_GET",
  "PATIENT_ORACLE_LIVE_CANCEL",
  "PATIENT_ORACLE_LIVE_EVENT"
]);

let config = DEFAULT_LIVE_CONFIG;
let jobs = new Map();
let allocationChain = Promise.resolve();
const initialization = initialize();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!LIVE_MESSAGE_TYPES.has(String(message?.type || ""))) return;
  Promise.resolve(handleLiveMessage(message, sender))
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void initialization.then(() => handleWorkerTabRemoved(tabId)).catch(() => {});
});

async function initialize() {
  const stored = await chrome.storage.local.get(LIVE_CONFIG_KEY);
  config = normalizeLiveConfig(stored[LIVE_CONFIG_KEY] || DEFAULT_LIVE_CONFIG);
  const restored = await listLiveJobs();
  jobs = new Map(restored.map((job) => [job.jobId, job]));
  for (const job of restored) {
    if (!LIVE_ACTIVE_STATUSES.has(job.status)) continue;
    if (!Number.isSafeInteger(Number(job.tabId))) {
      await failJob(job, "interrupted_before_worker_tab_assignment");
      continue;
    }
    try {
      await chrome.tabs.get(Number(job.tabId));
    } catch {
      await failJob(job, "worker_tab_missing_after_recovery");
    }
  }
}

async function handleLiveMessage(message, sender) {
  await initialization;
  if (message.type === "PATIENT_ORACLE_LIVE_STATUS") return liveStatus();
  if (message.type === "PATIENT_ORACLE_LIVE_SET_CONFIG") return setLiveConfig(message.config);
  if (message.type === "PATIENT_ORACLE_LIVE_START") return withAllocationLock(() => startLiveJob(message));
  if (message.type === "PATIENT_ORACLE_LIVE_GET") return getLiveResult(message.jobId);
  if (message.type === "PATIENT_ORACLE_LIVE_CANCEL") return cancelLiveJob(message.jobId);
  if (message.type === "PATIENT_ORACLE_LIVE_EVENT") return handleLiveEvent(message, sender);
  throw new Error(`Unsupported Patient Oracle live message: ${String(message.type || "")}`);
}

async function liveStatus() {
  const recent = Array.from(jobs.values())
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
    .slice(0, 20)
    .map((job) => publicLiveJob(job));
  return {
    config,
    active_workers: countActiveJobs(jobs.values()),
    jobs: recent
  };
}

async function setLiveConfig(raw) {
  config = normalizeLiveConfig({ ...config, ...(raw || {}) });
  await chrome.storage.local.set({ [LIVE_CONFIG_KEY]: config });
  return { config };
}

async function startLiveJob(message) {
  if (!config.enabled) return { status: "disabled", config };
  const active = countActiveJobs(jobs.values());
  if (active >= config.maxWorkers) {
    return { status: "busy", active_workers: active, max_workers: config.maxWorkers };
  }

  const jobId = message.jobId ? normalizeLiveJobId(message.jobId) : makeJobId();
  if (jobs.has(jobId) || await getLiveJob(jobId)) throw new Error(`Patient Oracle job already exists: ${jobId}`);
  const job = createLiveJob({
    jobId,
    prompt: message.prompt,
    responseFormat: message.responseFormat,
    origin: message.origin || "extension",
    parentJobId: message.parentJobId || null,
    delegationDepth: message.delegationDepth || 0
  });
  jobs.set(job.jobId, job);
  await putLiveJob(job);

  try {
    const tab = await chrome.tabs.create({ url: CHATGPT_URL, active: false });
    if (!Number.isSafeInteger(Number(tab.id))) throw new Error("Chrome did not assign a worker tab ID");
    job.tabId = Number(tab.id);
    job.phase = "loading_chatgpt";
    await saveJob(job);
    await waitForTabComplete(job.tabId, 25000);
    await ensureLiveContentScript(job.tabId);

    const worker = buildLiveWorkerPrompt(job);
    job.executionToken = makeExecutionToken(job.jobId);
    job.phase = "dispatching";
    job.startedAt = worker.budget.startedAt;
    await saveJob(job);

    const response = await chrome.tabs.sendMessage(job.tabId, {
      type: "PATIENT_ORACLE_LIVE_PROMPT",
      jobId: job.jobId,
      prompt: worker.prompt,
      executionToken: job.executionToken,
      responseFilename: worker.filename,
      checkpointAt: worker.budget.checkpointAt,
      hardStopAt: worker.budget.hardStopAt
    });
    if (!response?.sent) throw new Error(response?.error || "Patient Oracle live prompt was not dispatched");

    job.status = "running";
    job.phase = "executing";
    await saveJob(job);
    return { status: "running", job: publicLiveJob(job) };
  } catch (error) {
    await failJob(job, error instanceof Error ? error.message : String(error));
    await closeWorkerTab(job);
    throw error;
  }
}

async function getLiveResult(jobId) {
  const id = normalizeLiveJobId(jobId);
  const job = jobs.get(id) || await getLiveJob(id);
  if (!job) return { status: "not_found", job_id: id };
  jobs.set(id, job);
  return { status: job.status, job: publicLiveJob(job, { includeResult: true }) };
}

async function cancelLiveJob(jobId) {
  const id = normalizeLiveJobId(jobId);
  const job = jobs.get(id) || await getLiveJob(id);
  if (!job) return { status: "not_found", job_id: id };
  jobs.set(id, job);
  if (!LIVE_ACTIVE_STATUSES.has(job.status)) return { status: job.status, job: publicLiveJob(job, { includeResult: true }) };
  job.status = "cancelled";
  job.phase = "terminal";
  job.finishedAt = new Date().toISOString();
  job.reason = "cancelled by caller";
  await saveJob(job);
  await closeWorkerTab(job);
  await pruneLiveJobs();
  return { status: "cancelled", job: publicLiveJob(job) };
}

async function handleLiveEvent(message, sender) {
  const jobId = normalizeLiveJobId(message.jobId);
  const job = jobs.get(jobId) || await getLiveJob(jobId);
  if (!job) return { accepted: false, reason: "unknown_job" };
  jobs.set(job.jobId, job);
  const event = message.event || {};
  const senderTabId = Number(sender?.tab?.id);
  if (!LIVE_ACTIVE_STATUSES.has(job.status)) return { accepted: false, reason: "terminal_job" };
  if (!Number.isSafeInteger(senderTabId) || senderTabId !== Number(job.tabId)) return { accepted: false, reason: "wrong_tab" };
  if (!job.executionToken || String(event.executionToken || "") !== job.executionToken) return { accepted: false, reason: "stale_execution_token" };

  if (event.type === "PATIENT_ORACLE_RESPONSE_ARTIFACT" || event.type === "PATIENT_ORACLE_RESPONSE_ARTIFACT_URL") {
    const text = event.type === "PATIENT_ORACLE_RESPONSE_ARTIFACT" ? String(event.text || "") : await fetchGeneratedArtifactUrl(event.url);
    await finalizeArtifact(job, event.filename, text);
    return { accepted: true, terminal: true };
  }
  if (event.type === "PATIENT_ORACLE_CHECKPOINT_DUE") {
    job.phase = "checkpoint_due";
    await saveJob(job);
    return { accepted: true };
  }
  if (event.type === "PATIENT_ORACLE_HARD_STOP") {
    job.status = "timed_out";
    job.phase = "terminal";
    job.finishedAt = new Date().toISOString();
    job.reason = "20-minute hard stop reached before a valid result artifact";
    await saveJob(job);
    await closeWorkerTab(job);
    await pruneLiveJobs();
    return { accepted: true, terminal: true };
  }
  if (event.type === "PATIENT_ORACLE_TURN_IDLE") {
    job.status = "waiting_for_response_file";
    job.phase = "waiting_for_response_file";
    await saveJob(job);
    return { accepted: true };
  }
  if (event.type === "PATIENT_ORACLE_ARTIFACT_ERROR") {
    job.lastError = String(event.error || "Could not read generated response artifact");
    job.phase = "waiting_for_response_file";
    await saveJob(job);
    return { accepted: true };
  }
  return { accepted: false, reason: "unsupported_event" };
}

async function finalizeArtifact(job, filename, text) {
  if (String(filename || "") !== job.responseFilename) throw new Error(`Unexpected Patient Oracle live response filename: ${String(filename || "")}`);
  const bytes = new TextEncoder().encode(String(text || "")).byteLength;
  if (!text || bytes > MAX_RESPONSE_ARTIFACT_BYTES) throw new Error("Patient Oracle live response artifact is empty or exceeds 8 MiB");
  const artifact = parseLiveResponseArtifact(text, job.jobId);
  job.status = artifact.status;
  job.phase = "terminal";
  job.contentType = artifact.contentType;
  job.answer = artifact.answer || null;
  job.reason = artifact.reason || null;
  job.metadata = artifact.metadata || null;
  job.finishedAt = artifact.completedAt || new Date().toISOString();
  job.lastError = null;
  await saveJob(job);
  if (config.closeTabsOnTerminal) await closeWorkerTab(job);
  await pruneLiveJobs();
}

async function handleWorkerTabRemoved(tabId) {
  const job = Array.from(jobs.values()).find((candidate) => Number(candidate.tabId) === Number(tabId) && LIVE_ACTIVE_STATUSES.has(candidate.status));
  if (!job) return;
  await failJob(job, "worker tab closed before job completion");
}

async function failJob(job, message) {
  job.status = "failed";
  job.phase = "terminal";
  job.finishedAt = new Date().toISOString();
  job.lastError = String(message || "Patient Oracle live worker failed");
  await saveJob(job);
  await pruneLiveJobs();
}

async function saveJob(job) {
  jobs.set(job.jobId, job);
  await putLiveJob(job);
  return job;
}

async function closeWorkerTab(job) {
  const tabId = Number(job.tabId);
  if (!Number.isSafeInteger(tabId)) return;
  try { await chrome.tabs.remove(tabId); } catch {}
}

async function ensureLiveContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: "PATIENT_ORACLE_LIVE_PING" });
    if (pong?.ready) return;
  } catch {}
  await chrome.scripting.executeScript({ target: { tabId }, files: ["live-content.js", "live-artifact-preview.js"] });
  const pong = await chrome.tabs.sendMessage(tabId, { type: "PATIENT_ORACLE_LIVE_PING" });
  if (!pong?.ready) throw new Error("Patient Oracle live content worker did not become ready");
}

async function waitForTabComplete(tabId, timeoutMs) {
  const existing = await chrome.tabs.get(tabId);
  if (existing.status === "complete") return;
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      if (error) reject(error); else resolve();
    };
    const onUpdated = (changedId, info) => { if (changedId === tabId && info.status === "complete") finish(); };
    const onRemoved = (removedId) => { if (removedId === tabId) finish(new Error("Patient Oracle live worker tab closed while loading")); };
    const timer = setTimeout(() => finish(new Error("Timed out waiting for Patient Oracle live worker tab")), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

async function fetchGeneratedArtifactUrl(url) {
  const target = String(url || "");
  if (!/^https?:/i.test(target)) throw new Error("Patient Oracle live artifact URL is not fetchable");
  const response = await fetch(target, { method: "GET", credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error(`Patient Oracle live artifact fetch failed with HTTP ${response.status}`);
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_ARTIFACT_BYTES) throw new Error("Patient Oracle live artifact exceeds 8 MiB");
  return text;
}

function withAllocationLock(fn) {
  const next = allocationChain.then(fn, fn);
  allocationChain = next.then(() => undefined, () => undefined);
  return next;
}

function makeJobId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `PO-${Date.now().toString(36)}-${suffix}`;
}

function makeExecutionToken(jobId) {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `live:${jobId}:${Date.now()}:${suffix}`;
}
