import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

async function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

test("manifest uses a persistent Side Panel instead of a popup", async () => {
  const manifest = JSON.parse(await read("manifest.json"));
  assert.ok(manifest.permissions.includes("sidePanel"));
  assert.equal(manifest.action.default_popup, undefined);
  assert.equal(manifest.side_panel?.default_path, "popup.html");
  assert.equal(manifest.background?.service_worker, "sidepanel-background.js");
});

test("toolbar action is configured to open the Side Panel", async () => {
  const source = await read("sidepanel-background.js");
  assert.match(source, /setPanelBehavior/);
  assert.match(source, /openPanelOnActionClick:\s*true/);
  assert.match(source, /import\s+["']\.\/background\.js["']/);
});

test("panel UI is responsive and no longer popup-width locked", async () => {
  const html = await read("popup.html");
  assert.doesNotMatch(html, /width:\s*360px/);
  assert.match(html, /Side Panel/);
});
