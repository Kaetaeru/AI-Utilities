const $ = (selector) => document.querySelector(selector);
const log = $("#log");
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
      oracle: { owner: $("#oracleOwner").value, repo: $("#oracleRepo").value, branch: $("#oracleBranch").value || "main" },
      viewport: { width: Number($("#viewportWidth").value || 1440), height: Number($("#viewportHeight").value || 1000) }
    };
    const result = await api("/api/session/start", payload);
    sessionId = result.session_id;
    $("#session").hidden = false;
    $("#sessionMeta").textContent = JSON.stringify(result, null, 2);
    $("#plan").disabled = false;
    $("#iterate").disabled = true;
    append(`Session ${sessionId} started on ${result.branch}`);
  });
});

$("#plan").addEventListener("click", async () => {
  await act($("#plan"), async () => {
    const result = await api("/api/session/plan", { sessionId });
    $("#planOutput").textContent = JSON.stringify(result.plan, null, 2);
    $("#iterate").disabled = false;
    append(`Plan ready via ${result.request_id}`);
  });
});

$("#iterate").addEventListener("click", async () => {
  await act($("#iterate"), async () => {
    const result = await api("/api/session/iterate", { sessionId });
    $("#iterationOutput").textContent = JSON.stringify(result, null, 2);
    $("#sessionMeta").textContent = JSON.stringify(result.session, null, 2);
    append(`Iteration ${result.iteration} committed as ${result.commit || "no-op"}`);
  });
});

async function api(path, body) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

async function act(button, work) {
  const old = button.textContent;
  button.disabled = true;
  button.textContent = "Working...";
  try { await work(); }
  catch (error) { append(`ERROR: ${error.message}`, true); }
  finally { button.disabled = false; button.textContent = old; }
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
