import { DEFAULT_LIVE_CONFIG } from "./live-control.js";

const root = document.createElement("section");
root.innerHTML = `
  <div style="display:grid;gap:8px;padding:10px;border:1px solid #333;border-radius:8px;background:#151515">
    <div><strong>1.0 Live Worker Preview</strong><div style="color:#888;font-size:11px;margin-top:2px">Fresh ChatGPT tab per job · terminal tabs close automatically</div></div>
    <label class="check" style="margin:0"><input id="liveEnabled" type="checkbox"><span><strong>Accept live jobs</strong><br><span class="hint">User-controlled intake switch. Existing jobs are not cancelled when turned off.</span></span></label>
    <label>Max concurrent workers<input id="liveMaxWorkers" type="number" min="1" value="2"></label>
    <div class="status"><div><span>Active workers</span><strong id="liveActive">0</strong></div><div><span>Capacity</span><strong id="liveCapacity">0 / 2</strong></div></div>
    <label>Test prompt<textarea id="livePrompt" rows="4" style="box-sizing:border-box;width:100%;padding:8px;border:1px solid #444;border-radius:6px;background:#191919;color:#fff;resize:vertical" placeholder="Return exactly LIVE_OK."></textarea></label>
    <div class="row"><button id="liveSave" style="background:#333;color:#fff">Save live settings</button><button id="liveRun" style="background:#eee;color:#111">Run test job</button></div>
    <div id="liveError" class="error" hidden></div>
    <div><span style="color:#888;font-size:11px">Recent jobs</span><div id="liveJobs" style="display:grid;gap:6px;margin-top:6px"></div></div>
  </div>`;
document.querySelector("main")?.append(root);

const ui = Object.fromEntries(["liveEnabled","liveMaxWorkers","liveActive","liveCapacity","livePrompt","liveSave","liveRun","liveError","liveJobs"].map((id) => [id, root.querySelector(`#${id}`)]));
ui.liveSave.addEventListener("click", () => run(saveConfig));
ui.liveRun.addEventListener("click", () => run(startTestJob));
await refresh();
setInterval(() => { void refresh(); }, 1000);

async function saveConfig() {
  const response = await call("PATIENT_ORACLE_LIVE_SET_CONFIG", {
    config: { enabled: ui.liveEnabled.checked, maxWorkers: ui.liveMaxWorkers.value, closeTabsOnTerminal: true }
  });
  renderConfig(response.config || DEFAULT_LIVE_CONFIG);
}

async function startTestJob() {
  const prompt = String(ui.livePrompt.value || "").trim();
  if (!prompt) throw new Error("Enter a test prompt first");
  const response = await call("PATIENT_ORACLE_LIVE_START", { prompt, origin: "side-panel-test" });
  if (response.status === "busy") throw new Error(`All ${response.max_workers} live workers are busy`);
  if (response.status === "disabled") throw new Error("Enable Accept live jobs first");
  ui.livePrompt.value = "";
  await refresh();
}

async function refresh() {
  try {
    const status = await call("PATIENT_ORACLE_LIVE_STATUS");
    renderConfig(status.config || DEFAULT_LIVE_CONFIG);
    ui.liveActive.textContent = String(status.active_workers || 0);
    ui.liveCapacity.textContent = `${status.active_workers || 0} / ${status.config?.maxWorkers || DEFAULT_LIVE_CONFIG.maxWorkers}`;
    renderJobs(status.jobs || []);
    hideError();
  } catch (error) { showError(error); }
}

function renderConfig(config) {
  ui.liveEnabled.checked = Boolean(config.enabled);
  if (document.activeElement !== ui.liveMaxWorkers) ui.liveMaxWorkers.value = String(config.maxWorkers || 2);
}

function renderJobs(jobs) {
  ui.liveJobs.textContent = "";
  if (!jobs.length) {
    const empty = document.createElement("div");
    empty.textContent = "No live jobs yet";
    empty.style.color = "#777";
    empty.style.fontSize = "11px";
    ui.liveJobs.append(empty);
    return;
  }
  for (const job of jobs.slice(0, 8)) {
    const row = document.createElement("div");
    row.style.cssText = "display:grid;grid-template-columns:1fr auto;gap:6px;align-items:center;background:#181818;padding:7px;border-radius:6px";
    const text = document.createElement("div");
    text.innerHTML = `<strong style="overflow-wrap:anywhere">${escapeHtml(job.job_id)}</strong><div style="color:#888;font-size:11px">${escapeHtml(job.status)}${job.phase ? ` · ${escapeHtml(job.phase)}` : ""}</div>`;
    row.append(text);
    if (["starting","running","waiting_for_response_file"].includes(job.status)) {
      const cancel = document.createElement("button");
      cancel.textContent = "Cancel";
      cancel.style.cssText = "padding:5px 7px;background:#333;color:#fff";
      cancel.addEventListener("click", () => run(() => call("PATIENT_ORACLE_LIVE_CANCEL", { jobId: job.job_id })));
      row.append(cancel);
    }
    ui.liveJobs.append(row);
  }
}

async function call(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...extra });
  if (!response?.ok) throw new Error(response?.error || "Patient Oracle live request failed");
  return response;
}

async function run(fn) {
  ui.liveSave.disabled = true;
  ui.liveRun.disabled = true;
  hideError();
  try { await fn(); } catch (error) { showError(error); } finally { ui.liveSave.disabled = false; ui.liveRun.disabled = false; await refresh(); }
}

function showError(error) { ui.liveError.hidden = false; ui.liveError.textContent = error instanceof Error ? error.message : String(error); }
function hideError() { ui.liveError.hidden = true; ui.liveError.textContent = ""; }
function escapeHtml(value) { return String(value || "").replace(/[&<>"']/g, (ch) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch])); }
