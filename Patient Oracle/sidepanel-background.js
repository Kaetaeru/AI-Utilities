import "./background.js";
import "./server-mode.js";
import "./server-resilience.js";

async function enableActionSidePanel() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (error) {
    console.warn("Patient Oracle could not enable action-click Side Panel behavior", error);
  }
}

void enableActionSidePanel();
chrome.runtime.onInstalled.addListener(() => { void enableActionSidePanel(); });
chrome.runtime.onStartup.addListener(() => { void enableActionSidePanel(); });
