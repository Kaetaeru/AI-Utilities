import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = await readFile(path.resolve(here, "../popup.js"), "utf8");

test("explicit Start recovers an already-dispatched ready revision safely", () => {
  assert.match(source, /recoverAlreadyDispatchedReadyRevision/);
  assert.match(source, /runtime\.revision \+ 1/);
  assert.match(source, /manual retry requested after interrupted local execution/);
  assert.match(source, /if \(runtime\.revision > lastDispatchedRevision\) return/);
});

test("manual retry uses SHA-protected GitHub runtime update", () => {
  assert.match(source, /sha\n  }/);
  assert.match(source, /method: "PUT"/);
  assert.match(source, /could not verify the manual retry revision/);
});

test("token placeholders fail before HTTP header construction", () => {
  assert.match(source, /\[\^\\x21-\\x7E\]/);
  assert.match(source, /actual ASCII token value, not placeholder text/);
});
