import { DEFAULT_STATE, stateKey } from "./control.js";

const SERVER_CONFIG_KEY = "patientOracleServerConfig";
const RETRYABLE_STOP_REASONS = new Set([
  "dispatch_failed",
  "20_minute_hard_stop"
]);
const repairInFlight = new Set();

void enforceConfiguredWorker("initialize");
chrome.runtime.onStartup.addListener(() => { void enforceConfiguredWorker("chrome_startup"); });
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[SERVER_CONFIG_KEY]?.newValue?.enabled) void enforceConfiguredWorker("server_config_enabled");
  for (const [key, change] of Object.entries(changes)) {
    if (!key.startsWith("patientOracleState:")) continue;
    const tabId = Number(key.slice("patientOracleState:".length));
    if (!Number.isSafeInteger(tabId) || change.newValue?.enabled !== false) continue;
    void protectServerWorker(tabId, change.newValue, "state_disabled");
  }
});

async function enforceConfiguredWorker(trigger) {
  const stored = await chrome.storage.local.get(SERVER_CONFIG_KEY);
  const server = normalizeServerConfig(stored[SERVER_CONFIG_KEY]);
  if (!server.enabled || !Number.isSafeInteger(server.workerTabId)) return { action: "disabled", trigger };
  const stateStore = await chrome.storage.local.get(stateKey(server.workerTabId));
  const state = stateStore[stateKey(server.workerTabId)];
  if (!state || state.enabled !== false) return { action: "healthy", trigger };
  return protectServerWorker(server.workerTabId, state, trigger);
}

async function protectServerWorker(tabId, stoppedState, trigger) {
  if (repairInFlight.has(tabId)) return { action: "repair_in_flight", trigger };
  repairInFlight.add(tabId);
  try {
    const stored = await chrome.storage.local.get([SERVER_CONFIG_KEY, stateKey(tabId)]);
    const server = normalizeServerConfig(stored[SERVER_CONFIG_KEY]);
    if (!server.enabled || server.workerTabId !== tabId) return { action: "not_server_worker", trigger };

    const current = { ...DEFAULT_STATE, ...(stored[stateKey(tabId)] || stoppedState || {}) };
    if (current.enabled) return { action: "already_enabled", trigger };
    if (current.stopReason === "manual") return { action: "manual_stop", trigger };

    const stopReason = String(current.stopReason || "unexpected_stop");
    const retryable = RETRYABLE_STOP_REASONS.has(stopReason);
    const status = retryable ? "waiting_for_dispatch_retry" : "needs_user";
    const reason = retryable
      ? `Server Mode kept Patient Oracle started after ${stopReason}; automatic recovery remains active.`
      : `Server Mode kept Patient Oracle started after ${stopReason}; intervention may be required, but the server watchdog remains enabled.`;

    const repaired = {
      ...current,
      enabled: true,
      dispatching: false,
      executing: false,
      finalizing: false,
      executionToken: null,
      expectedResponseFilename: null,
      executionStartedAt: null,
      checkpointAt: null,
      executionHardStopAt: null,
      stopReason: null,
      lastStatus: status,
      lastReason: reason
    };
    await chrome.storage.local.set({ [stateKey(tabId)]: repaired });

    if (stopReason === "20_minute_hard_stop") {
      setTimeout(() => { void recycleWorkerTab(tabId); }, 750);
    }
    return { action: "re_enabled", stopReason, retryable, trigger };
  } finally {
    repairInFlight.delete(tabId);
  }
}

async function recycleWorkerTab(tabId) {
  const stored = await chrome.storage.local.get(SERVER_CONFIG_KEY);
  const server = normalizeServerConfig(stored[SERVER_CONFIG_KEY]);
  if (!server.enabled || server.workerTabId !== tabId) return;
  try { await chrome.tabs.remove(tabId); } catch {}
}

function normalizeServerConfig(value) {
  const workerTabId = Number(value?.workerTabId);
  return {
    enabled: Boolean(value?.enabled),
    workerTabId: Number.isSafeInteger(workerTabId) ? workerTabId : null
  };
}
