import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const resilience = await readFile(new URL("../server-resilience.js", import.meta.url), "utf8");
const content = await readFile(new URL("../content.js", import.meta.url), "utf8");
const popup = await readFile(new URL("../popup.js", import.meta.url), "utf8");

test("Start Stop UI is controlled by explicit user intent, not worker enabled state", () => {
  assert.match(popup, /USER_INTENT_KEY = "patientOracleUserIntent"/);
  assert.match(popup, /ui\.toggle\.textContent = intent\.started \? "Stop Oracle" : "Start Oracle"/);
  assert.doesNotMatch(popup, /ui\.toggle\.textContent = state\.enabled/);
  assert.match(popup, /await setUserIntent\(true\)/);
  assert.match(popup, /await setUserIntent\(false\)/);
});

test("Server Mode operational recovery is gated by the user Start latch", () => {
  assert.match(resilience, /USER_INTENT_KEY = "patientOracleUserIntent"/);
  assert.match(resilience, /if \(!intent\.started\) return \{ action: "user_stopped", trigger \}/);
  assert.match(resilience, /enabled: true/);
  assert.match(resilience, /User Start remains latched/);
  assert.doesNotMatch(resilience, /\[USER_INTENT_KEY\]\s*:/);
});

test("dispatch and hard-stop failures are operational recovery states", () => {
  assert.match(resilience, /"dispatch_failed"/);
  assert.match(resilience, /"20_minute_hard_stop"/);
  assert.match(resilience, /waiting_for_dispatch_retry/);
  assert.match(resilience, /recycleWorkerTab/);
});

test("composer synchronization has a longer resilient path and explicit error code", () => {
  assert.match(content, /synchronizeComposerPrompt\(prompt, 7000\)/);
  assert.match(content, /composer_sync_failed/);
  assert.match(content, /document\.execCommand\("insertText"/);
  assert.match(content, /composerContainsExpected/);
});

test("prompt submission failure is distinguishable from composer synchronization", () => {
  assert.match(content, /dispatch_evidence_failed/);
  assert.match(content, /waitForDispatchEvidence\(5000\)/);
});
