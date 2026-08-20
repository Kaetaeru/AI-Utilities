import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const resilience = await readFile(new URL("../server-resilience.js", import.meta.url), "utf8");
const content = await readFile(new URL("../content.js", import.meta.url), "utf8");

test("Server Mode re-enables any non-manual local stop", () => {
  assert.match(resilience, /change\.newValue\?\.enabled !== false/);
  assert.match(resilience, /current\.stopReason === "manual"/);
  assert.match(resilience, /enabled: true/);
  assert.match(resilience, /server watchdog remains enabled/);
});

test("dispatch and hard-stop failures are automatic recovery states", () => {
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
