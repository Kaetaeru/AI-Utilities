(() => {
  if (globalThis.__PATIENT_ORACLE_LIVE_CONTENT_LOADED__) return;
  globalThis.__PATIENT_ORACLE_LIVE_CONTENT_LOADED__ = true;

  const STABLE_IDLE_MS = 700;
  const MIN_IDLE_NOTIFY_AFTER_DISPATCH_MS = 3000;
  const ARTIFACT_RETRY_MS = 4000;
  let armed = null;
  let checkpointTimer = null;
  let hardStopTimer = null;
  let idleSince = null;
  let sawGenerating = false;
  let idleNotified = false;
  let dispatchConfirmedAtMs = null;
  let artifactInFlight = false;
  let artifactSent = false;
  let artifactRetryAt = 0;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "PATIENT_ORACLE_LIVE_PING") {
      sendResponse({ ready: true });
      return;
    }
    if (message?.type !== "PATIENT_ORACLE_LIVE_PROMPT") return;
    dispatchPrompt(message)
      .then(() => sendResponse({ sent: true }))
      .catch((error) => sendResponse({ sent: false, code: String(error?.code || ""), error: error instanceof Error ? error.message : String(error) }));
    return true;
  });

  const observer = new MutationObserver(() => { void observeLifecycle(); });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  setInterval(() => { void observeLifecycle(); }, 1000);

  async function dispatchPrompt(message) {
    const prompt = String(message?.prompt || "");
    const jobId = String(message?.jobId || "");
    const executionToken = String(message?.executionToken || "");
    const responseFilename = String(message?.responseFilename || "");
    const checkpointMs = Date.parse(String(message?.checkpointAt || ""));
    const hardStopMs = Date.parse(String(message?.hardStopAt || ""));
    if (!prompt.trim()) fail("prompt_empty", "Patient Oracle live prompt is empty");
    if (!jobId || !executionToken) fail("identity_missing", "Patient Oracle live execution identity is missing");
    if (!/^patient-oracle-response-[A-Za-z0-9._-]+\.json$/.test(responseFilename)) fail("filename_invalid", "Patient Oracle live response filename is invalid");
    if (!Number.isFinite(checkpointMs) || !Number.isFinite(hardStopMs) || checkpointMs >= hardStopMs || hardStopMs <= Date.now()) fail("budget_invalid", "Patient Oracle live execution budget is invalid");
    if (!isChatIdle()) fail("chat_busy", "ChatGPT is still generating");

    const composer = await waitForComposer(15000);
    if (!composer) fail("composer_missing", "ChatGPT composer was not found");
    if (readComposer(composer).trim()) fail("composer_not_empty", "ChatGPT composer is not empty; Patient Oracle will not overwrite it");
    if (!await synchronizeComposerPrompt(prompt, 7000)) fail("composer_sync_failed", "Prompt text did not synchronize with the ChatGPT composer");

    arm({ jobId, executionToken, responseFilename, checkpointMs, hardStopMs });
    const sendButton = await waitForSendButton(5000);
    if (sendButton) sendButton.click(); else dispatchEnter(findComposer() || composer);
    if (!await waitForDispatchEvidence(5000)) {
      disarm();
      fail("dispatch_evidence_failed", "Patient Oracle could not confirm live prompt submission");
    }
    dispatchConfirmedAtMs = Date.now();
  }

  function arm(next) {
    clearTimers();
    armed = next;
    idleSince = null;
    sawGenerating = false;
    idleNotified = false;
    dispatchConfirmedAtMs = null;
    artifactInFlight = false;
    artifactSent = false;
    artifactRetryAt = 0;
    checkpointTimer = setTimeout(() => {
      if (armed?.executionToken === next.executionToken) void postEvent({ type: "PATIENT_ORACLE_CHECKPOINT_DUE", executionToken: next.executionToken });
    }, Math.max(0, next.checkpointMs - Date.now()));
    hardStopTimer = setTimeout(() => enforceHardStop(next.executionToken), Math.max(0, next.hardStopMs - Date.now()));
  }

  function disarm() {
    armed = null;
    idleSince = null;
    sawGenerating = false;
    idleNotified = false;
    dispatchConfirmedAtMs = null;
    artifactInFlight = false;
    artifactSent = false;
    artifactRetryAt = 0;
    clearTimers();
  }

  function clearTimers() {
    if (checkpointTimer) clearTimeout(checkpointTimer);
    if (hardStopTimer) clearTimeout(hardStopTimer);
    checkpointTimer = null;
    hardStopTimer = null;
  }

  function enforceHardStop(token) {
    if (armed?.executionToken !== token) return;
    const stopButton = findStopButton();
    if (stopButton) stopButton.click();
    void postEvent({ type: "PATIENT_ORACLE_HARD_STOP", executionToken: token, stopClicked: Boolean(stopButton) });
    disarm();
  }

  async function observeLifecycle() {
    if (!armed) return;
    const idle = isChatIdle();
    if (!idle) {
      sawGenerating = true;
      idleSince = null;
    } else if (idleSince === null) {
      idleSince = Date.now();
    }

    await tryCaptureResponseArtifact();
    const dispatchOldEnough = Number.isFinite(dispatchConfirmedAtMs) && Date.now() - dispatchConfirmedAtMs >= MIN_IDLE_NOTIFY_AFTER_DISPATCH_MS;
    if ((!sawGenerating && !dispatchOldEnough) || !idle || idleNotified || idleSince === null) return;
    if (Date.now() - idleSince < STABLE_IDLE_MS) return;
    idleNotified = true;
    await postEvent({ type: "PATIENT_ORACLE_TURN_IDLE", executionToken: armed.executionToken });
  }

  async function tryCaptureResponseArtifact() {
    if (!armed || artifactInFlight || artifactSent || Date.now() < artifactRetryAt) return;
    const candidate = findResponseFileCandidate(armed.responseFilename);
    if (!candidate) return;
    artifactInFlight = true;
    const token = armed.executionToken;
    try {
      const artifact = await readFileCandidate(candidate);
      if (armed?.executionToken !== token) return;
      const response = await postEvent({
        type: artifact.text !== null ? "PATIENT_ORACLE_RESPONSE_ARTIFACT" : "PATIENT_ORACLE_RESPONSE_ARTIFACT_URL",
        executionToken: token,
        filename: armed.responseFilename,
        ...(artifact.text !== null ? { text: artifact.text } : { url: artifact.url })
      });
      if (response?.ok && response?.accepted) {
        artifactSent = true;
        disarm();
      } else {
        artifactRetryAt = Date.now() + ARTIFACT_RETRY_MS;
      }
    } catch (error) {
      artifactRetryAt = Date.now() + ARTIFACT_RETRY_MS;
      await postEvent({ type: "PATIENT_ORACLE_ARTIFACT_ERROR", executionToken: token, error: error instanceof Error ? error.message : String(error) });
    } finally {
      artifactInFlight = false;
    }
  }

  async function postEvent(event) {
    if (!armed) return null;
    try {
      return await chrome.runtime.sendMessage({ type: "PATIENT_ORACLE_LIVE_EVENT", jobId: armed.jobId, event });
    } catch {
      return null;
    }
  }

  function findResponseFileCandidate(filename) {
    const wanted = normalizeText(filename).toLowerCase();
    const selector = 'a[href],a[download],button,[role="link"],[role="button"],[data-download-url],[data-file-url],[data-url],[data-href],[data-filename],[data-file-name]';
    for (const node of document.querySelectorAll(selector)) {
      const labels = [
        node.getAttribute?.("download"), node.getAttribute?.("title"), node.getAttribute?.("aria-label"),
        node.getAttribute?.("data-filename"), node.getAttribute?.("data-file-name"), filenameFromUrl(node.getAttribute?.("href")),
        normalizeText(node.textContent).slice(0, 1200)
      ].map((value) => normalizeText(value).toLowerCase()).filter(Boolean);
      if (labels.some((label) => label === wanted || label.endsWith(`/${wanted}`) || label.includes(wanted))) return node;
    }
    return null;
  }

  async function readFileCandidate(node) {
    const urls = candidateUrls(node);
    if (!urls.length) throw new Error(`Found ${armed?.responseFilename || "response file"} but no readable URL was exposed`);
    let lastError = null;
    for (const url of urls) {
      try {
        if (url.startsWith("sandbox:")) throw new Error("sandbox URL is not directly fetchable");
        const response = await fetch(url, { method: "GET", credentials: "include", cache: "no-store" });
        if (!response.ok) throw new Error(`response file fetch failed with HTTP ${response.status}`);
        const text = await response.text();
        if (!text.trim()) throw new Error("response file was empty");
        return { text, url: null };
      } catch (error) { lastError = error; }
    }
    const fallback = urls.find((url) => /^https?:/i.test(url));
    if (fallback) return { text: null, url: fallback };
    throw lastError || new Error("Could not read generated Patient Oracle live response file");
  }

  function candidateUrls(node) {
    const values = [];
    const add = (value) => {
      const raw = String(value || "").trim();
      if (!raw || raw.startsWith("javascript:")) return;
      try {
        const resolved = raw.startsWith("blob:") || raw.startsWith("sandbox:") ? raw : new URL(raw, location.href).href;
        if (!values.includes(resolved)) values.push(resolved);
      } catch {}
    };
    const collect = (element) => {
      if (!element?.getAttribute) return;
      add(element.getAttribute("href"));
      for (const attr of ["data-download-url", "data-file-url", "data-url", "data-href", "data-src"]) add(element.getAttribute(attr));
    };
    collect(node);
    for (const child of node.querySelectorAll?.('a[href],[data-download-url],[data-file-url],[data-url],[data-href],[data-src]') || []) collect(child);
    let parent = node.parentElement;
    for (let depth = 0; parent && depth < 5; depth += 1, parent = parent.parentElement) collect(parent);
    return values.slice(0, 20);
  }

  function filenameFromUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try { return decodeURIComponent(new URL(raw, location.href).pathname.split("/").pop() || ""); } catch { return ""; }
  }

  function findComposer() {
    return document.querySelector("#prompt-textarea") || document.querySelector('textarea[data-id="root"]') || document.querySelector("main textarea") || document.querySelector('main [contenteditable="true"]');
  }

  async function waitForComposer(timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const composer = findComposer();
      if (composer) return composer;
      await sleep(100);
    }
    return null;
  }

  function readComposer(composer) {
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) return composer.value || "";
    return composer.innerText || composer.textContent || "";
  }

  async function synchronizeComposerPrompt(text, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const composer = findComposer();
      if (!composer) { await sleep(100); continue; }
      if (normalizeText(readComposer(composer))) return normalizeText(readComposer(composer)) === normalizeText(text);
      writeComposer(composer, text);
      if (await waitForComposerText(text, 2500)) return true;
      await sleep(250);
    }
    return false;
  }

  function writeComposer(composer, text) {
    composer.focus();
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(composer), "value")?.set;
      if (setter) setter.call(composer, text); else composer.value = text;
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    try {
      document.execCommand("selectAll", false, null);
      if (document.execCommand("insertText", false, text)) {
        composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
        return;
      }
    } catch {}
    composer.textContent = text;
    composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }

  async function waitForComposerText(text, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const composer = findComposer();
      if (composer && normalizeText(readComposer(composer)) === normalizeText(text)) return true;
      await sleep(75);
    }
    return false;
  }

  async function waitForSendButton(timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const button = findSendButton();
      if (button && !button.disabled) return button;
      await sleep(75);
    }
    return null;
  }

  function findSendButton() {
    for (const selector of ['button[data-testid="send-button"]','button[aria-label*="Send"]','button[aria-label*="send"]','button[aria-label*="보내기"]']) {
      const button = document.querySelector(selector);
      if (button) return button;
    }
    return null;
  }

  function dispatchEnter(composer) {
    composer.focus();
    for (const type of ["keydown", "keypress", "keyup"]) composer.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
  }

  async function waitForDispatchEvidence(timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const composer = findComposer();
      if (!composer || !normalizeText(readComposer(composer)) || !isChatIdle()) return true;
      await sleep(100);
    }
    return false;
  }

  function findStopButton() {
    for (const selector of ['button[data-testid="stop-button"]','button[aria-label*="Stop"]','button[aria-label*="stop"]','button[aria-label*="중지"]']) {
      const button = document.querySelector(selector);
      if (button) return button;
    }
    return null;
  }

  function isChatIdle() { return !findStopButton(); }
  function normalizeText(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
  function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
})();
