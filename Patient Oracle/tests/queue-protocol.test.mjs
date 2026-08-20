import test from "node:test";
import assert from "node:assert/strict";
import { appendQueueItem, emptyQueue, parseQueuePayload, queuePosition, removeQueueItem } from "../queue-protocol.js";

test("queue appends FIFO items and reports positions", () => {
  let queue = emptyQueue("2026-08-20T07:00:00Z");
  queue = appendQueueItem(queue, "REQ-A", "2026-08-20T07:00:01Z", "2026-08-20T07:00:01Z").queue;
  queue = appendQueueItem(queue, "REQ-B", "2026-08-20T07:00:02Z", "2026-08-20T07:00:02Z").queue;
  assert.deepEqual(queue.items.map((item) => item.request_id), ["REQ-A", "REQ-B"]);
  assert.equal(queuePosition(queue, "REQ-A"), 1);
  assert.equal(queuePosition(queue, "REQ-B"), 2);
  assert.equal(queue.revision, 2);
});

test("duplicate enqueue is idempotent and does not advance revision", () => {
  const first = appendQueueItem(emptyQueue("2026-08-20T07:00:00Z"), "REQ-A", "2026-08-20T07:00:01Z", "2026-08-20T07:00:01Z").queue;
  const duplicate = appendQueueItem(first, "REQ-A", "2026-08-20T07:00:01Z", "2026-08-20T07:00:02Z");
  assert.equal(duplicate.inserted, false);
  assert.equal(duplicate.position, 1);
  assert.equal(duplicate.queue.revision, 1);
});

test("dequeue removes only the requested item and preserves order", () => {
  let queue = emptyQueue("2026-08-20T07:00:00Z");
  for (const [id, second] of [["REQ-A", "01"], ["REQ-B", "02"], ["REQ-C", "03"]]) {
    queue = appendQueueItem(queue, id, `2026-08-20T07:00:${second}Z`, `2026-08-20T07:00:${second}Z`).queue;
  }
  const result = removeQueueItem(queue, "REQ-B", "2026-08-20T07:00:04Z");
  assert.equal(result.removed, true);
  assert.deepEqual(result.queue.items.map((item) => item.request_id), ["REQ-A", "REQ-C"]);
  assert.equal(result.queue.revision, 4);
});

test("queue parser rejects duplicate request ids", () => {
  assert.throws(() => parseQueuePayload(JSON.stringify({
    version: 1,
    revision: 2,
    items: [
      { request_id: "REQ-A", enqueued_at: "2026-08-20T07:00:01Z" },
      { request_id: "REQ-A", enqueued_at: "2026-08-20T07:00:02Z" }
    ],
    updated_at: "2026-08-20T07:00:02Z"
  })), /duplicate request_id/);
});
