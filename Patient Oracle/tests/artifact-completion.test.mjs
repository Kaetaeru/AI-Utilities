import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const content = await readFile(new URL("../content.js", import.meta.url), "utf8");
const popup = await readFile(new URL("../popup.js", import.meta.url), "utf8");

test("generated response discovery covers file cards beyond anchors", () => {
  assert.match(content, /"button"/);
  assert.match(content, /\[role=\\?"button\\?"\]/);
  assert.match(content, /data-file-url/);
  assert.match(content, /data-download-url/);
  assert.match(content, /elementMentionsFilename/);
});

test("turn idle detection does not depend only on the stop button", () => {
  assert.match(content, /MIN_IDLE_NOTIFY_AFTER_DISPATCH_MS/);
  assert.match(content, /dispatchConfirmedAtMs/);
  assert.match(content, /dispatchOldEnough/);
});

test("side panel exposes the post-turn response-file wait state", () => {
  assert.match(popup, /Waiting for response file/);
  assert.match(popup, /state\.lastStatus === "waiting_for_response_file"/);
  assert.match(popup, /Finalizing/);
});
