(() => {
  if (globalThis.__PATIENT_ORACLE_CONTENT_LOADED__) return;
  globalThis.__PATIENT_ORACLE_CONTENT_LOADED__ = true;

  const PORT = "patient-oracle-content";
  const TICK_MS = 2000;
  const STABLE_IDLE_MS = 700;
  const ARTIFACT_RETRY_MS = 5000;
  let port = null;
  let reconnectTimer = null;
  let armedToken = null;
  let expectedFilename = null;
  let sawGenerating = false;
  let idleSince = null;
  let idleNotified = false;
  let checkpointTimer = null;
  let hardStopTimer = null;
  let hardStopAtMs = null;
  let artifactInFlight = false;
  let artifactSent = false;
  let artifactMessageId = null;
  let artifactRetryAt = 0;
  let artifactErrorKey = null;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "PATIENT_ORACLE_PING") {
      sendResponse({ ready: true });
      return;
    }
    if (message?.type === "PATIENT_ORACLE_PROMPT") {
      dispatchPrompt(message)
        .then(() => sendResponse({ sent: true }))
        .catch((error) => sendResponse({
          sent: false,
          code: String(error?.code || ""),
          error: error instanceof Error ? error.message : String(error)
        }));
      return true;
    }
  });

  connect();
  const observer = new MutationObserver(() => { void observeLifecycle(); });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  setInterval(() => {
    void observeLifecycle();
    post({
      type: "PATIENT_ORACLE_POLL",
      idleStableForMs: idleSince === null ? 0 : Math.max(0, Date.now() - idleSince),
      approvalVisible: Boolean(findGitHubApprovalCard()),
      hardStopReached: Number.isFinite(hardStopAtMs) && Date.now() >= hardStopAtMs
    });
  }, TICK_MS);

  async function dispatchPrompt(message) {
    const prompt = String(message?.prompt || "");
    const executionToken = String(message?.executionToken || "");
    const responseName = String(message?.responseFilename || "");
    const checkpointMs = Date.parse(String(message?.checkpointAt || ""));
    const hardStopMs = Date.parse(String(message?.hardStopAt || ""));
    if (!prompt.trim()) throw new Error("Patient Oracle prompt is empty");
    if (!executionToken) throw new Error("Patient Oracle execution token is missing");
    if (!/^patient-oracle-response-[A-Za-z0-9._-]+\.json$/.test(responseName)) throw new Error("Patient Oracle response filename is invalid");
    if (!isChatIdle()) fail("chat_busy", "ChatGPT is still generating");
    if (findGitHubApprovalCard()) fail("approval_pending", "A ChatGPT GitHub approval is pending; Patient Oracle will not dispatch");
    if (!Number.isFinite(checkpointMs) || !Number.isFinite(hardStopMs) || checkpointMs >= hardStopMs || hardStopMs <= Date.now()) throw new Error("Patient Oracle execution budget is invalid");

    const composer = await waitForComposer(10000);
    if (!composer) throw new Error("ChatGPT composer was not found");
    if (readComposer(composer).trim()) fail("composer_not_empty", "ChatGPT composer is not empty; user draft is protected");
    writeComposer(composer, prompt);
    if (!await waitForComposerText(prompt, 1500)) throw new Error("Prompt text did not synchronize with the ChatGPT composer");

    arm(executionToken, responseName, checkpointMs, hardStopMs);
    const sendButton = await waitForSendButton(4000);
    if (sendButton) sendButton.click();
    else dispatchEnter(composer);
    if (!await waitForDispatchEvidence(4000)) {
      disarm(executionToken);
      throw new Error("Patient Oracle could not confirm prompt submission");
    }
  }

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  function arm(token, responseName, checkpointMs, hardStopMs) {
    clearTimers();
    armedToken = token;
    expectedFilename = responseName;
    sawGenerating = false;
    idleSince = null;
    idleNotified = false;
    hardStopAtMs = hardStopMs;
    artifactInFlight = false;
    artifactSent = false;
    artifactMessageId = null;
    artifactRetryAt = 0;
    artifactErrorKey = null;
    checkpointTimer = setTimeout(() => {
      if (armedToken === token) post({ type: "PATIENT_ORACLE_CHECKPOINT_DUE", executionToken: token });
    }, Math.max(0, checkpointMs - Date.now()));
    hardStopTimer = setTimeout(() => enforceHardStop(token), Math.max(0, hardStopMs - Date.now()));
  }

  function enforceHardStop(token) {
    if (armedToken !== token) return;
    const stopButton = findStopButton();
    if (stopButton) stopButton.click();
    post({
      type: "PATIENT_ORACLE_HARD_STOP",
      executionToken: token,
      approvalVisible: Boolean(findGitHubApprovalCard()),
      stopClicked: Boolean(stopButton)
    });
    disarm(token);
  }

  async function observeLifecycle() {
    const approvalVisible = Boolean(findGitHubApprovalCard());
    const idle = isChatIdle();
    if (approvalVisible || !idle) {
      idleSince = null;
      if (!idle && armedToken) sawGenerating = true;
    } else if (idleSince === null) {
      idleSince = Date.now();
    }

    if (!armedToken) return;
    await tryCaptureResponseArtifact();
    if (!sawGenerating || approvalVisible || !idle || idleNotified || idleSince === null) return;
    if (Date.now() - idleSince < STABLE_IDLE_MS) return;
    idleNotified = true;
    post({ type: "PATIENT_ORACLE_TURN_IDLE", executionToken: armedToken });
  }

  async function tryCaptureResponseArtifact() {
    if (!armedToken || !expectedFilename || artifactInFlight || artifactSent || Date.now() < artifactRetryAt) return;
    const candidate = findResponseFileCandidate(expectedFilename);
    if (!candidate) return;
    artifactInFlight = true;
    const token = armedToken;
    try {
      const artifact = await readFileCandidate(candidate);
      if (armedToken !== token) return;
      const messageId = `artifact-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      artifactMessageId = messageId;
      post({
        type: artifact.text !== null ? "PATIENT_ORACLE_RESPONSE_ARTIFACT" : "PATIENT_ORACLE_RESPONSE_ARTIFACT_URL",
        messageId,
        executionToken: token,
        filename: expectedFilename,
        ...(artifact.text !== null ? { text: artifact.text } : { url: artifact.url })
      });
    } catch (error) {
      artifactInFlight = false;
      artifactRetryAt = Date.now() + ARTIFACT_RETRY_MS;
      const key = String(error?.message || error || "artifact read failed");
      if (artifactErrorKey !== key) {
        artifactErrorKey = key;
        post({ type: "PATIENT_ORACLE_ARTIFACT_ERROR", executionToken: token, error: key });
      }
    }
  }

  function handleAck(message) {
    if (message?.type !== "PATIENT_ORACLE_ACK" || !artifactMessageId || message.messageId !== artifactMessageId) return;
    artifactInFlight = false;
    artifactMessageId = null;
    if (message.ok) {
      artifactSent = true;
      const token = armedToken;
      disarm(token);
      return;
    }
    artifactRetryAt = Date.now() + ARTIFACT_RETRY_MS;
    if (!message.retryable) artifactErrorKey = String(message.error || "response handoff failed");
  }

  function disarm(token) {
    if (token && armedToken !== token) return;
    armedToken = null;
    expectedFilename = null;
    sawGenerating = false;
    idleSince = null;
    idleNotified = false;
    hardStopAtMs = null;
    artifactInFlight = false;
    artifactSent = false;
    artifactMessageId = null;
    artifactRetryAt = 0;
    artifactErrorKey = null;
    clearTimers();
  }

  function clearTimers() {
    if (checkpointTimer) clearTimeout(checkpointTimer);
    if (hardStopTimer) clearTimeout(hardStopTimer);
    checkpointTimer = null;
    hardStopTimer = null;
  }

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

  function post(message) {
    if (!port) connect();
    try { port?.postMessage(message); } catch { port = null; connect(); }
  }

  function findResponseFileCandidate(filename) {
    const wanted = normalizeText(filename).toLowerCase();
    const nodes = document.querySelectorAll('a[href], a[download], [role="link"][href]');
    for (const node of nodes) {
      const labels = [
        node.getAttribute("download"),
        node.getAttribute("title"),
        node.getAttribute("aria-label"),
        node.textContent,
        filenameFromUrl(node.getAttribute("href"))
      ].map((value) => normalizeText(value).toLowerCase()).filter(Boolean);
      if (labels.some((label) => label === wanted || label.endsWith(`/${wanted}`) || label.includes(wanted))) return node;
    }
    return null;
  }

  async function readFileCandidate(node) {
    const urls = candidateUrls(node);
    if (!urls.length) throw new Error(`Found ${expectedFilename} but no readable file URL was exposed`);
    let lastError = null;
    for (const url of urls) {
      try {
        if (url.startsWith("sandbox:")) throw new Error("ChatGPT exposed only a sandbox URL; no fetchable download URL was available");
        const response = await fetch(url, { method: "GET", credentials: "include", cache: "no-store" });
        if (!response.ok) throw new Error(`response file fetch failed with HTTP ${response.status}`);
        const text = await response.text();
        if (!text.trim()) throw new Error("response file was empty");
        return { text, url: null };
      } catch (error) {
        lastError = error;
      }
    }
    const httpFallback = urls.find((url) => /^https?:/i.test(url));
    if (httpFallback) return { text: null, url: httpFallback };
    throw lastError || new Error("Could not read generated Patient Oracle response file");
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
    add(node.getAttribute("href"));
    for (const attr of ["data-download-url", "data-file-url", "data-url", "data-href"]) add(node.getAttribute(attr));
    let parent = node.parentElement;
    for (let depth = 0; parent && depth < 4; depth += 1, parent = parent.parentElement) {
      for (const attr of ["data-download-url", "data-file-url", "data-url", "data-href"]) add(parent.getAttribute(attr));
      const anchor = parent.querySelector?.("a[href]");
      if (anchor) add(anchor.getAttribute("href"));
    }
    return values;
  }

  function filenameFromUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      const url = raw.startsWith("sandbox:") ? raw.replace(/^sandbox:/, "https://sandbox.invalid") : new URL(raw, location.href).href;
      return decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
    } catch { return ""; }
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
    return composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement ? composer.value || "" : composer.textContent || "";
  }

  function writeComposer(composer, text) {
    composer.focus();
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      const prototype = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (!setter) throw new Error("composer value setter unavailable");
      setter.call(composer, text);
      emitInput(composer, text);
      return;
    }
    if (composer.getAttribute("contenteditable") === "true") {
      composer.replaceChildren();
      const paragraph = document.createElement("p");
      paragraph.textContent = text;
      composer.appendChild(paragraph);
      emitInput(composer, text);
      return;
    }
    throw new Error("unsupported ChatGPT composer element");
  }

  function emitInput(composer, text) {
    if (typeof InputEvent === "function") composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    else composer.dispatchEvent(new Event("input", { bubbles: true }));
    composer.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function waitForComposerText(expected, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const composer = findComposer();
      if (composer && readComposer(composer).trim().includes(expected.trim())) return true;
      await sleep(100);
    }
    return false;
  }

  function findSendButton() {
    const composer = findComposer();
    const form = composer?.closest("form");
    for (const selector of ['button[data-testid="send-button"]', 'button[aria-label*="Send"]', 'button[aria-label*="send"]', 'button[aria-label*="전송"]', 'button[type="submit"]']) {
      const button = form?.querySelector(selector) || document.querySelector(selector);
      if (button && !button.disabled && button.getAttribute("aria-disabled") !== "true") return button;
    }
    return null;
  }

  async function waitForSendButton(timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const button = findSendButton();
      if (button) return button;
      await sleep(100);
    }
    return null;
  }

  function dispatchEnter(composer) {
    composer.focus();
    const options = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    composer.dispatchEvent(new KeyboardEvent("keydown", options));
    composer.dispatchEvent(new KeyboardEvent("keyup", options));
  }

  async function waitForDispatchEvidence(timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const composer = findComposer();
      if (!composer || !readComposer(composer).trim() || !isChatIdle()) return true;
      await sleep(100);
    }
    return false;
  }

  function findStopButton() {
    for (const selector of ['button[data-testid="stop-button"]', 'button[aria-label*="Stop"]', 'button[aria-label*="stop"]', 'button[aria-label*="중지"]']) {
      const button = document.querySelector(selector);
      if (button) return button;
    }
    return null;
  }

  function isChatIdle() { return !findStopButton(); }

  function findGitHubApprovalCard() {
    for (const button of document.querySelectorAll("button")) {
      const buttonText = normalizeText(`${button.textContent || ""} ${button.getAttribute("aria-label") || ""}`);
      if (!/^(허용(?:하기)?|Allow)(?:\s|$)/i.test(buttonText)) continue;
      let node = button;
      for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
        const text = normalizeText(node.textContent);
        if (text.length > 1800 || !/GitHub/i.test(text)) continue;
        if (/ChatGPT가\s*GitHub.*사용하도록\s*허용할까요/i.test(text) || /allow\s+ChatGPT\s+to\s+use\s+GitHub/i.test(text)) return node;
      }
    }
    return null;
  }

  function normalizeText(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
})();
