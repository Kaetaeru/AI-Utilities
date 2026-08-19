import { DEFAULT_CONFIG, DEFAULT_STATE } from "./control.js";

const port = chrome.runtime.connect({ name: "patient-oracle-panel" });
let counter = 0;
const pending = new Map();
const tab = await getActiveChatGptTab();
const ui = Object.fromEntries(["owner","repo","branch","token","path","poll","max","status","request","revision","dispatches","checkpoint","hardstop","error","save","toggle"].map((id) => [id, document.getElementById(id)]));

port.onMessage.addListener((message) => {
  const entry = pending.get(String(message?.requestId || ""));
  if (!entry) return;
  pending.delete(message.requestId);
  clearTimeout(entry.timer);
  if (message.ok) entry.resolve(message);
  else entry.reject(new Error(message.error || "Patient Oracle request failed"));
});

ui.save.addEventListener("click", () => run(save));
ui.toggle.addEventListener("click", () => run(toggle));
await load();
setInterval(refresh, 1000);

async function load() {
  const snapshot = await request("PATIENT_ORACLE_STATUS");
  const config = { ...DEFAULT_CONFIG, ...(snapshot.config || {}) };
  ui.owner.value = config.owner;
  ui.repo.value = config.repo;
  ui.branch.value = config.branch;
  ui.token.value = config.githubToken;
  ui.path.value = config.path;
  ui.poll.value = String(config.pollIntervalSeconds);
  ui.max.value = String(config.maxRedispatchesPerRequest);
  render(snapshot.state || DEFAULT_STATE);
}

async function save() {
  const state = (await request("PATIENT_ORACLE_STATUS")).state || DEFAULT_STATE;
  if (state.enabled) throw new Error("Stop Patient Oracle before changing settings");
  await request("PATIENT_ORACLE_SAVE", { config: { owner: ui.owner.value, repo: ui.repo.value, branch: ui.branch.value, githubToken: ui.token.value, path: ui.path.value, pollIntervalSeconds: ui.poll.value, maxRedispatchesPerRequest: ui.max.value } });
  await refresh();
}

async function toggle() {
  const snapshot = await request("PATIENT_ORACLE_STATUS");
  if (snapshot.state?.enabled) {
    await request("PATIENT_ORACLE_STOP");
  } else {
    await save();
    await recoverAlreadyDispatchedReadyRevision();
    const started = await request("PATIENT_ORACLE_START");
    if (started?.reason === "already_dispatched") {
      throw new Error("This ready revision was already dispatched locally. Stop and Start Oracle again to publish a safe higher retry revision.");
    }
  }
  await refresh();
}

async function recoverAlreadyDispatchedReadyRevision() {
  const snapshot = await request("PATIENT_ORACLE_STATUS");
  const config = { ...DEFAULT_CONFIG, ...(snapshot.config || {}) };
  const state = { ...DEFAULT_STATE, ...(snapshot.state || {}) };
  if (!config.githubToken) return;
  validateGitHubToken(config.githubToken);
  if (!state.lastRunId || Number(state.lastDispatchedRevision ?? -1) < 0) return;

  const runtimeFile = await getGitHubRuntimeFile(config);
  const runtime = parseRuntime(runtimeFile.text);
  if (runtime.run_id !== state.lastRunId || runtime.status !== "ready") return;
  const lastDispatchedRevision = Number(state.lastDispatchedRevision ?? -1);
  if (runtime.revision < lastDispatchedRevision) throw new Error(`Patient Oracle revision regressed from ${lastDispatchedRevision} to ${runtime.revision}`);
  if (runtime.revision > lastDispatchedRevision) return;

  const nextRuntime = {
    version: 1,
    run_id: runtime.run_id,
    revision: runtime.revision + 1,
    status: "ready",
    request_id: runtime.request_id,
    reason: "manual retry requested after interrupted local execution",
    updated_at: new Date().toISOString()
  };
  await putGitHubRuntimeFile(config, runtimeFile.sha, nextRuntime);
  const verified = parseRuntime((await getGitHubRuntimeFile(config)).text);
  if (verified.run_id !== nextRuntime.run_id || verified.revision !== nextRuntime.revision || verified.status !== "ready" || verified.request_id !== nextRuntime.request_id) {
    throw new Error("Patient Oracle could not verify the manual retry revision");
  }
}

async function getGitHubRuntimeFile(config) {
  const response = await fetch(githubRuntimeUrl(config, true), { method: "GET", headers: githubHeaders(config.githubToken), cache: "no-store" });
  if (!response.ok) throw await githubError(response, "read runtime for manual retry");
  const body = await response.json();
  if (body?.type !== "file" || typeof body.content !== "string" || typeof body.sha !== "string") throw new Error("Patient Oracle runtime did not resolve to a GitHub file");
  return { sha: body.sha, text: base64ToUtf8(body.content.replace(/\n/g, "")) };
}

async function putGitHubRuntimeFile(config, sha, runtime) {
  const body = {
    message: `patient-oracle: retry ${runtime.request_id}`,
    branch: config.branch,
    content: utf8ToBase64(`${JSON.stringify(runtime, null, 2)}\n`),
    sha
  };
  const response = await fetch(githubRuntimeUrl(config, false), {
    method: "PUT",
    headers: { ...githubHeaders(config.githubToken), "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw await githubError(response, "publish manual retry revision");
}

function githubRuntimeUrl(config, includeRef) {
  const encodedPath = String(config.path || ".patient-oracle/runtime.json").split("/").map(encodeURIComponent).join("/");
  const url = new URL(`https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${encodedPath}`);
  if (includeRef) url.searchParams.set("ref", config.branch || "main");
  return url.toString();
}

function githubHeaders(token) {
  validateGitHubToken(token);
  return { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" };
}

function validateGitHubToken(token) {
  const value = String(token || "").trim();
  if (!value) throw new Error("A GitHub token is required");
  if (/[^\x21-\x7E]/.test(value)) throw new Error("GitHub token must be the actual ASCII token value, not placeholder text");
}

function parseRuntime(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("Patient Oracle runtime is not valid JSON"); }
  if (!value || value.version !== 1 || typeof value.run_id !== "string" || !Number.isSafeInteger(value.revision) || value.revision < 0 || !["ready","complete","needs_user","blocked"].includes(value.status)) throw new Error("Patient Oracle runtime is invalid");
  if (value.status === "ready" && !String(value.request_id || "").trim()) throw new Error("Patient Oracle ready runtime requires request_id");
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

async function githubError(response, action) {
  let detail = "";
  try {
    const body = await response.json();
    detail = body?.message ? `: ${body.message}` : "";
  } catch {}
  return new Error(`GitHub ${action} failed with HTTP ${response.status}${detail}`);
}

async function refresh() { try { const snapshot = await request("PATIENT_ORACLE_STATUS"); render(snapshot.state || DEFAULT_STATE); } catch (error) { showError(error); } }
function render(state) {
  ui.status.textContent = displayStatus(state);
  ui.request.textContent = state.currentRequestId || "-";
  ui.revision.textContent = Number(state.lastRevision) >= 0 ? String(state.lastRevision) : "-";
  ui.dispatches.textContent = String(state.requestDispatchCount || 0);
  ui.checkpoint.textContent = formatTime(state.checkpointAt);
  ui.hardstop.textContent = formatTime(state.executionHardStopAt);
  ui.toggle.textContent = state.enabled ? "Stop Oracle" : "Start Oracle";
  ui.save.disabled = Boolean(state.enabled);
  if (state.lastError) showError(new Error(state.lastError)); else hideError();
}

function displayStatus(state) {
  if (state.dispatching) return "Dispatching";
  if (state.finalizing) return "Finalizing";
  if (state.executing) {
    if (state.lastStatus === "waiting_for_response_file") return "Waiting for response file";
    if (state.lastStatus === "checkpoint_due") return "Checkpoint due";
    if (state.lastStatus === "bootstrapping") return "Bootstrapping";
    return "Executing";
  }
  const labels = {
    waiting_for_empty_composer: "Waiting for empty composer",
    waiting_for_manual_approval: "Waiting for manual approval",
    waiting_for_chat_idle: "Waiting for ChatGPT",
    ready: "Ready",
    complete: "Complete",
    needs_user: "Needs user",
    blocked: "Blocked"
  };
  return labels[state.lastStatus] || state.lastStatus || (state.enabled ? "Watching" : "Stopped");
}
function request(type, extra = {}) { const requestId = `panel-${Date.now()}-${++counter}`; return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("Patient Oracle request timed out")); }, 25000); pending.set(requestId, { resolve, reject, timer }); port.postMessage({ type, requestId, tabId: tab.id, ...extra }); }); }
async function run(fn) { ui.save.disabled = true; ui.toggle.disabled = true; hideError(); try { await fn(); } catch (error) { showError(error); } finally { ui.toggle.disabled = false; await refresh(); } }
async function getActiveChatGptTab() { const [active] = await chrome.tabs.query({ active: true, currentWindow: true }); if (!active?.id || !isChatGptUrl(active.url || "")) throw new Error("Open the Patient Oracle Side Panel from an active ChatGPT tab"); return active; }
function isChatGptUrl(url) { try { const host = new URL(url).hostname; return host === "chatgpt.com" || host === "chat.openai.com"; } catch { return false; } }
function formatTime(value) { if (!value) return "-"; const d = new Date(value); return Number.isNaN(d.getTime()) ? "-" : d.toLocaleTimeString(); }
function showError(error) { ui.error.hidden = false; ui.error.textContent = error instanceof Error ? error.message : String(error); }
function hideError() { ui.error.hidden = true; ui.error.textContent = ""; }