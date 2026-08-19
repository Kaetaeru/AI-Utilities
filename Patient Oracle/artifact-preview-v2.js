(() => {
  if (globalThis.__PATIENT_ORACLE_ARTIFACT_PREVIEW_V2_LOADED__) return;
  globalThis.__PATIENT_ORACLE_ARTIFACT_PREVIEW_V2_LOADED__ = true;

  const PORT = "patient-oracle-content";
  const SCAN_MS = 750;
  const RETRY_MS = 4000;
  const PREVIEW_WAIT_MS = 6000;
  const MAX_PREVIEW_TEXT_CHARS = 9 * 1024 * 1024;
  let port = null;
  let reconnectTimer = null;
  let executionToken = null;
  let expectedFilename = null;
  let requestId = null;
  let previewInFlight = false;
  let nextAttemptAt = 0;
  let artifactMessageId = null;

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "PATIENT_ORACLE_PROMPT") return;
    const filename = String(message?.responseFilename || "");
    const token = String(message?.executionToken || "");
    const id = requestIdFromFilename(filename);
    if (!token || !id) return;
    executionToken = token;
    expectedFilename = filename;
    requestId = id;
    previewInFlight = false;
    nextAttemptAt = 0;
    artifactMessageId = null;
  });

  connect();
  const observer = new MutationObserver(() => { void scan(); });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  setInterval(() => { void scan(); }, SCAN_MS);

  async function scan() {
    if (!executionToken || !expectedFilename || previewInFlight || artifactMessageId || Date.now() < nextAttemptAt) return;
    if (!isChatIdle()) return;

    const card = findExactFileCard(expectedFilename);
    if (!card) return;
    const clickTarget = chooseClickTarget(card);
    if (!clickTarget) return;

    const baseline = new Set(previewCandidates());
    previewInFlight = true;
    const token = executionToken;
    try {
      clickTarget.click();
      const text = await waitForPreviewArtifact(baseline, PREVIEW_WAIT_MS);
      if (executionToken !== token) return;
      if (!text) throw new Error(`Found ${expectedFilename}, opened its file card, but no validated JSON preview appeared`);
      sendArtifact(text);
    } catch (error) {
      if (executionToken !== token) return;
      nextAttemptAt = Date.now() + RETRY_MS;
      post({
        type: "PATIENT_ORACLE_ARTIFACT_ERROR",
        executionToken: token,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      previewInFlight = false;
    }
  }

  function sendArtifact(text) {
    if (!executionToken || !expectedFilename || artifactMessageId) return;
    const messageId = `preview-v2-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    artifactMessageId = messageId;
    post({
      type: "PATIENT_ORACLE_RESPONSE_ARTIFACT",
      messageId,
      executionToken,
      filename: expectedFilename,
      text
    });
  }

  async function waitForPreviewArtifact(baseline, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const text = readValidatedPreviewArtifact(baseline);
      if (text) return text;
      await sleep(100);
    }
    return null;
  }

  function readValidatedPreviewArtifact(baseline) {
    for (const node of previewCandidates()) {
      if (!isVisible(node)) continue;
      const isNew = !baseline.has(node);
      const previewScoped = Boolean(node.closest?.('[role="dialog"], [aria-modal="true"], [data-testid*="preview"], [data-testid*="artifact"], [data-testid*="file"], [class*="monaco"]'));
      const filenameScoped = filenameNearby(node);
      if (!isNew && !previewScoped && !filenameScoped) continue;
      const artifact = extractExpectedArtifact(previewText(node));
      if (artifact) return artifact;
    }
    return null;
  }

  function previewCandidates() {
    const selectors = [
      '[role="dialog"]', '[aria-modal="true"]',
      '[data-testid*="preview"]', '[data-testid*="artifact"]', '[data-testid*="file"]', '[data-testid*="code"]',
      '[class*="monaco"]', '.view-lines', '.view-line', 'pre', 'code', 'textarea', 'iframe'
    ].join(',');
    return Array.from(document.querySelectorAll(selectors));
  }

  function previewText(node) {
    try {
      if (node instanceof HTMLIFrameElement) {
        const body = node.contentDocument?.body;
        return body ? String(body.innerText || body.textContent || "").slice(0, MAX_PREVIEW_TEXT_CHARS) : "";
      }
      if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) return String(node.value || "").slice(0, MAX_PREVIEW_TEXT_CHARS);
      return String(node.innerText || node.textContent || "").slice(0, MAX_PREVIEW_TEXT_CHARS);
    } catch {
      return "";
    }
  }

  function extractExpectedArtifact(text) {
    const source = String(text || "").trim();
    if (!source || !requestId) return null;
    const direct = parseCandidate(source);
    if (direct) return direct;

    let start = source.indexOf("{");
    while (start >= 0) {
      const end = balancedObjectEnd(source, start);
      if (end > start) {
        const parsed = parseCandidate(source.slice(start, end + 1));
        if (parsed) return parsed;
      }
      start = source.indexOf("{", start + 1);
    }
    return null;
  }

  function parseCandidate(text) {
    let value;
    try { value = JSON.parse(text); } catch { return null; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (value.version !== 1 || String(value.request_id || "").trim() !== requestId) return null;
    if (!["complete", "needs_user", "blocked", "continue"].includes(value.status)) return null;
    if (value.status === "complete" && !String(value.answer || "").trim()) return null;
    if (["needs_user", "blocked"].includes(value.status) && !String(value.reason || "").trim()) return null;
    if (value.status === "continue" && (!String(value.reason || "").trim() || value.resume_state === undefined || value.resume_state === null)) return null;
    return JSON.stringify(value);
  }

  function balancedObjectEnd(text, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return i;
        if (depth < 0) return -1;
      }
    }
    return -1;
  }

  function findExactFileCard(filename) {
    const wanted = normalizeText(filename).toLowerCase();
    const selector = [
      'button', 'a', '[role="button"]', '[role="link"]',
      '[data-filename]', '[data-file-name]', '[data-file-id]', '[data-testid]'
    ].join(',');
    const matches = [];
    for (const node of document.querySelectorAll(selector)) {
      if (!isVisible(node)) continue;
      const labels = [
        node.getAttribute?.("download"), node.getAttribute?.("title"), node.getAttribute?.("aria-label"),
        node.getAttribute?.("data-filename"), node.getAttribute?.("data-file-name")
      ].map((value) => normalizeText(value).toLowerCase()).filter(Boolean);
      const text = normalizeText(node.textContent).toLowerCase();
      if (text && text.length <= 600) labels.push(text);
      if (!labels.some((label) => label === wanted || label.includes(wanted))) continue;
      const rect = node.getBoundingClientRect();
      const exact = labels.some((label) => label === wanted);
      matches.push({ node, exact, area: Math.max(1, rect.width * rect.height), textLength: text.length || 9999 });
    }
    matches.sort((a, b) => Number(b.exact) - Number(a.exact) || a.area - b.area || a.textLength - b.textLength);
    return matches[0]?.node || null;
  }

  function chooseClickTarget(node) {
    const candidates = [];
    if (node.matches?.('button, a, [role="button"], [role="link"]')) candidates.push(node);
    let current = node.parentElement;
    for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
      if (current.matches?.('button, a, [role="button"], [role="link"]')) candidates.push(current);
    }
    for (const child of node.querySelectorAll?.('button, a, [role="button"], [role="link"]') || []) candidates.push(child);
    const usable = candidates.filter((target) => {
      if (!isVisible(target)) return false;
      const label = normalizeText(`${target.textContent || ""} ${target.getAttribute?.("aria-label") || ""}`);
      return !/^(download|다운로드)(?:\s|$)/i.test(label);
    });
    usable.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return ar.width * ar.height - br.width * br.height;
    });
    return usable[0] || null;
  }

  function filenameNearby(node) {
    const wanted = String(expectedFilename || "").toLowerCase();
    let current = node;
    for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
      const attrs = ["title", "aria-label", "data-filename", "data-file-name"]
        .map((name) => normalizeText(current.getAttribute?.(name)).toLowerCase())
        .filter(Boolean);
      const text = normalizeText(current.textContent).toLowerCase();
      if (text && text.length <= 2500) attrs.push(text);
      if (attrs.some((value) => value.includes(wanted))) return true;
    }
    return false;
  }

  function requestIdFromFilename(filename) {
    const match = /^patient-oracle-response-([A-Za-z0-9._-]+)\.json$/.exec(String(filename || ""));
    return match ? match[1] : null;
  }

  function isVisible(node) {
    if (!(node instanceof Element)) return false;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }

  function findStopButton() {
    for (const selector of ['button[data-testid="stop-button"]', 'button[aria-label*="Stop"]', 'button[aria-label*="stop"]', 'button[aria-label*="중지"]']) {
      const button = document.querySelector(selector);
      if (button) return button;
    }
    return null;
  }

  function isChatIdle() { return !findStopButton(); }

  function connect() {
    if (port) return;
    try {
      port = chrome.runtime.connect({ name: PORT });
      port.onMessage.addListener(handleAck);
      port.onDisconnect.addListener(() => {
        port = null;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 1000);
      });
    } catch {
      reconnectTimer = setTimeout(connect, 1000);
    }
  }

  function handleAck(message) {
    if (message?.type !== "PATIENT_ORACLE_ACK" || !artifactMessageId || message.messageId !== artifactMessageId) return;
    artifactMessageId = null;
    if (message.ok) {
      executionToken = null;
      expectedFilename = null;
      requestId = null;
      previewInFlight = false;
      nextAttemptAt = 0;
      return;
    }
    nextAttemptAt = Date.now() + RETRY_MS;
  }

  function post(message) {
    if (!port) connect();
    try { port?.postMessage(message); } catch { port = null; connect(); }
  }

  function normalizeText(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
})();