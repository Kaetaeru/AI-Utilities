import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const background = await readFile(new URL("../background.js", import.meta.url), "utf8");
const content = await readFile(new URL("../content.js", import.meta.url), "utf8");
const contract = await readFile(new URL("../CONTRACT.md", import.meta.url), "utf8");

test("background finalizes response before authoritative runtime write", () => {
  const responseWrite = background.indexOf("putJsonIdempotent(tabId, config, path, durable");
  const runtimeWrite = background.indexOf("putGitHubJson(tabId, config, config.path, nextRuntime", responseWrite);
  assert.ok(responseWrite >= 0);
  assert.ok(runtimeWrite > responseWrite);
});

test("bootstrap is extension-owned and no longer dispatches a ChatGPT GitHub bootstrap prompt", () => {
  assert.match(background, /bootstrapRepository/);
  assert.match(background, /loadBundledContract/);
  assert.doesNotMatch(background, /buildBootstrapPrompt/);
});

test("content script transfers only the generated response file, not assistant prose", () => {
  assert.match(content, /PATIENT_ORACLE_RESPONSE_ARTIFACT/);
  assert.match(content, /findResponseFileCandidate/);
  assert.doesNotMatch(content, /querySelectorAll\([^\n]*assistant[^\n]*textContent/i);
});

test("contract makes generated files transient and GitHub durable", () => {
  assert.match(contract, /GitHub is the only durable source of truth/);
  assert.match(contract, /generated-file links are disposable/);
  assert.match(contract, /extension is the only component that reads and writes GitHub/);
  assert.match(contract, /assistant message text is ignored/);
});
