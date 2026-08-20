import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const popup = await readFile(new URL("../popup.js", import.meta.url), "utf8");
const resilience = await readFile(new URL("../server-resilience.js", import.meta.url), "utf8");

test("Start Stop button is rendered only from explicit user intent", () => {
  assert.match(popup, /USER_INTENT_KEY = "patientOracleUserIntent"/);
  assert.match(popup, /ui\.toggle\.textContent = intent\.started \? "Stop Oracle" : "Start Oracle"/);
  assert.doesNotMatch(popup, /ui\.toggle\.textContent = state\.enabled/);
});

test("toggle changes user intent before operational start or stop", () => {
  assert.match(popup, /if \(intent\.started\) \{\s*await setUserIntent\(false\);\s*await request\("PATIENT_ORACLE_STOP"\)/s);
  assert.match(popup, /await setUserIntent\(true\);\s*const desiredConfig/s);
  assert.match(popup, /Never change user intent here/);
});

test("operational failures cannot mutate the user latch", () => {
  const setterCalls = [...popup.matchAll(/setUserIntent\(/g)].length;
  assert.equal(setterCalls, 3);
  assert.doesNotMatch(resilience, /\[USER_INTENT_KEY\]\s*:/);
});

test("server resilience is gated by user Start intent", () => {
  assert.match(resilience, /if \(!intent\.started\) return \{ action: "user_stopped", trigger \}/);
  assert.match(resilience, /User Start remains latched/);
  assert.match(resilience, /!intent\.started\) return/);
});
