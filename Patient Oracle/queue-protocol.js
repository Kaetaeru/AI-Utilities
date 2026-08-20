export const ORACLE_QUEUE_PATH = ".patient-oracle/queue.json";
export const MAX_QUEUE_ITEMS = 1000;

export function emptyQueue(now = new Date().toISOString()) {
  return { version: 1, revision: 0, items: [], updated_at: normalizeIso(now, "queue updated_at") };
}

export function parseQueuePayload(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("Patient Oracle queue is not valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Patient Oracle queue must be an object");
  rejectUnknown(value, ["version", "revision", "items", "updated_at"], "Patient Oracle queue");
  if (value.version !== 1) throw new Error("Patient Oracle queue version must be 1");
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error("Patient Oracle queue revision must be a non-negative integer");
  if (!Array.isArray(value.items)) throw new Error("Patient Oracle queue items must be an array");
  if (value.items.length > MAX_QUEUE_ITEMS) throw new Error(`Patient Oracle queue exceeds ${MAX_QUEUE_ITEMS} items`);
  const ids = new Set();
  const items = value.items.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Patient Oracle queue item ${index} must be an object`);
    rejectUnknown(item, ["request_id", "enqueued_at"], `Patient Oracle queue item ${index}`);
    const requestId = normalizeRequestId(item.request_id);
    if (ids.has(requestId)) throw new Error(`Patient Oracle queue contains duplicate request_id ${requestId}`);
    ids.add(requestId);
    return { request_id: requestId, enqueued_at: normalizeIso(item.enqueued_at, `queue item ${requestId} enqueued_at`) };
  });
  return {
    version: 1,
    revision: value.revision,
    items,
    updated_at: normalizeIso(value.updated_at, "queue updated_at")
  };
}

export function appendQueueItem(queueInput, requestIdInput, enqueuedAtInput, now = new Date().toISOString()) {
  const queue = normalizeQueue(queueInput);
  const requestId = normalizeRequestId(requestIdInput);
  const enqueuedAt = normalizeIso(enqueuedAtInput, `queue item ${requestId} enqueued_at`);
  const existingIndex = queue.items.findIndex((item) => item.request_id === requestId);
  if (existingIndex >= 0) return { queue, inserted: false, position: existingIndex + 1 };
  if (queue.items.length >= MAX_QUEUE_ITEMS) throw new Error(`Patient Oracle queue is full at ${MAX_QUEUE_ITEMS} items`);
  const next = {
    version: 1,
    revision: queue.revision + 1,
    items: [...queue.items, { request_id: requestId, enqueued_at: enqueuedAt }],
    updated_at: normalizeIso(now, "queue updated_at")
  };
  return { queue: next, inserted: true, position: next.items.length };
}

export function removeQueueItem(queueInput, requestIdInput, now = new Date().toISOString()) {
  const queue = normalizeQueue(queueInput);
  const requestId = normalizeRequestId(requestIdInput);
  const index = queue.items.findIndex((item) => item.request_id === requestId);
  if (index < 0) return { queue, removed: false };
  const items = queue.items.slice();
  items.splice(index, 1);
  return {
    queue: {
      version: 1,
      revision: queue.revision + 1,
      items,
      updated_at: normalizeIso(now, "queue updated_at")
    },
    removed: true,
    removed_position: index + 1
  };
}

export function queuePosition(queueInput, requestIdInput) {
  const queue = normalizeQueue(queueInput);
  const requestId = normalizeRequestId(requestIdInput);
  const index = queue.items.findIndex((item) => item.request_id === requestId);
  return index < 0 ? 0 : index + 1;
}

function normalizeQueue(value) {
  if (typeof value === "string") return parseQueuePayload(value);
  return parseQueuePayload(JSON.stringify(value || emptyQueue()));
}

function normalizeRequestId(value) {
  const id = String(value || "").trim();
  if (!id || id.includes("/") || id.includes("..") || !/^[A-Za-z0-9._-]+$/.test(id)) throw new Error("invalid oracle request ID");
  return id;
}

function normalizeIso(value, label) {
  const text = String(value || "").trim();
  if (!text || !Number.isFinite(Date.parse(text))) throw new Error(`${label} must be an ISO-8601 date-time string`);
  return text;
}

function rejectUnknown(value, allowed, label) {
  const set = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !set.has(key));
  if (unknown.length) throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}`);
}
