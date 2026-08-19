(() => {
  if (globalThis.__PATIENT_ORACLE_ARTIFACT_PREVIEW_LOADED__) return;
  globalThis.__PATIENT_ORACLE_ARTIFACT_PREVIEW_LOADED__ = true;

  const PORT = "patient-oracle-content";
  const SCAN_MS = 1000;
  const RETRY_MS = 5000;
  const PREVIEW_WAIT_MS = 4500;
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

    const alreadyVisible = readPreviewArtifact();
    if (alreadyVisible) return sendArtifact(alreadyVisible);

    const card = findFileCard(expectedFilename);
    if (!card || hasDirectFetchUrl(card)) return;

    const clickTarget = chooseClickTarget(card);
    if (!clickTarget) return;
    previewInFlight = true;
    const token = executionToken;
    try {
      clickTarget.click();
      const text = await waitForPreviewArtifact(PREVIEW_WAIT_MS);
      if (executionToken !== token) return;
      if (!text) throw new Error(`Found ${expectedFilename}, opened its file card, but no readable JSON preview appeared`);
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
    const messageId = `preview-artifact-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    artifactMessageId = messageId;
    post({
      type: "PATIENT_ORACLE_RESPONSE_ARTIFACT",
      messageId,
      executionToken,
      filename: expectedFilename,
      text
    });
  }

  async function waitForPreviewArtifact(timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const text = readPreviewArtifact();
      if (text) return text;
      await sleep(100);
    }
    return null;
  }

  function readPreviewArtifact() {
    const candidates = [];
    const add = (node) => {
      if (!node || candidates.includes(node)) return;
      candidates.push(node);
    };

    for (const node of document.querySelectorAll('[role="dialog"], [aria-modal="true"], [data-testid*="preview"], [data-testid*="modal"]')) add(node);
    for (const node of document.querySelectorAll('pre, code, textarea, .view-lines, [data-testid*="code"], [data-testid*="preview"]')) {
      if (node.closest?.('[data-message-author-role]')) continue;
      add(node);
    }
    for (const frame of document.querySelectorAll("iframe")) add(frame);

    for (const node of candidates) {
      const text = previewText(node);
      const artifact = extractExpectedArtifact(text);
      if (artifact) return artifact;
    }
    return null;
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
    const source = String(text || "");
    if (!source || !requestId) return null;
    const direct = parseCandidate(source.trim());
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

  function findFileCard(filename) {
    const wanted = normalizeText(filename).toLowerCase();
    const selector = [
      "button", "a", '[role="button"]', '[role="link"]',
      "[data-filename]", "[data-file-name]", "[data-file-id]", "[data-testid]"
    ].join(",");
    for (const node of document.querySelectorAll(selector)) {
      if (!isVisible(node)) continue;
      const labels = [
        node.getAttribute?.("download"), node.getAttribute?.("title"), node.getAttribute?.("aria-label"),
        node.getAttribute?.("data-filename"), node.getAttribute?.("data-file-name"), node.textContent
      ].map((value) => normalizeText(value).toLowerCase()).filter(Boolean);
      if (labels.some((label) => label === wanted || label.includes(wanted))) return node;
    }
    return null;
  }

  function chooseClickTarget(node) {
    const target = node.matches?.('button, a, [role="button"], [role="link"]') ? node : node.closest?.('button, a, [role="button"], [role="link"]');
    if (!target || !isVisible(target)) return null;
    const label = normalizeText(`${target.textContent || ""} ${target.getAttribute?.("aria-label") || ""}`);
    if (/^(download|다운로드)(?:\s|$)/i.test(label)) return null;
    return target;
  }

  function hasDirectFetchUrl(node) {
    const nodes = [node, ...(node.querySelectorAll?.("[href], [data-download-url], [data-file-url], [data-url], [data-href], [data-src]") || [])];
    for (let parent = node.parentElement, depth = 0; parent && depth < 4; parent = parent.parentElement, depth += 1) nodes.push(parent);
    for (const element of nodes) {
      for (const attr of ["href", "data-download-url", "data-file-url", "data-url", "data-href", "data-src"]) {
        const raw = String(element.getAttribute?.(attr) || "").trim();
        if (/^(https?:|blob:)/i.test(raw)) return true;
      }
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
