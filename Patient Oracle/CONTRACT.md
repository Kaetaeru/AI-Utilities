# Patient Oracle Contract

## Durable source of truth

GitHub is the only durable source of truth for Patient Oracle queue state, request state, checkpoints, responses, and completion state. ChatGPT conversation state, assistant DOM text, and generated-file links are disposable transport/execution state and are never the durable response channel.

The durable layout is:

```text
.patient-oracle/
├── CONTRACT.md
├── runtime.json
├── queue.json
├── requests/<request_id>.json
├── responses/<request_id>.json
└── checkpoints/<request_id>/revision-<revision>.json
```

Requests live at `.patient-oracle/requests/<request_id>.json`. Pending FIFO requests live in `.patient-oracle/queue.json`. Terminal responses live at `.patient-oracle/responses/<request_id>.json`. Continuation checkpoints live under `.patient-oracle/checkpoints/<request_id>/`.

## FIFO queue

`.patient-oracle/queue.json` is a versioned FIFO list of requests that are durable but not currently selected by `runtime.json`.

The queue envelope is:

```json
{
  "version": 1,
  "revision": 3,
  "items": [
    { "request_id": "REQ-002", "enqueued_at": "2026-08-20T07:00:00Z" },
    { "request_id": "REQ-003", "enqueued_at": "2026-08-20T07:00:01Z" }
  ],
  "updated_at": "2026-08-20T07:00:01Z"
}
```

Queue writes use the GitHub file SHA as an optimistic concurrency token. Concurrent callers must retry on content conflicts rather than overwriting each other. Request IDs may appear at most once in the queue.

A caller writes the immutable request file first and only then appends its identity to the queue. If no request is active, a caller or the Server Mode queue worker may activate the FIFO head.

Activation preserves the single-active-request invariant. The activator first writes a higher SHA-protected `ready` `runtime.json` revision for the FIFO head and only then removes that request from `queue.json`. This ordering favors a harmless stale queue entry over request loss. If activation succeeds but dequeue cleanup is interrupted, reconciliation recognizes an already-active or already-completed head and removes the stale queue entry later.

`runtime.json` selects at most one active request. FIFO queueing does not authorize parallel ChatGPT execution on one stream.

## Browser-to-GitHub handoff

ChatGPT must not use GitHub plugins, connectors, OAuth, or repository tools for Patient Oracle execution. The Patient Oracle Chrome extension is the only component that reads and writes GitHub during worker execution, using the user-configured GitHub token.

For each dispatched request, ChatGPT creates one downloadable UTF-8 JSON response file with the exact filename assigned by the extension. The response file is a transient handoff artifact. The extension validates its request identity and status before performing any GitHub write.

Ordinary assistant message text is ignored by the protocol. The extension may inspect the DOM only to detect lifecycle state and locate the generated response-file link; it must not scrape assistant prose as the answer.

## Runtime handoff

`.patient-oracle/runtime.json` is the final authoritative handoff write for every active-request state transition. Any response or checkpoint artifact required by a transition must be written and verified before `runtime.json` is updated.

`revision` is monotonic within a `run_id`. A worker must never accept or dispatch a revision lower than one it has already observed for the same run. A revision already dispatched by that worker must not be dispatched again.

A `ready` runtime requires a non-empty `request_id`. Terminal statuses are `complete`, `needs_user`, and `blocked`. A terminal runtime may omit `request_id` only for the initialized idle state waiting for the first queued request.

## Response-file envelope

The generated response file uses version 1 and the exact request identity.

For `complete`, it contains `version`, `request_id`, `status`, `content_type`, `answer`, and `completed_at`, with optional `metadata`. `answer` may contain long-form Markdown, code, tables, or other text appropriate to `content_type`.

For `needs_user` or `blocked`, it contains a non-empty `reason` instead of a successful answer.

For `continue`, it contains a non-empty `reason` and `resume_state` with exact resumable state. The extension persists that state as a checkpoint and then publishes a higher `ready` revision for the same request.

## Ownership and execution identity

One Patient Oracle worker owns a stream at a time. The stream identity is repository owner, repository name, branch, and runtime path. A second local worker must not dispatch the same stream concurrently.

Every dispatched ChatGPT turn receives an execution token. Artifact, checkpoint, hard-stop, and lifecycle events are valid only when their execution token matches the active execution token. Stale events are ignored.

Redispatch of the same request is bounded by a local circuit breaker. Exceeding the bound requires user intervention rather than unbounded retry.

If repository coordinates, branch, or runtime path change while a worker is active, the worker stops rather than silently switching streams.

## User Start/Stop intent

The Side Panel Start/Stop control represents user intent, not worker health. Only an explicit user button action changes that intent latch. Dispatch failures, watchdog recovery, browser restarts, queue activation, and other operational state changes must never flip the Start/Stop control on the user's behalf.

When user intent is Start, operational recovery may restore the worker while the UI remains latched Start. When user intent is Stop, queue entries may remain durable but the server worker must not execute them until the user explicitly starts Patient Oracle again.

## Browser safety

A non-empty ChatGPT composer is user-owned state and must never be overwritten. Patient Oracle may submit only into an empty composer. If a user draft is present, the worker remains enabled and waits for the composer to become empty.

A dispatch is acknowledged only after visible submission evidence exists, such as the composer clearing or ChatGPT entering a generating state. Merely inserting text is not dispatch evidence.

GitHub approval, OAuth, permission, and administrative controls are always manual. Patient Oracle must never auto-click, bypass, or attempt to decide these controls. Normal Patient Oracle execution does not require the ChatGPT GitHub plugin because GitHub I/O belongs to the extension.

DOM completion is only a wake signal. It is not durable proof that work completed successfully. Polling and GitHub reconciliation remain recovery paths if DOM events are missed.

## GitHub rate limits and conflicts

GitHub reads should use conditional requests when practical. On HTTP 403 or 429 with rate-limit evidence, Patient Oracle pauses until the server-provided retry/reset time when available rather than blindly retrying.

Durable history is not overwritten silently. If a response/checkpoint path already exists with different content, or if `runtime.json` changes concurrently before the final authoritative write, the worker stops instead of clobbering newer state.

Queue updates are also conflict-safe. Enqueue and dequeue operations retry after GitHub SHA conflicts and never replace a newer queue snapshot blindly.

## 20-minute execution law

Each Patient Oracle ChatGPT turn has a hard execution budget of 20 minutes.

At approximately minute 18, the worker reaches its checkpoint. After the checkpoint it begins no new long operation and prioritizes producing either a terminal response file or a `continue` response file containing exact resumable state.

If the request cannot be safely completed before the hard stop, the worker must not claim completion. It creates a `continue` response file. The extension writes the checkpoint first, verifies it, and then publishes a higher `ready` runtime revision for the same request last.

The worker ends before 20 minutes. Any terminal response artifact required for `complete`, `needs_user`, or `blocked` is written to GitHub and verified before the corresponding terminal `runtime.json` revision is written last.

After a terminal active-request transition, the Server Mode queue worker may activate the next FIFO item with a new higher `ready` runtime revision.

## Caller ordering

For a new request, the caller writes `.patient-oracle/requests/<request_id>.json` first and then appends the request to `.patient-oracle/queue.json` using SHA-protected conflict handling. Request identities are immutable.

If runtime is terminal, the caller may opportunistically activate the FIFO head. Activation always selects the head, never a later request, and writes the higher `ready` runtime revision before dequeue cleanup.

For terminal completion, Patient Oracle writes `.patient-oracle/responses/<request_id>.json` first, verifies it, and only then publishes the higher terminal runtime revision last.
