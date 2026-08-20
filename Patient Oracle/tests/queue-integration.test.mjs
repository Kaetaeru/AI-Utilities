import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const caller = await readFile(new URL("../caller.mjs", import.meta.url), "utf8");
const worker = await readFile(new URL("../queue-worker.js", import.meta.url), "utf8");
const wrapper = await readFile(new URL("../sidepanel-background.js", import.meta.url), "utf8");

test("caller no longer rejects enqueue while runtime is busy", () => {
  assert.doesNotMatch(caller, /only complete accepts a new request/);
  assert.match(caller, /appendToQueue/);
  assert.match(caller, /tryActivateQueueHead/);
  assert.match(caller, /queue_position/);
});

test("caller queue writes use SHA conflict retries", () => {
  assert.match(caller, /MAX_QUEUE_CAS_ATTEMPTS/);
  assert.match(caller, /isConflict\(error\)/);
  assert.match(caller, /file\?\.sha \|\| null/);
});

test("server worker activates only one FIFO head at a time", () => {
  assert.match(worker, /if \(runtime\.status === "ready"\)/);
  assert.match(worker, /const head = queue\.items\[0\]/);
  assert.match(worker, /status: "ready"/);
  assert.match(worker, /activated from Patient Oracle FIFO queue/);
});

test("server worker writes runtime before dequeue cleanup", () => {
  const runtimeWrite = worker.indexOf("await putGitHubJson(server.config, server.config.path, nextRuntime");
  const dequeue = worker.indexOf("const cleanup = await removeQueuedRequest");
  assert.ok(runtimeWrite >= 0 && dequeue > runtimeWrite);
});

test("queue worker is loaded by the extension service worker", () => {
  assert.match(wrapper, /import "\.\/queue-worker\.js"/);
});
