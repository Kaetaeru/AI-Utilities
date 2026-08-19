import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, createNode, makeAiHandoff, sanitizeDocument, SCHEMA_VERSION } from '../src/model.js';
import { screenToSvg, safeFileName } from '../src/export.js';

test('createDocument produces a usable uib/0.1 document', () => {
  const document = createDocument({ name: 'Test' });
  assert.equal(document.schema, SCHEMA_VERSION);
  assert.equal(document.name, 'Test');
  assert.equal(document.screens.length, 1);
  assert.equal(document.screens[0].width, 1440);
  assert.ok(Array.isArray(document.components));
  assert.ok(Array.isArray(document.flows));
});

test('createNode keeps primitive type separate from semantic role', () => {
  const node = createNode('box', { x: 10, y: 20, width: 100, height: 40 }, { role: 'action.primary', text: 'Save' });
  assert.equal(node.type, 'box');
  assert.equal(node.role, 'action.primary');
  assert.equal(node.text, 'Save');
  assert.deepEqual(node.bounds, { x: 10, y: 20, width: 100, height: 40 });
});

test('sanitizeDocument restores missing optional structure and clamps invalid sizes', () => {
  const document = sanitizeDocument({
    name: 'Import',
    screens: [{ name: 'Tiny', width: 1, height: 10, nodes: [{ type: 'unknown', bounds: { width: -10, height: 0 } }] }]
  });
  assert.equal(document.screens[0].width, 240);
  assert.equal(document.screens[0].height, 240);
  assert.equal(document.screens[0].nodes[0].type, 'box');
  assert.equal(document.screens[0].nodes[0].bounds.width, 1);
  assert.ok(document.tokens);
});

test('AI handoff includes visible intent and omits hidden nodes', () => {
  const document = createDocument({ name: 'Handoff' });
  const screen = document.screens[0];
  screen.nodes.push(createNode('box', { x: 8, y: 16, width: 120, height: 48 }, { name: 'Primary', role: 'action.primary', text: 'Go', note: 'Important' }));
  const hidden = createNode('text', { x: 0, y: 0, width: 20, height: 20 }, { text: 'Secret' });
  hidden.hidden = true;
  screen.nodes.push(hidden);
  const handoff = makeAiHandoff(document, screen.id);
  assert.match(handoff, /action\.primary/);
  assert.match(handoff, /Important/);
  assert.doesNotMatch(handoff, /Secret/);
  assert.match(handoff, /Treat bounds, text, hierarchy/);
});

test('SVG export preserves screen dimensions and escapes text', () => {
  const document = createDocument();
  const screen = document.screens[0];
  screen.nodes.push(createNode('box', { x: 1, y: 2, width: 100, height: 40 }, { text: '<Save & close>' }));
  const svg = screenToSvg(screen);
  assert.match(svg, /width="1440"/);
  assert.match(svg, /&lt;Save &amp; close&gt;/);
  assert.doesNotMatch(svg, /<Save & close>/);
});

test('safeFileName removes filesystem-hostile characters', () => {
  assert.equal(safeFileName('My UI: Home/Settings'), 'My-UI-Home-Settings');
});
