export const SCHEMA_VERSION = 'uib/0.1';

const TYPE_DEFAULTS = {
  frame: {
    name: 'Frame',
    text: '',
    style: { fill: 'transparent', stroke: '#8b8b95', textColor: '#202124', radius: 8, fontSize: 13, textAlign: 'left' }
  },
  box: {
    name: 'Box',
    text: 'Label',
    style: { fill: '#f7f7f8', stroke: '#73737d', textColor: '#202124', radius: 8, fontSize: 14, textAlign: 'center' }
  },
  text: {
    name: 'Text',
    text: 'Text',
    style: { fill: 'transparent', stroke: 'transparent', textColor: '#202124', radius: 0, fontSize: 16, textAlign: 'left' }
  },
  image: {
    name: 'Image',
    text: 'Image',
    style: { fill: '#f2f2f4', stroke: '#8b8b95', textColor: '#63636c', radius: 8, fontSize: 13, textAlign: 'center' }
  }
};

let sequence = 0;

export function createId(prefix = 'id') {
  sequence += 1;
  const random = Math.random().toString(36).slice(2, 7);
  return `${prefix}_${Date.now().toString(36)}_${sequence.toString(36)}${random}`;
}

export function createScreen(options = {}) {
  return {
    id: options.id || createId('screen'),
    name: options.name || 'Screen 1',
    platform: options.platform || 'desktop',
    width: clampNumber(options.width, 240, 10000, 1440),
    height: clampNumber(options.height, 240, 10000, 900),
    background: options.background || '#ffffff',
    nodes: Array.isArray(options.nodes) ? options.nodes : []
  };
}

export function createDocument(options = {}) {
  const firstScreen = createScreen(options.screen);
  return {
    schema: SCHEMA_VERSION,
    id: options.id || createId('doc'),
    name: options.name || 'Untitled Blueprint',
    createdAt: options.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    screens: [firstScreen],
    components: [],
    tokens: { spacing: {}, typography: {}, radius: {}, color: {} },
    flows: [],
    extensions: {}
  };
}

export function createNode(type, bounds, options = {}) {
  const defaults = TYPE_DEFAULTS[type] || TYPE_DEFAULTS.box;
  const width = Math.max(1, Math.round(bounds?.width ?? (type === 'text' ? 160 : 180)));
  const height = Math.max(1, Math.round(bounds?.height ?? (type === 'text' ? 32 : 72)));
  return {
    id: options.id || createId(type),
    type,
    name: options.name || defaults.name,
    role: options.role || '',
    parentId: options.parentId ?? null,
    bounds: {
      x: Math.round(bounds?.x ?? 0),
      y: Math.round(bounds?.y ?? 0),
      width,
      height
    },
    text: options.text ?? defaults.text,
    note: options.note || '',
    locked: Boolean(options.locked),
    hidden: Boolean(options.hidden),
    layout: options.layout || null,
    constraints: options.constraints || null,
    style: { ...defaults.style, ...(options.style || {}) },
    extensions: options.extensions || {}
  };
}

export function cloneNode(node, offset = 16) {
  return {
    ...structuredClone(node),
    id: createId(node.type),
    name: `${node.name} copy`,
    parentId: node.parentId,
    bounds: {
      ...node.bounds,
      x: node.bounds.x + offset,
      y: node.bounds.y + offset
    }
  };
}

export function sanitizeDocument(input) {
  if (!input || typeof input !== 'object') throw new Error('Blueprint must be a JSON object.');
  if (!Array.isArray(input.screens)) throw new Error('Blueprint is missing screens[].');

  const document = {
    schema: typeof input.schema === 'string' ? input.schema : SCHEMA_VERSION,
    id: input.id || createId('doc'),
    name: String(input.name || 'Imported Blueprint'),
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    screens: input.screens.map((screen, screenIndex) => ({
      id: screen.id || createId('screen'),
      name: String(screen.name || `Screen ${screenIndex + 1}`),
      platform: String(screen.platform || 'custom'),
      width: clampNumber(screen.width, 240, 10000, 1440),
      height: clampNumber(screen.height, 240, 10000, 900),
      background: validColor(screen.background) ? screen.background : '#ffffff',
      nodes: (Array.isArray(screen.nodes) ? screen.nodes : []).map((node) => sanitizeNode(node))
    })),
    components: Array.isArray(input.components) ? input.components : [],
    tokens: input.tokens && typeof input.tokens === 'object' ? input.tokens : { spacing: {}, typography: {}, radius: {}, color: {} },
    flows: Array.isArray(input.flows) ? input.flows : [],
    extensions: input.extensions && typeof input.extensions === 'object' ? input.extensions : {}
  };

  if (document.screens.length === 0) document.screens.push(createScreen());
  return document;
}

function sanitizeNode(node = {}) {
  const type = ['frame', 'box', 'text', 'image'].includes(node.type) ? node.type : 'box';
  return createNode(type, {
    x: clampNumber(node.bounds?.x, -100000, 100000, 0),
    y: clampNumber(node.bounds?.y, -100000, 100000, 0),
    width: clampNumber(node.bounds?.width, 1, 100000, 180),
    height: clampNumber(node.bounds?.height, 1, 100000, 72)
  }, {
    id: node.id || createId(type),
    name: String(node.name || TYPE_DEFAULTS[type].name),
    role: String(node.role || ''),
    parentId: node.parentId || null,
    text: String(node.text ?? TYPE_DEFAULTS[type].text),
    note: String(node.note || ''),
    locked: Boolean(node.locked),
    hidden: Boolean(node.hidden),
    layout: node.layout || null,
    constraints: node.constraints || null,
    style: node.style || {},
    extensions: node.extensions || {}
  });
}

export function getActiveScreen(document, screenId) {
  return document.screens.find((screen) => screen.id === screenId) || document.screens[0];
}

export function updateDocumentTimestamp(document) {
  document.updatedAt = new Date().toISOString();
  return document;
}

export function makeAiHandoff(document, screenId) {
  const screen = getActiveScreen(document, screenId);
  const nodes = screen.nodes
    .filter((node) => !node.hidden)
    .map((node) => ({
      id: node.id,
      type: node.type,
      name: node.name,
      ...(node.role ? { role: node.role } : {}),
      ...(node.parentId ? { parentId: node.parentId } : {}),
      bounds: node.bounds,
      ...(node.text ? { text: node.text } : {}),
      ...(node.note ? { note: node.note } : {}),
      ...(node.layout ? { layout: node.layout } : {}),
      ...(node.constraints ? { constraints: node.constraints } : {}),
      style: node.style
    }));

  const payload = {
    schema: SCHEMA_VERSION,
    document: { id: document.id, name: document.name },
    screen: {
      id: screen.id,
      name: screen.name,
      platform: screen.platform,
      width: screen.width,
      height: screen.height,
      background: screen.background,
      nodes
    }
  };

  return [
    '# UI Blueprint AI Handoff',
    '',
    'Recreate this UI faithfully. Treat bounds, text, hierarchy, semantic roles, and notes as authoritative design intent. Preserve the layout first; improve visual polish only where it does not change structure or interaction intent.',
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```'
  ].join('\n');
}

export function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function validColor(value) {
  return typeof value === 'string' && (/^#[0-9a-f]{3,8}$/i.test(value) || value === 'transparent');
}
