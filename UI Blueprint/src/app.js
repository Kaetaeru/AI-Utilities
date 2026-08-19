import {
  createDocument,
  createNode,
  createScreen,
  getActiveScreen,
  getDescendantIds,
  makeAiHandoff,
  reconcileHierarchy,
  sanitizeDocument
} from './model.js';
import { downloadText, safeFileName, screenToSvg, svgToPngBlob, downloadBlob } from './export.js';
import { loadAutosave, saveAutosave } from './storage.js';

const $ = (q) => document.querySelector(q);
const $$ = (q) => [...document.querySelectorAll(q)];
const E = {
  title: $('#document-title'), stage: $('#stage'), shell: $('#artboard-shell'), board: $('#artboard'), preview: $('#draw-preview'),
  screens: $('#screen-list'), layers: $('#layer-list'), count: $('#layer-count'), inspector: $('#inspector'), hint: $('#status-hint'),
  zoom: $('#zoom-label'), grid: $('#toggle-grid'), tooltip: $('#tooltip'), tipTitle: $('#tooltip-title'), tipBody: $('#tooltip-body'),
  toast: $('#toast'), file: $('#file-input')
};

const saved = loadAutosave();
let doc;
try { doc = saved?.document ? sanitizeDocument(saved.document) : createDocument(); } catch { doc = createDocument(); }

const S = {
  doc,
  screenId: saved?.activeScreenId || doc.screens[0].id,
  selected: null,
  tool: 'select',
  zoom: 0.65,
  grid: true,
  snap: 8,
  history: [],
  future: [],
  gesture: null,
  pan: null,
  space: false,
  tipTimer: null
};

const HINT = {
  select: 'Select - move directly, resize with the 8 handles, Enter edits text.',
  frame: 'Frame - draw a large container. Nodes inside become children and move with it.',
  box: 'Box - draw a generic UI surface such as a card, field, panel, or custom control.',
  button: 'Button - draw a button primitive with editable label and appearance.',
  text: 'Text - draw standalone text and tune typography in the Inspector.',
  image: 'Image - draw an asset placeholder.'
};

const DRAW_DEFAULTS = {
  frame: [480, 320], box: [200, 112], button: [144, 44], text: [200, 40], image: [240, 160]
};
const HANDLE_DIRECTIONS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const esc = (value = '') => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const screen = () => getActiveScreen(S.doc, S.screenId);
const node = () => screen().nodes.find((item) => item.id === S.selected) || null;
const snap = (value) => S.grid ? Math.round(value / S.snap) * S.snap : Math.round(value);
const persist = () => saveAutosave(S.doc, S.screenId);

function toast(text) {
  E.toast.textContent = text;
  E.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { E.toast.hidden = true; }, 1400);
}

function status(text) { E.hint.textContent = text || HINT[S.tool]; }
function snapshot() {
  S.history.push(structuredClone(S.doc));
  if (S.history.length > 80) S.history.shift();
  S.future = [];
}
function touch() { S.doc.updatedAt = new Date().toISOString(); persist(); }
function change(fn) { snapshot(); fn(); touch(); render(); }
function undo() {
  if (!S.history.length) return;
  S.future.push(structuredClone(S.doc));
  S.doc = S.history.pop();
  S.selected = null;
  persist();
  render();
  toast('Undo');
}
function redo() {
  if (!S.future.length) return;
  S.history.push(structuredClone(S.doc));
  S.doc = S.future.pop();
  S.selected = null;
  persist();
  render();
  toast('Redo');
}
function setTool(tool) {
  S.tool = tool;
  if (S.gesture?.kind === 'draw') S.gesture = null;
  E.preview.hidden = true;
  $$('.tool-button').forEach((button) => button.classList.toggle('active', button.dataset.tool === tool));
  E.stage.dataset.tool = tool;
  status();
}
function setZoom(value) {
  S.zoom = Math.max(0.1, Math.min(2.4, value));
  renderBoard();
  renderStatus();
}
function fit() {
  const active = screen();
  setZoom(Math.min(1, (E.stage.clientWidth - 144) / active.width, (E.stage.clientHeight - 144) / active.height));
}

function render() {
  E.title.value = S.doc.name;
  renderScreens();
  renderLayers();
  renderBoard();
  renderInspector();
  renderStatus();
  setTool(S.tool);
}

function renderScreens() {
  E.screens.innerHTML = S.doc.screens.map((item) => `
    <div class="screen-row ${item.id === S.screenId ? 'active' : ''}" data-screen="${esc(item.id)}" data-tooltip="${esc(item.name)}|${item.width} x ${item.height} - ${esc(item.platform)}">
      <span class="screen-icon">[]</span><span class="screen-name">${esc(item.name)}</span><span class="screen-size">${item.width}x${item.height}</span>
    </div>`).join('');
}

function nodeDepth(item) {
  let depth = 0;
  let parent = item.parentId;
  const seen = new Set();
  while (parent && !seen.has(parent) && depth < 12) {
    seen.add(parent);
    const next = screen().nodes.find((candidate) => candidate.id === parent);
    if (!next) break;
    depth += 1;
    parent = next.parentId;
  }
  return depth;
}

function renderLayers() {
  const active = screen();
  const icons = { frame: 'F', box: 'B', button: 'A', text: 'T', image: 'I' };
  E.count.textContent = active.nodes.length;
  E.layers.innerHTML = [...active.nodes].reverse().map((item) => {
    const depth = nodeDepth(item);
    const parent = item.parentId ? active.nodes.find((candidate) => candidate.id === item.parentId) : null;
    const parentText = parent ? ` - inside ${parent.name}` : '';
    return `<div class="layer-row ${S.selected === item.id ? 'selected' : ''} ${item.hidden ? 'hidden-layer' : ''} type-${item.type}" style="--depth:${depth}" data-node="${esc(item.id)}" data-tooltip="${esc(item.name)}|${esc(item.role || item.type)}${esc(parentText)}${item.note ? ' - ' + esc(item.note.slice(0, 80)) : ''}">
      <span class="layer-kind">${icons[item.type]}</span><span class="layer-name">${esc(item.name || item.text)}</span>
      <button class="layer-action ${item.hidden ? 'active' : ''}" data-hide="${esc(item.id)}" aria-label="Toggle visibility">${item.hidden ? 'o' : '*'}</button>
      <button class="layer-action ${item.locked ? 'active' : ''}" data-lock="${esc(item.id)}" aria-label="Toggle lock">${item.locked ? '#' : '-'}</button>
    </div>`;
  }).join('');
}

function shapeStyle(item) {
  const style = item.style || {};
  const isText = item.type === 'text';
  const vertical = style.verticalAlign === 'center' ? 'center' : style.verticalAlign === 'bottom' ? 'flex-end' : 'flex-start';
  return [
    `background:${isText ? 'transparent' : style.fill}`,
    `border:${isText ? '0' : `${Math.max(0, Number(style.borderWidth ?? 1))}px ${style.borderStyle || 'solid'} ${style.stroke}`}`,
    `border-radius:${Number(style.radius || 0)}px`,
    `color:${style.textColor}`,
    `font-size:${Number(style.fontSize || 14)}px`,
    `font-weight:${Number(style.fontWeight || 500)}`,
    `line-height:${Number(style.lineHeight || 1.25)}`,
    `text-align:${style.textAlign || 'left'}`,
    `align-items:${item.type === 'frame' ? 'flex-start' : vertical}`
  ].join(';');
}

function textStyle(item) {
  const style = item.style || {};
  const px = Math.max(0, Number(style.paddingX || 0));
  const py = Math.max(0, Number(style.paddingY || 0));
  return `padding:${py}px ${px}px;text-align:${style.textAlign || 'left'};`;
}

function gizmoMarkup(item) {
  if (item.locked) return '';
  return `${HANDLE_DIRECTIONS.map((handle) => `<span class="resize-handle handle-${handle}" data-resize="${esc(item.id)}" data-handle="${handle}" data-tooltip="Resize ${handle.toUpperCase()}|Drag this handle to resize from the ${handle.toUpperCase()} edge or corner."></span>`).join('')}
    <span class="selection-size">${item.bounds.width} x ${item.bounds.height}</span>`;
}

function renderBoard() {
  const active = screen();
  E.shell.style.width = `${active.width * S.zoom}px`;
  E.shell.style.height = `${active.height * S.zoom}px`;
  Object.assign(E.board.style, {
    width: `${active.width}px`,
    height: `${active.height}px`,
    transform: `scale(${S.zoom})`,
    backgroundColor: active.background
  });
  E.board.classList.toggle('grid-enabled', S.grid);
  const canvasNodes = active.nodes.filter((item) => !item.hidden).map((item, index) => ({ item, index, depth: nodeDepth(item) })).sort((a, b) => a.depth - b.depth || Number(b.item.type === 'frame') - Number(a.item.type === 'frame') || a.index - b.index).map((entry) => entry.item);
  E.board.innerHTML = canvasNodes.map((item) => {
    const bounds = item.bounds;
    const selected = S.selected === item.id;
    const label = item.type === 'frame' ? item.name : item.text;
    const parent = item.parentId ? active.nodes.find((candidate) => candidate.id === item.parentId) : null;
    const parentText = parent ? ` - inside ${parent.name}` : '';
    return `<div class="node type-${item.type} ${selected ? 'selected' : ''} ${item.locked ? 'locked' : ''}" data-node="${esc(item.id)}" data-tooltip="${esc(item.name)}|${esc(item.role || item.type)}${esc(parentText)} - ${bounds.x},${bounds.y} - ${bounds.width}x${bounds.height}${item.note ? ' - ' + esc(item.note.slice(0, 60)) : ''}" style="left:${bounds.x}px;top:${bounds.y}px;width:${bounds.width}px;height:${bounds.height}px">
      <div class="node-shape" style="${shapeStyle(item)}">
        ${item.type === 'image' ? '<div class="image-cross"></div>' : ''}
        <div class="node-text" style="${textStyle(item)}">${esc(label || '')}</div>
      </div>
      ${selected ? `<div class="node-hover-tag"><span>${esc(item.name)}</span>${item.role ? `<span class="role">${esc(item.role)}</span>` : ''}</div>${gizmoMarkup(item)}` : ''}
    </div>`;
  }).join('');
}

const field = (label, path, value, type = 'text', attrs = '') => `<label class="field-row"><span class="field-label">${label}</span><input class="field-control" data-field="${path}" type="${type}" value="${esc(value)}" ${attrs}></label>`;
const area = (label, path, value) => `<label class="field-row"><span class="field-label">${label}</span><textarea class="field-textarea" data-field="${path}">${esc(value || '')}</textarea></label>`;
const selectField = (label, path, value, options) => `<label class="field-row"><span class="field-label">${label}</span><select class="field-control" data-field="${path}">${options.map(([key, text]) => `<option value="${esc(key)}" ${key === String(value) ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select></label>`;
const colorField = (label, path, value) => `<label class="field-row"><span class="field-label">${label}</span><div class="color-control"><input class="color-swatch" data-field="${path}" type="color" value="${/^#[0-9a-f]{6}$/i.test(value || '') ? value : '#ffffff'}"><input class="field-control" data-field="${path}" type="text" value="${esc(value)}"></div></label>`;

function appearanceSection(item) {
  if (item.type === 'text') return '';
  return `<section class="inspect-section">
    <div class="inspect-section-title">Surface</div>
    <div class="field-grid">${colorField('Fill', 'node.style.fill', item.style.fill)}${colorField('Stroke', 'node.style.stroke', item.style.stroke)}</div>
    <div class="field-grid three" style="margin-top:7px">
      ${field('Border', 'node.style.borderWidth', item.style.borderWidth, 'number', 'min="0" max="20" step="1"')}
      ${selectField('Style', 'node.style.borderStyle', item.style.borderStyle, [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']])}
      ${field('Radius', 'node.style.radius', item.style.radius, 'number', 'min="0" max="200" step="1"')}
    </div>
  </section>`;
}

function typographySection(item) {
  if (item.type === 'image') return '';
  return `<section class="inspect-section">
    <div class="inspect-section-title">Typography</div>
    <div class="field-grid">${colorField('Text', 'node.style.textColor', item.style.textColor)}${field('Size', 'node.style.fontSize', item.style.fontSize, 'number', 'min="6" max="160" step="1"')}</div>
    <div class="field-grid" style="margin-top:7px">${field('Weight', 'node.style.fontWeight', item.style.fontWeight, 'number', 'min="100" max="900" step="100"')}${field('Line height', 'node.style.lineHeight', item.style.lineHeight, 'number', 'min="0.8" max="3" step="0.05"')}</div>
    <div class="field-grid" style="margin-top:7px">${selectField('Horizontal', 'node.style.textAlign', item.style.textAlign, [['left', 'Left'], ['center', 'Center'], ['right', 'Right']])}${selectField('Vertical', 'node.style.verticalAlign', item.style.verticalAlign, [['top', 'Top'], ['center', 'Center'], ['bottom', 'Bottom']])}</div>
    ${item.type === 'frame' ? '' : `<div class="field-grid" style="margin-top:7px">${field('Padding X', 'node.style.paddingX', item.style.paddingX, 'number', 'min="0" max="200" step="1"')}${field('Padding Y', 'node.style.paddingY', item.style.paddingY, 'number', 'min="0" max="200" step="1"')}</div>`}
  </section>`;
}

function renderInspector() {
  const active = screen();
  const selected = node();
  if (!selected) {
    E.inspector.innerHTML = `<div class="inspect-title"><div class="inspect-kind">S</div><div class="inspect-title-text"><div class="inspect-name">${esc(active.name)}</div><div class="inspect-subtitle">${active.width} x ${active.height} - ${esc(active.platform)}</div></div></div>
      <section class="inspect-section"><div class="inspect-section-title">Screen</div><div class="field-grid single">${field('Name', 'screen.name', active.name)}</div><div class="field-grid" style="margin-top:7px">${field('Width', 'screen.width', active.width, 'number')}${field('Height', 'screen.height', active.height, 'number')}</div></section>
      <section class="inspect-section"><div class="inspect-section-title">Fast loop</div><div class="help-copy"><b>F</b> creates a container.<br><b>B</b> creates a generic surface.<br><b>U</b> creates a button.<br>Every new node switches to <b>Select</b> automatically.<br>Drag the node or any of its 8 resize handles immediately.</div></section>`;
    return;
  }

  const parent = selected.parentId ? active.nodes.find((candidate) => candidate.id === selected.parentId) : null;
  const content = selected.type === 'frame' ? `<div class="frame-explainer">Frame is a container. Nodes fully inside it become children and move with the Frame.</div>` : area('Text / label', 'node.text', selected.text);
  E.inspector.innerHTML = `<div class="inspect-title"><div class="inspect-kind kind-${selected.type}">${selected.type[0].toUpperCase()}</div><div class="inspect-title-text"><div class="inspect-name">${esc(selected.name)}</div><div class="inspect-subtitle">${esc(selected.role || selected.type)} - ${selected.bounds.width} x ${selected.bounds.height}</div></div></div>
    <section class="inspect-section"><div class="inspect-section-title">Identity</div><div class="field-grid single">${field('Name', 'node.name', selected.name)}</div><div class="field-grid single" style="margin-top:7px">${field('Role', 'node.role', selected.role)}</div>${parent ? `<div class="parent-pill">Inside: ${esc(parent.name)}</div>` : ''}</section>
    <section class="inspect-section"><div class="inspect-section-title">Bounds</div><div class="field-grid">${field('X', 'node.bounds.x', selected.bounds.x, 'number')}${field('Y', 'node.bounds.y', selected.bounds.y, 'number')}</div><div class="field-grid" style="margin-top:7px">${field('W', 'node.bounds.width', selected.bounds.width, 'number')}${field('H', 'node.bounds.height', selected.bounds.height, 'number')}</div></section>
    <section class="inspect-section"><div class="inspect-section-title">Content</div>${content}<div style="margin-top:7px">${area('Note / behavior', 'node.note', selected.note)}</div></section>
    ${appearanceSection(selected)}
    ${typographySection(selected)}
    <section class="inspect-section"><div class="inspect-actions"><button class="inspect-button" data-action="duplicate">Duplicate</button><button class="inspect-button" data-action="lock">${selected.locked ? 'Unlock' : 'Lock'}</button><button class="inspect-button danger" data-action="delete">Delete</button></div></section>`;
}

function renderStatus() {
  E.zoom.textContent = `${Math.round(S.zoom * 100)}%`;
  E.grid.textContent = S.grid ? `Grid ${S.snap}` : 'Grid off';
  E.grid.classList.toggle('active', S.grid);
}

function point(event) {
  const rect = E.board.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(screen().width, (event.clientX - rect.left) / S.zoom)),
    y: Math.max(0, Math.min(screen().height, (event.clientY - rect.top) / S.zoom))
  };
}

function startTextEdit(id, selectAll = false) {
  const item = screen().nodes.find((candidate) => candidate.id === id);
  if (!item) return;
  const property = item.type === 'frame' ? 'name' : 'text';
  const editor = document.createElement('textarea');
  editor.className = `inline-editor type-${item.type}`;
  Object.assign(editor.style, {
    left: `${item.bounds.x}px`, top: `${item.bounds.y}px`, width: `${item.bounds.width}px`, height: `${item.type === 'frame' ? Math.min(36, item.bounds.height) : item.bounds.height}px`,
    fontSize: `${item.style.fontSize}px`, fontWeight: String(item.style.fontWeight || 500), lineHeight: String(item.style.lineHeight || 1.25),
    textAlign: item.style.textAlign || 'left', padding: `${item.style.paddingY || 0}px ${item.style.paddingX || 0}px`
  });
  editor.value = item[property] || '';
  E.board.append(editor);
  editor.focus();
  selectAll ? editor.select() : editor.setSelectionRange(editor.value.length, editor.value.length);
  const oldValue = item[property];
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const value = editor.value;
    editor.remove();
    if (save && value !== oldValue) change(() => { screen().nodes.find((candidate) => candidate.id === id)[property] = value; });
    else renderBoard();
  };
  editor.onkeydown = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); finish(true); }
  };
  editor.onblur = () => finish(true);
  status(item.type === 'frame' ? 'Editing Frame name - Enter commits - Esc cancels' : 'Editing text - Enter commits - Shift+Enter newline - Esc cancels');
}

function beginDraw(event) {
  if (S.tool === 'select' || event.button !== 0) return;
  const start = point(event);
  S.gesture = { kind: 'draw', start, current: start, tool: S.tool };
  event.preventDefault();
}

function drawMove(event) {
  const gesture = S.gesture;
  if (gesture?.kind !== 'draw') return;
  gesture.current = point(event);
  const x = Math.min(gesture.start.x, gesture.current.x);
  const y = Math.min(gesture.start.y, gesture.current.y);
  const width = Math.abs(gesture.current.x - gesture.start.x);
  const height = Math.abs(gesture.current.y - gesture.start.y);
  const rect = E.board.getBoundingClientRect();
  E.preview.hidden = false;
  E.preview.className = `draw-preview preview-${gesture.tool}`;
  Object.assign(E.preview.style, {
    left: `${rect.left + x * S.zoom}px`, top: `${rect.top + y * S.zoom}px`, width: `${width * S.zoom}px`, height: `${height * S.zoom}px`
  });
  status(`${gesture.tool} - ${Math.round(width)} x ${Math.round(height)}`);
}

function endDraw(event) {
  const gesture = S.gesture;
  if (gesture?.kind !== 'draw') return;
  S.gesture = null;
  E.preview.hidden = true;
  const end = point(event);
  const defaults = DRAW_DEFAULTS[gesture.tool];
  let x = snap(Math.min(gesture.start.x, end.x));
  let y = snap(Math.min(gesture.start.y, end.y));
  let width = snap(Math.abs(end.x - gesture.start.x));
  let height = snap(Math.abs(end.y - gesture.start.y));
  if (width < 8 && height < 8) [width, height] = defaults;
  width = Math.max(8, width);
  height = Math.max(8, height);
  let id;
  change(() => {
    const created = createNode(gesture.tool, { x, y, width, height });
    if (created.type === 'frame') screen().nodes.unshift(created);
    else screen().nodes.push(created);
    reconcileHierarchy(screen());
    S.selected = id = created.id;
  });
  setTool('select');
  renderBoard();
  renderInspector();
  status(`Created ${gesture.tool}. Select is active - drag to move, resize with any handle, Enter edits content.`);
}

function beginNode(event, id) {
  if (S.tool !== 'select' || event.button !== 0) return;
  const item = screen().nodes.find((candidate) => candidate.id === id);
  S.selected = id;
  render();
  if (item.locked) return status('Locked - unlock in Layers or Inspector.');
  const affectedIds = item.type === 'frame' ? [id, ...getDescendantIds(screen(), id)] : [id];
  const boundsById = Object.fromEntries(affectedIds.map((affectedId) => {
    const affected = screen().nodes.find((candidate) => candidate.id === affectedId);
    return [affectedId, { ...affected.bounds }];
  }));
  S.gesture = {
    kind: 'move', id, affectedIds, start: { x: event.clientX, y: event.clientY }, boundsById, before: structuredClone(S.doc)
  };
  event.stopPropagation();
  event.preventDefault();
}

function moveNode(event) {
  const gesture = S.gesture;
  if (gesture?.kind !== 'move') return;
  const dx = snap((event.clientX - gesture.start.x) / S.zoom);
  const dy = snap((event.clientY - gesture.start.y) / S.zoom);
  for (const id of gesture.affectedIds) {
    const item = screen().nodes.find((candidate) => candidate.id === id);
    const original = gesture.boundsById[id];
    item.bounds.x = original.x + dx;
    item.bounds.y = original.y + dy;
  }
  renderBoard();
  renderInspector();
  status(`${gesture.affectedIds.length > 1 ? 'Move Frame group' : 'Move'} - delta ${dx}, ${dy}`);
}

function endMove() {
  const gesture = S.gesture;
  if (gesture?.kind !== 'move') return;
  S.gesture = null;
  reconcileHierarchy(screen());
  if (JSON.stringify(gesture.before) !== JSON.stringify(S.doc)) {
    S.history.push(gesture.before);
    S.future = [];
    touch();
  }
  render();
}

function beginResize(event, id, handle) {
  const item = screen().nodes.find((candidate) => candidate.id === id);
  if (!item || item.locked) return;
  S.gesture = {
    kind: 'resize', id, handle, start: { x: event.clientX, y: event.clientY }, bounds: { ...item.bounds }, before: structuredClone(S.doc)
  };
  event.stopPropagation();
  event.preventDefault();
}

function resizedBounds(original, handle, dx, dy) {
  const min = 16;
  let left = original.x;
  let top = original.y;
  let right = original.x + original.width;
  let bottom = original.y + original.height;
  if (handle.includes('w')) left = snap(original.x + dx);
  if (handle.includes('e')) right = snap(original.x + original.width + dx);
  if (handle.includes('n')) top = snap(original.y + dy);
  if (handle.includes('s')) bottom = snap(original.y + original.height + dy);
  left = Math.max(0, Math.min(screen().width, left));
  right = Math.max(0, Math.min(screen().width, right));
  top = Math.max(0, Math.min(screen().height, top));
  bottom = Math.max(0, Math.min(screen().height, bottom));
  if (right - left < min) {
    if (handle.includes('w')) left = right - min;
    else right = left + min;
  }
  if (bottom - top < min) {
    if (handle.includes('n')) top = bottom - min;
    else bottom = top + min;
  }
  return { x: Math.max(0, left), y: Math.max(0, top), width: Math.max(min, right - left), height: Math.max(min, bottom - top) };
}

function resizeMove(event) {
  const gesture = S.gesture;
  if (gesture?.kind !== 'resize') return;
  const item = screen().nodes.find((candidate) => candidate.id === gesture.id);
  const dx = (event.clientX - gesture.start.x) / S.zoom;
  const dy = (event.clientY - gesture.start.y) / S.zoom;
  item.bounds = resizedBounds(gesture.bounds, gesture.handle, dx, dy);
  renderBoard();
  renderInspector();
  status(`Resize ${gesture.handle.toUpperCase()} - ${item.bounds.width} x ${item.bounds.height}`);
}

function endResize() {
  const gesture = S.gesture;
  if (gesture?.kind !== 'resize') return;
  S.gesture = null;
  reconcileHierarchy(screen());
  if (JSON.stringify(gesture.before) !== JSON.stringify(S.doc)) {
    S.history.push(gesture.before);
    S.future = [];
    touch();
  }
  render();
}

function del() {
  if (!S.selected) return;
  change(() => {
    screen().nodes = screen().nodes.filter((item) => item.id !== S.selected);
    reconcileHierarchy(screen());
    S.selected = null;
  });
}

function duplicate() {
  const selected = node();
  if (!selected) return;
  change(() => {
    const copy = structuredClone(selected);
    copy.id = `${selected.type}_${Date.now().toString(36)}`;
    copy.name = `${selected.name} copy`;
    copy.bounds.x += 16;
    copy.bounds.y += 16;
    if (copy.type === 'frame') screen().nodes.unshift(copy);
    else screen().nodes.push(copy);
    reconcileHierarchy(screen());
    S.selected = copy.id;
  });
}

function applyField(path, rawValue) {
  change(() => {
    const [root, ...parts] = path.split('.');
    let target = root === 'screen' ? screen() : node();
    for (let index = 0; index < parts.length - 1; index += 1) target = target[parts[index]];
    const key = parts.at(-1);
    const integerKeys = new Set(['width', 'height', 'x', 'y', 'radius', 'fontSize', 'fontWeight', 'borderWidth', 'paddingX', 'paddingY']);
    const floatKeys = new Set(['lineHeight']);
    if (integerKeys.has(key)) {
      const min = ['width', 'height'].includes(key) ? 1 : ['radius', 'fontSize', 'fontWeight', 'borderWidth', 'paddingX', 'paddingY'].includes(key) ? 0 : -100000;
      target[key] = Math.max(min, Math.round(Number(rawValue) || 0));
    } else if (floatKeys.has(key)) {
      target[key] = Math.max(0, Number(rawValue) || 0);
    } else target[key] = rawValue;
    if (root === 'node' && parts[0] === 'bounds') reconcileHierarchy(screen());
  });
}

async function copyAI() {
  await navigator.clipboard.writeText(makeAiHandoff(S.doc, S.screenId));
  toast('AI handoff copied');
}
async function copyPNG() {
  const active = screen();
  const blob = await svgToPngBlob(screenToSvg(active), active.width, active.height);
  if (navigator.clipboard?.write && window.ClipboardItem) {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('PNG copied');
  } else {
    downloadBlob(`${safeFileName(active.name)}.png`, blob);
    toast('PNG downloaded');
  }
}
function exportJSON() {
  downloadText(`${safeFileName(S.doc.name)}.uib.json`, JSON.stringify(S.doc, null, 2), 'application/json;charset=utf-8');
  toast('Blueprint exported');
}

$$('[data-tool]').forEach((button) => { button.onclick = () => setTool(button.dataset.tool); });
$('#copy-ai').onclick = () => copyAI().catch((error) => toast(error.message));
$('#copy-preview').onclick = () => copyPNG().catch((error) => toast(error.message));
$('#export-json').onclick = exportJSON;
$('#import-json').onclick = () => E.file.click();
E.file.onchange = async () => {
  try {
    const imported = sanitizeDocument(JSON.parse(await E.file.files[0].text()));
    snapshot();
    S.doc = imported;
    S.screenId = imported.screens[0].id;
    S.selected = null;
    persist();
    render();
    fit();
    toast('Blueprint imported');
  } catch (error) { toast(`Import failed: ${error.message}`); }
  E.file.value = '';
};
E.title.onchange = () => change(() => { S.doc.name = E.title.value.trim() || 'Untitled Blueprint'; });
$('#add-screen').onclick = () => change(() => {
  const created = createScreen({ name: `Screen ${S.doc.screens.length + 1}` });
  S.doc.screens.push(created);
  S.screenId = created.id;
  S.selected = null;
});
E.screens.onclick = (event) => {
  const row = event.target.closest('[data-screen]');
  if (!row) return;
  S.screenId = row.dataset.screen;
  S.selected = null;
  render();
  fit();
};
E.layers.onclick = (event) => {
  const hide = event.target.closest('[data-hide]');
  const lock = event.target.closest('[data-lock]');
  if (hide) return change(() => {
    const item = screen().nodes.find((candidate) => candidate.id === hide.dataset.hide);
    item.hidden = !item.hidden;
    if (S.selected === item.id) S.selected = null;
  });
  if (lock) return change(() => {
    const item = screen().nodes.find((candidate) => candidate.id === lock.dataset.lock);
    item.locked = !item.locked;
  });
  const row = event.target.closest('[data-node]');
  if (row) {
    S.selected = row.dataset.node;
    setTool('select');
    render();
  }
};
E.inspector.onchange = (event) => {
  const target = event.target.closest('[data-field]');
  if (target) applyField(target.dataset.field, target.value);
};
E.inspector.onclick = (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'delete') del();
  if (action === 'duplicate') duplicate();
  if (action === 'lock') change(() => { node().locked = !node().locked; });
};
E.stage.onpointerdown = (event) => {
  if (S.space && event.button === 0) {
    S.pan = { x: event.clientX, y: event.clientY, left: E.stage.scrollLeft, top: E.stage.scrollTop };
    E.stage.classList.add('panning');
    event.preventDefault();
  }
};
E.board.onpointerdown = (event) => {
  if (S.space) return;
  if (S.tool !== 'select') return beginDraw(event);
  const handle = event.target.closest('[data-resize]');
  if (handle) return beginResize(event, handle.dataset.resize, handle.dataset.handle);
  const item = event.target.closest('.node');
  if (item) return beginNode(event, item.dataset.node);
  S.selected = null;
  render();
};
E.board.ondblclick = (event) => {
  const item = event.target.closest('.node');
  if (!item) return;
  S.selected = item.dataset.node;
  setTool('select');
  render();
  requestAnimationFrame(() => startTextEdit(S.selected));
};
window.onpointermove = (event) => {
  if (S.pan) {
    E.stage.scrollLeft = S.pan.left - (event.clientX - S.pan.x);
    E.stage.scrollTop = S.pan.top - (event.clientY - S.pan.y);
    return;
  }
  drawMove(event);
  moveNode(event);
  resizeMove(event);
};
window.onpointerup = (event) => {
  if (S.pan) { S.pan = null; E.stage.classList.remove('panning'); }
  if (S.gesture?.kind === 'draw') endDraw(event);
  else if (S.gesture?.kind === 'move') endMove();
  else if (S.gesture?.kind === 'resize') endResize();
};
$('#zoom-in').onclick = () => setZoom(S.zoom * 1.12);
$('#zoom-out').onclick = () => setZoom(S.zoom / 1.12);
E.zoom.onclick = fit;
E.grid.onclick = () => { S.grid = !S.grid; render(); };

window.onkeydown = (event) => {
  if (event.target.matches('input,textarea,select')) return;
  if (event.code === 'Space') { S.space = true; event.preventDefault(); return; }
  const meta = event.metaKey || event.ctrlKey;
  if (meta && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
  if (meta && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicate(); return; }
  if (meta && event.shiftKey && event.key.toLowerCase() === 'c') { event.preventDefault(); copyAI(); return; }
  if (['Delete', 'Backspace'].includes(event.key)) { event.preventDefault(); del(); return; }
  if (event.key === 'Enter' && S.selected) { event.preventDefault(); startTextEdit(S.selected); return; }
  if (event.key === '0') { event.preventDefault(); fit(); return; }
  if (event.key.toLowerCase() === 'g') { S.grid = !S.grid; render(); return; }
  const tools = { v: 'select', f: 'frame', b: 'box', u: 'button', t: 'text', i: 'image' };
  if (tools[event.key.toLowerCase()]) { event.preventDefault(); setTool(tools[event.key.toLowerCase()]); return; }
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (arrows[event.key] && node() && !node().locked) {
    event.preventDefault();
    const [dx, dy] = arrows[event.key];
    const step = event.shiftKey ? 10 : 1;
    change(() => {
      const selected = node();
      const ids = selected.type === 'frame' ? [selected.id, ...getDescendantIds(screen(), selected.id)] : [selected.id];
      for (const id of ids) {
        const item = screen().nodes.find((candidate) => candidate.id === id);
        item.bounds.x += dx * step;
        item.bounds.y += dy * step;
      }
      reconcileHierarchy(screen());
    });
    return;
  }
  if (event.key === '+' || event.key === '=') setZoom(S.zoom * 1.12);
  if (event.key === '-') setZoom(S.zoom / 1.12);
};
window.onkeyup = (event) => { if (event.code === 'Space') S.space = false; };
window.onblur = () => { S.space = false; S.pan = null; E.stage.classList.remove('panning'); };
document.onpointerover = (event) => {
  const target = event.target.closest('[data-tooltip]');
  if (!target) return;
  clearTimeout(S.tipTimer);
  S.tipTimer = setTimeout(() => {
    const [title, body = ''] = target.dataset.tooltip.split('|');
    const rect = target.getBoundingClientRect();
    E.tipTitle.textContent = title;
    E.tipBody.textContent = body;
    E.tipBody.hidden = !body;
    E.tooltip.hidden = false;
    E.tooltip.style.left = `${Math.max(8, Math.min(innerWidth - 285, rect.left))}px`;
    E.tooltip.style.top = `${Math.min(innerHeight - 70, rect.bottom + 8)}px`;
    status(body || title);
  }, 180);
};
document.onpointerout = (event) => {
  const target = event.target.closest('[data-tooltip]');
  if (!target || target.contains(event.relatedTarget)) return;
  clearTimeout(S.tipTimer);
  E.tooltip.hidden = true;
  status();
};

render();
requestAnimationFrame(fit);
