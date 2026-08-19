import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDocument,
  createNode,
  getDescendantIds,
  makeAiHandoff,
  reconcileHierarchy,
  sanitizeDocument,
  SCHEMA_VERSION
} from '../src/model.js';
import { screenToSvg, safeFileName } from '../src/export.js';

test('createDocument produces a usable current schema document', () => {
  const document = createDocument({ name: 'Test' });
  assert.equal(document.schema, SCHEMA_VERSION);
  assert.equal(document.schema, 'uib/0.2');
  assert.equal(document.name, 'Test');
  assert.equal(document.screens.length, 1);
  assert.equal(document.screens[0].width, 1440);
});

test('button is a dedicated primitive with useful defaults', () => {
  const node = createNode('button', { x: 10, y: 20, width: 120, height: 40 }, { text: 'Save' });
  assert.equal(node.type, 'button');
  assert.equal(node.role, 'action.button');
  assert.equal(node.text, 'Save');
  assert.equal(node.style.textAlign, 'center');
  assert.equal(node.style.verticalAlign, 'center');
  assert.equal(node.style.fontWeight, 600);
});

test('box keeps primitive type separate from semantic role', () => {
  const node = createNode('box', { x: 10, y: 20, width: 100, height: 40 }, { role: 'input.field', text: 'Name' });
  assert.equal(node.type, 'box');
  assert.equal(node.role, 'input.field');
  assert.deepEqual(node.bounds, { x: 10, y: 20, width: 100, height: 40 });
});

test('sanitizeDocument upgrades older documents and restores appearance defaults', () => {
  const document = sanitizeDocument({
    schema: 'uib/0.1',
    name: 'Import',
    screens: [{ name: 'Tiny', width: 1, height: 10, nodes: [{ type: 'box', bounds: { width: 100, height: 40 }, style: { fill: '#ffffff' } }] }]
  });
  assert.equal(document.schema, 'uib/0.2');
  assert.equal(document.screens[0].width, 240);
  assert.equal(document.screens[0].height, 240);
  assert.equal(document.screens[0].nodes[0].style.fontWeight, 500);
  assert.equal(document.screens[0].nodes[0].style.borderStyle, 'solid');
});

test('frames become real hierarchy containers by geometry', () => {
  const document = createDocument();
  const screen = document.screens[0];
  const frame = createNode('frame', { x: 100, y: 100, width: 500, height: 400 }, { name: 'Main Frame' });
  const box = createNode('box', { x: 140, y: 160, width: 180, height: 80 }, { name: 'Card' });
  const outside = createNode('text', { x: 900, y: 200, width: 160, height: 32 }, { name: 'Outside' });
  screen.nodes.push(frame, box, outside);
  reconcileHierarchy(screen);
  assert.equal(box.parentId, frame.id);
  assert.equal(outside.parentId, null);
});

test('nested frame descendants are discoverable for group movement', () => {
  const document = createDocument();
  const screen = document.screens[0];
  const outer = createNode('frame', { x: 50, y: 50, width: 700, height: 600 }, { name: 'Outer' });
  const inner = createNode('frame', { x: 100, y: 100, width: 300, height: 250 }, { name: 'Inner' });
  const button = createNode('button', { x: 130, y: 150, width: 120, height: 40 }, { name: 'Action' });
  screen.nodes.push(outer, inner, button);
  reconcileHierarchy(screen);
  assert.equal(inner.parentId, outer.id);
  assert.equal(button.parentId, inner.id);
  assert.deepEqual(new Set(getDescendantIds(screen, outer.id)), new Set([inner.id, button.id]));
});

test('AI handoff includes hierarchy, button intent, and detailed style', () => {
  const document = createDocument({ name: 'Handoff' });
  const screen = document.screens[0];
  const frame = createNode('frame', { x: 8, y: 8, width: 400, height: 300 }, { name: 'Panel' });
  const button = createNode('button', { x: 32, y: 40, width: 120, height: 48 }, { name: 'Primary', role: 'action.primary', text: 'Go', note: 'Important' });
  screen.nodes.push(frame, button);
  reconcileHierarchy(screen);
  const handoff = makeAiHandoff(document, screen.id);
  assert.match(handoff, /action\.primary/);
  assert.match(handoff, /parentId/);
  assert.match(handoff, /fontWeight/);
  assert.match(handoff, /Frames are containers/);
});

test('SVG export preserves detailed typography and frame dash', () => {
  const document = createDocument();
  const screen = document.screens[0];
  screen.nodes.push(createNode('frame', { x: 1, y: 2, width: 300, height: 200 }, { name: 'Shell' }));
  screen.nodes.push(createNode('button', { x: 20, y: 30, width: 120, height: 44 }, { text: '<Save & close>' }));
  const svg = screenToSvg(screen);
  assert.match(svg, /stroke-dasharray/);
  assert.match(svg, /font-weight="600"/);
  assert.match(svg, /&lt;Save &amp; close&gt;/);
});

test('safeFileName removes filesystem-hostile characters', () => {
  assert.equal(safeFileName('My UI: Home/Settings'), 'My-UI-Home-Settings');
});
