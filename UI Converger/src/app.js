const $ = (selector) => document.querySelector(selector);
const log = $("#log");
const DEFAULT_ORACLE_BRANCH = "agent/patient-oracle-e2e";
let sessionId = null;

$("#blueprintFile").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (file) $("#blueprint").value = await file.text();
});

$("#start").addEventListener("click", async () => {
  await act($("#start"), async () => {
    const payload = {
      repoPath: $("#repoPath").value,
      previewUrl: $("#previewUrl").value,
      blueprint: $("#blueprint").value,
      userIntent: $("#intent").value,
      protectedPaths: splitLines($("#protectedPaths").value),
      oracle: {
        owner: $("#oracleOwner").value || "Kaetaeru",
        repo: $("#oracleRepo").value || "AI-Utilities",
        branch: $("#oracleBranch").value || DEFAULT_ORACLE_BRANCH
      },
      viewport: { width: Number($("#viewportWidth").value || 1440), height: Number($("#viewportHeight").value || 1000) }
    };
    const result = await api("/api/session/start", payload);
    sessionId = result.session_id;
    $("#session").hidden = false;
    renderSession(result);
    $("#plan").disabled = false;
    $("#iterate").disabled = true;
    append(`Session ${sessionId} started on ${result.branch}`);
  });
});

$("#plan").addEventListener("click", async () => {
  await act($("#plan"), async () => {
    const result = await api("/api/session/plan", { sessionId });
    $("#planOutput").textContent = JSON.stringify(result.plan, null, 2);
    renderSession(result.session);
    $("#iterate").disabled = false;
    append(`Plan revision ${result.plan_revision} ready via ${result.request_id}`);
  });
});

$("#iterate").addEventListener("click", async () => {
  await act($("#iterate"), async () => {
    const result = await api("/api/session/iterate", { sessionId });
    $("#iterationOutput").textContent = JSON.stringify(result, null, 2);
    renderSession(result.session);
    append(`Iteration ${result.iteration} committed as ${result.commit || "no-op"}`);
  });
});

async function api(path, body) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(value.error || `HTTP ${response.status}`);
    error.payload = value;
    throw error;
  }
  return value;
}

async function act(button, work) {
  const old = button.textContent;
  button.disabled = true;
  button.textContent = "Working...";
  try { await work(); }
  catch (error) {
    const detail = error.payload || {};
    if (detail.code === "PATIENT_ORACLE_TIMEOUT" && detail.request_id) {
      append(`Patient Oracle request ${detail.request_id} is still durable. Press this action again to wait on the same request ID.`, true);
    } else if (detail.oracle_status && detail.request_id) {
      append(`Patient Oracle ${detail.oracle_status} for ${detail.request_id}: ${detail.reason || error.message}`, true);
    } else {
      append(`ERROR: ${error.message}`, true);
    }
  }
  finally { button.disabled = false; button.textContent = old; }
}

function renderSession(value) {
  if (value) $("#sessionMeta").textContent = JSON.stringify(value, null, 2);
}

function append(message, error = false) {
  const line = document.createElement("div");
  line.className = error ? "error" : "";
  line.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
  log.prepend(line);
}

function splitLines(value) {
  return String(value || "").split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}
