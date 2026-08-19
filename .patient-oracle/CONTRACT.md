# Patient Oracle Contract

## Durable source of truth

GitHub is the only durable source of truth for Patient Oracle request state, checkpoints, responses, and completion state. ChatGPT conversation state, assistant DOM text, and generated-file links are disposable transport/execution state and are never the durable response channel.

The durable layout is:

```text
.patient-oracle/
├── CONTRACT.md
├── runtime.json
├── requests/<request_id>.json
├── responses/<request_id>.json
└── checkpoints/<request_id>/revision-<revision>.json
```

Requests live at `.patient-oracle/requests/<request_id>.json`. Terminal responses live at `.patient-oracle/responses/<request_id>.json`. Continuation checkpoints live under `.patient-oracle/checkpoints/<request_id>/`.

## Browser-to-GitHub handoff

ChatGPT must not use GitHub plugins, connectors, OAuth, or repository tools for Patient Oracle execution. The Patient Oracle Chrome extension is the only component that reads and writes GitHub during worker execution, using the user-configured GitHub token.

For each dispatched request, ChatGPT creates one downloadable UTF-8 JSON response file with the exact filename assigned by the extension. The response file is a transient handoff artifact. The extension validates its request identity and status before performing any GitHub write.

Ordinary assistant message text is ignored by the protocol. The extension may inspect the DOM only to detect lifecycle state and locate the generated response-file link; it must not scrape assistant prose as the answer.

## Runtime handoff

`.patient-oracle/runtime.json` is the final authoritative handoff write for every durable state transition. Any response or checkpoint artifact required by a transition must be written and verified before `runtime.json` is updated.

`revision` is monotonic within a `run_id`. A worker must never accept or dispatch a revision lower than one it has already observed for the same run. A revision already dispatched by that worker must not be dispatched again.

A `ready` runtime requires a non-empty `request_id`. Terminal statuses are `complete`, `needs_user`, and `blocked`. A terminal runtime may omit `request_id` only for the initialized idle state waiting for the first caller request.

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

## Browser safety

A non-empty ChatGPT composer is user-owned state and must never be overwritten. Patient Oracle may submit only into an empty composer. If a user draft is present, the worker remains enabled and waits for the composer to become empty.

A dispatch is acknowledged only after visible submission evidence exists, such as the composer clearing or ChatGPT entering a generating state. Merely inserting text is not dispatch evidence.

GitHub approval, OAuth, permission, and administrative controls are always manual. Patient Oracle must never auto-click, bypass, or attempt to decide these controls. Normal Patient Oracle execution does not require the ChatGPT GitHub plugin because GitHub I/O belongs to the extension.

DOM completion is only a wake signal. It is not durable proof that work completed successfully. Polling and GitHub reconciliation remain recovery paths if DOM events are missed.

## GitHub rate limits and conflicts

GitHub reads should use conditional requests when practical. On HTTP 403 or 429 with rate-limit evidence, Patient Oracle pauses until the server-provided retry/reset time when available rather than blindly retrying.

Durable history is not overwritten silently. If a response/checkpoint path already exists with different content, or if `runtime.json` changes concurrently before the final authoritative write, the worker stops instead of clobbering newer state.

## 20-minute execution law

Each Patient Oracle ChatGPT turn has a hard execution budget of 20 minutes.

At approximately minute 18, the worker reaches its checkpoint. After the checkpoint it begins no new long operation and prioritizes producing either a terminal response file or a `continue` response file containing exact resumable state.

If the request cannot be safely completed before the hard stop, the worker must not claim completion. It creates a `continue` response file. The extension writes the checkpoint first, verifies it, and then publishes a higher `ready` runtime revision for the same request last.

The worker ends before 20 minutes. Any terminal response artifact required for `complete`, `needs_user`, or `blocked` is written to GitHub and verified before the corresponding terminal `runtime.json` revision is written last.

## Caller ordering

For a new request, the caller writes `.patient-oracle/requests/<request_id>.json` first and only then publishes the higher `ready` runtime revision last. Request identities are immutable.

For terminal completion, Patient Oracle writes `.patient-oracle/responses/<request_id>.json` first, verifies it, and only then publishes the higher terminal runtime revision last.
