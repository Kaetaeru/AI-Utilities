import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const background = await readFile(new URL("../background.js", import.meta.url), "utf8");
const content = await readFile(new URL("../content.js", import.meta.url), "utf8");

test("composer draft and approval blocks keep Patient Oracle waiting", () => {
  assert.match(background, /waiting_for_empty_composer/);
  assert.match(background, /waiting_for_github_approval/);
  assert.match(background, /keepOracleWaitingOnRecoverableBlock/);
  assert.match(background, /enabled:\s*true,[\s\S]*dispatching:\s*false,[\s\S]*executing:\s*false/);
});

test("content script emits structured recoverable dispatch codes", () => {
  assert.match(content, /composer_not_empty/);
  assert.match(content, /approval_pending/);
  assert.match(content, /chat_busy/);
  assert.match(content, /code:\s*String\(error\?\.code/);
});
