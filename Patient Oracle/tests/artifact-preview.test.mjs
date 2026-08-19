import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../artifact-preview.js", import.meta.url), "utf8");

test("preview fallback is restricted to the exact response artifact identity", () => {
  assert.match(source, /requestIdFromFilename/);
  assert.match(source, /value\.version !== 1/);
  assert.match(source, /value\.request_id/);
  assert.match(source, /complete.*needs_user.*blocked.*continue/);
});

test("preview fallback opens an exact file card only after generation is idle", () => {
  assert.match(source, /if \(!isChatIdle\(\)\) return/);
  assert.match(source, /findFileCard\(expectedFilename\)/);
  assert.match(source, /clickTarget\.click\(\)/);
  assert.match(source, /no readable JSON preview appeared/);
});

test("preview extraction avoids ordinary assistant-message text", () => {
  assert.match(source, /data-message-author-role/);
  assert.match(source, /\[role=\"dialog\"\]/);
  assert.match(source, /balancedObjectEnd/);
});
