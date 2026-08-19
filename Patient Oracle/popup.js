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
  if (snapshot.state?.enabled) await request("PATIENT_ORACLE_STOP");
  else { await save(); await request("PATIENT_ORACLE_START"); }
  await refresh();
}

async function refresh() { try { const snapshot = await request("PATIENT_ORACLE_STATUS"); render(snapshot.state || DEFAULT_STATE); } catch (error) { showError(error); } }
function render(state) { ui.status.textContent = state.dispatching ? "Dispatching" : state.executing ? (state.lastStatus === "bootstrapping" ? "Bootstrapping" : "Executing") : state.lastStatus || (state.enabled ? "Watching" : "Stopped"); ui.request.textContent = state.currentRequestId || "-"; ui.revision.textContent = Number(state.lastRevision) >= 0 ? String(state.lastRevision) : "-"; ui.dispatches.textContent = String(state.requestDispatchCount || 0); ui.checkpoint.textContent = formatTime(state.checkpointAt); ui.hardstop.textContent = formatTime(state.executionHardStopAt); ui.toggle.textContent = state.enabled ? "Stop Oracle" : "Start Oracle"; ui.save.disabled = Boolean(state.enabled); if (state.lastError) showError(new Error(state.lastError)); else hideError(); }
function request(type, extra = {}) { const requestId = `popup-${Date.now()}-${++counter}`; return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("Patient Oracle request timed out")); }, 25000); pending.set(requestId, { resolve, reject, timer }); port.postMessage({ type, requestId, tabId: tab.id, ...extra }); }); }
async function run(fn) { ui.save.disabled = true; ui.toggle.disabled = true; hideError(); try { await fn(); } catch (error) { showError(error); } finally { ui.toggle.disabled = false; await refresh(); } }
async function getActiveChatGptTab() { const [active] = await chrome.tabs.query({ active: true, currentWindow: true }); if (!active?.id || !isChatGptUrl(active.url || "")) throw new Error("Open the Patient Oracle popup from an active ChatGPT tab"); return active; }
function isChatGptUrl(url) { try { const host = new URL(url).hostname; return host === "chatgpt.com" || host === "chat.openai.com"; } catch { return false; } }
function formatTime(value) { if (!value) return "-"; const d = new Date(value); return Number.isNaN(d.getTime()) ? "-" : d.toLocaleTimeString(); }
function showError(error) { ui.error.hidden = false; ui.error.textContent = error instanceof Error ? error.message : String(error); }
function hideError() { ui.error.hidden = true; ui.error.textContent = ""; }
