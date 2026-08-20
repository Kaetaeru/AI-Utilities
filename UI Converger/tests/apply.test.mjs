import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createSessionBranch, applyPatchAndCommit } from "../src/apply.mjs";

const execFileAsync = promisify(execFile);

test("applyPatchAndCommit creates a reversible iteration commit", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ui-converger-test-"));
  await git(dir, ["init"]);
  await git(dir, ["config", "user.name", "UI Converger Test"]);
  await git(dir, ["config", "user.email", "ui-converger@example.test"]);
  await fs.mkdir(path.join(dir, "src"));
  await fs.writeFile(path.join(dir, "src", "App.js"), "export const value = 1;\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "initial"]);
  const branch = await createSessionBranch(dir, "test-session");
  assert.equal(branch, "ui-converger/test-session");
  const result = await applyPatchAndCommit(dir, {
    files: [{ path: "src/App.js", content: "export const value = 2;\n" }]
  }, { iteration: 1 });
  assert.equal(result.changed[0], "src/App.js");
  assert.match(await fs.readFile(path.join(dir, "src", "App.js"), "utf8"), /value = 2/);
  const subject = (await git(dir, ["log", "-1", "--pretty=%s"])).trim();
  assert.equal(subject, "ui-converger: iteration 1");
});

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}
