import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../server-mode.js", import.meta.url), "utf8");
const popup = await readFile(new URL("../popup.js", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
const wrapper = await readFile(new URL("../sidepanel-background.js", import.meta.url), "utf8");

test("Server Mode uses a Chrome alarm watchdog and dedicated worker tab", () => {
  assert.ok(manifest.permissions.includes("alarms"));
  assert.match(server, /patient-oracle-server-watchdog/);
  assert.match(server, /chrome\.alarms\.onAlarm/);
  assert.match(server, /chrome\.tabs\.create\(\{ url: SERVER_URL, active: false, pinned: true \}\)/);
  assert.match(server, /autoDiscardable: false/);
});

test("Server Mode survives worker tab closure and restores tab-scoped config", () => {
  assert.match(server, /handleWorkerTabRemoved/);
  assert.match(server, /ensureServerWorker\("worker_tab_closed"\)/);
  assert.match(server, /configKey\(tab\.id\)/);
  assert.match(server, /stateKey\(tab\.id\)/);
  assert.match(wrapper, /import "\.\/server-mode\.js"/);
});

test("interrupted ready revision is recovered with a higher SHA-protected revision", () => {
  assert.match(server, /runtime\.revision \+ 1/);
  assert.match(server, /server recovery after browser or worker-tab interruption/);
  assert.match(server, /sha\n  }/);
  assert.match(server, /could not verify the server recovery revision/);
});

test("Side Panel can opt into persistent Server Mode independently of Start Stop", () => {
  assert.match(popup, /SERVER_CONFIG_KEY/);
  assert.match(popup, /enableServerMode/);
  assert.match(popup, /applyServerModePreference/);
  assert.match(popup, /USER_INTENT_KEY/);
  assert.doesNotMatch(popup, /disableServerModeForThisTab/);
  assert.match(popup, /pinned: true, autoDiscardable: false/);
});

test("server recovery finalizes an already durable response instead of rerunning it", () => {
  assert.match(server, /responsePath\(runtime\.request_id\)/);
  assert.match(server, /server recovery found durable response artifact/);
  assert.match(server, /could not verify terminal recovery from durable response/);
});
