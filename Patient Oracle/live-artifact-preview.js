(() => {
  if (globalThis.__PATIENT_ORACLE_LIVE_ARTIFACT_PREVIEW_LOADED__) return;
  globalThis.__PATIENT_ORACLE_LIVE_ARTIFACT_PREVIEW_LOADED__ = true;

  const SCAN_MS = 750;
  const RETRY_MS = 4000;
  const PREVIEW_WAIT_MS = 6000;
  const MAX_PREVIEW_TEXT_CHARS = 9 * 1024 * 1024;
  let armed = null;
  let previewInFlight = false;
  let nextAttemptAt = 0;

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "PATIENT_ORACLE_LIVE_PROMPT") return;
    const jobId = String(message?.jobId || "");
    const executionToken = String(message?.executionToken || "");
    const expectedFilename = String(message?.responseFilename || "");
    if (!jobId || !executionToken || !expectedFilename) return;
    armed = { jobId, executionToken, expectedFilename };
    previewInFlight = false;
    nextAttemptAt = 0;
  });

  const observer = new MutationObserver(() => { void scan(); });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  setInterval(() => { void scan(); }, SCAN_MS);

  async function scan() {
    if (!armed || previewInFlight || Date.now() < nextAttemptAt || !isChatIdle()) return;
    const card = findExactFileCard(armed.expectedFilename);
    if (!card) return;
    const target = chooseClickTarget(card);
    if (!target) return;
    const baseline = new Set(previewCandidates());
    previewInFlight = true;
    const token = armed.executionToken;
    try {
      target.click();
      const text = await waitForPreviewArtifact(baseline, PREVIEW_WAIT_MS);
      if (armed?.executionToken !== token) return;
      if (!text) throw new Error(`Found ${armed.expectedFilename}, opened it, but no validated JSON preview appeared`);
      const response = await chrome.runtime.sendMessage({
        type: "PATIENT_ORACLE_LIVE_EVENT",
        jobId: armed.jobId,
        event: {
          type: "PATIENT_ORACLE_RESPONSE_ARTIFACT",
          executionToken: token,
          filename: armed.expectedFilename,
          text
        }
      });
      if (response?.ok && response?.accepted) armed = null;
      else nextAttemptAt = Date.now() + RETRY_MS;
    } catch (error) {
      nextAttemptAt = Date.now() + RETRY_MS;
      try {
        await chrome.runtime.sendMessage({
          type: "PATIENT_ORACLE_LIVE_EVENT",
          jobId: armed?.jobId,
          event: { type: "PATIENT_ORACLE_ARTIFACT_ERROR", executionToken: token, error: error instanceof Error ? error.message : String(error) }
        });
      } catch {}
    } finally {
      previewInFlight = false;
    }
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
      const scoped = Boolean(node.closest?.('[role="dialog"],[aria-modal="true"],[data-testid*="preview"],[data-testid*="artifact"],[data-testid*="file"],[class*="monaco"]'));
      if (!isNew && !scoped && !filenameNearby(node)) continue;
      const artifact = extractExpectedArtifact(previewText(node));
      if (artifact) return artifact;
    }
    return null;
  }

  function extractExpectedArtifact(text) {
    const source = String(text || "").trim();
    if (!source || !armed) return null;
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
    if (value.version !== 1 || String(value.request_id || "").trim() !== armed?.jobId) return null;
    if (!["complete", "needs_user", "blocked"].includes(value.status)) return null;
    if (value.status === "complete" && !String(value.answer || "").trim()) return null;
    if (["needs_user", "blocked"].includes(value.status) && !String(value.reason || "").trim()) return null;
    return JSON.stringify(value);
  }

  function balancedObjectEnd(text, start) {
    let depth = 0, inString = false, escaped = false;
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
      else if (ch === "}") { depth -= 1; if (depth === 0) return i; if (depth < 0) return -1; }
    }
    return -1;
  }

  function previewCandidates() {
    return Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"],[data-testid*="preview"],[data-testid*="artifact"],[data-testid*="file"],[data-testid*="code"],[class*="monaco"],.view-lines,.view-line,pre,code,textarea,iframe'));
  }

  function previewText(node) {
    try {
      if (node instanceof HTMLIFrameElement) return String(node.contentDocument?.body?.innerText || node.contentDocument?.body?.textContent || "").slice(0, MAX_PREVIEW_TEXT_CHARS);
      if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) return String(node.value || "").slice(0, MAX_PREVIEW_TEXT_CHARS);
      return String(node.innerText || node.textContent || "").slice(0, MAX_PREVIEW_TEXT_CHARS);
    } catch { return ""; }
  }

  function findExactFileCard(filename) {
    const wanted = normalizeText(filename).toLowerCase();
    const matches = [];
    for (const node of document.querySelectorAll('button,a,[role="button"],[role="link"],[data-filename],[data-file-name],[data-file-id],[data-testid]')) {
      if (!isVisible(node)) continue;
      const labels = [node.getAttribute?.("download"),node.getAttribute?.("title"),node.getAttribute?.("aria-label"),node.getAttribute?.("data-filename"),node.getAttribute?.("data-file-name"),normalizeText(node.textContent)]
        .map((value) => normalizeText(value).toLowerCase()).filter(Boolean);
      if (!labels.some((label) => label === wanted || label.includes(wanted))) continue;
      const rect = node.getBoundingClientRect();
      matches.push({ node, exact: labels.some((label) => label === wanted), area: Math.max(1, rect.width * rect.height) });
    }
    matches.sort((a, b) => Number(b.exact) - Number(a.exact) || a.area - b.area);
    return matches[0]?.node || null;
  }

  function chooseClickTarget(node) {
    const candidates = [];
    if (node.matches?.('button,a,[role="button"],[role="link"]')) candidates.push(node);
    let parent = node.parentElement;
    for (let depth = 0; parent && depth < 6; depth += 1, parent = parent.parentElement) if (parent.matches?.('button,a,[role="button"],[role="link"]')) candidates.push(parent);
    for (const child of node.querySelectorAll?.('button,a,[role="button"],[role="link"]') || []) candidates.push(child);
    return candidates.find((candidate) => isVisible(candidate) && !/^(download|다운로드)(?:\s|$)/i.test(normalizeText(`${candidate.textContent || ""} ${candidate.getAttribute?.("aria-label") || ""}`))) || null;
  }

  function filenameNearby(node) {
    const wanted = String(armed?.expectedFilename || "").toLowerCase();
    let current = node;
    for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
      const text = normalizeText(`${current.getAttribute?.("title") || ""} ${current.getAttribute?.("aria-label") || ""} ${current.textContent || ""}`).toLowerCase();
      if (text.includes(wanted)) return true;
    }
    return false;
  }

  function isVisible(node) {
    if (!(node instanceof Element)) return false;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  }

  function findStopButton() {
    return document.querySelector('button[data-testid="stop-button"],button[aria-label*="Stop"],button[aria-label*="stop"],button[aria-label*="중지"]');
  }

  function isChatIdle() { return !findStopButton(); }
  function normalizeText(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
})();
