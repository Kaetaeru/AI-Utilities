import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../artifact-preview-v2.js", import.meta.url), "utf8");

test("preview v2 accepts newly opened validated preview nodes", () => {
  assert.match(source, /const isNew = !baseline\.has\(node\)/);
  assert.match(source, /filenameNearby\(node\)/);
  assert.doesNotMatch(source, /data-message-author-role/);
});

test("preview v2 does not skip preview because a URL-looking descendant exists", () => {
  assert.match(source, /findExactFileCard/);
  assert.match(source, /clickTarget\.click\(\)/);
  assert.doesNotMatch(source, /hasDirectFetchUrl/);
});

test("preview v2 validates the exact request before handoff", () => {
  assert.match(source, /String\(value\.request_id \|\| ""\)\.trim\(\) !== requestId/);
  assert.match(source, /PATIENT_ORACLE_RESPONSE_ARTIFACT/);
});
