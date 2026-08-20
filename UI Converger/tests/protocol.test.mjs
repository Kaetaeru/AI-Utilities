import test from "node:test";
import assert from "node:assert/strict";
import { parseBlueprint, parsePatchAnswer, normalizePatchPath } from "../src/protocol.mjs";

test("parseBlueprint accepts UI Blueprint documents", () => {
  const value = parseBlueprint(JSON.stringify({ schema: "uib/0.2", screens: [{ id: "screen_1" }] }));
  assert.equal(value.schema, "uib/0.2");
});

test("parsePatchAnswer accepts complete replacement files", () => {
  const patch = parsePatchAnswer(JSON.stringify({
    version: 1,
    diagnosis: ["spacing"],
    summary: "Tighten layout",
    files: [{ path: "src/App.jsx", content: "export default function App(){}\n" }],
    expected_effect: ["closer spacing"]
  }));
  assert.equal(patch.files[0].path, "src/App.jsx");
});

test("normalizePatchPath rejects traversal and reserved paths", () => {
  assert.throws(() => normalizePatchPath("../secret"), /Unsafe patch path/);
  assert.throws(() => normalizePatchPath(".git/config"), /Reserved patch path/);
  assert.equal(normalizePatchPath("src\\App.tsx"), "src/App.tsx");
});
