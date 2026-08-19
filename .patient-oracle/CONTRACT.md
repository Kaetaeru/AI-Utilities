# Patient Oracle Contract

## Durable source of truth

GitHub is the only durable source of truth for Patient Oracle execution state and results. ChatGPT conversation state is disposable execution state. Assistant DOM text is never the durable response channel and must never be treated as the API result.

The durable layout is:

```text
.patient-oracle/
├── CONTRACT.md
├── runtime.json
├── requests/<request_id>.json
└── responses/<request_id>.json
```

Requests live at `.patient-oracle/requests/<request_id>.json`. Responses live at `.patient-oracle/responses/<request_id>.json`.

## Runtime handoff

`.patient-oracle/runtime.json` is the final authoritative handoff write for each state transition. Durable artifacts required by a transition must be written and verified before `runtime.json` is updated.

`revision` is monotonic within a `run_id`. A worker must never accept or dispatch a revision lower than one it has already observed for the same run. A revision already dispatched by that worker must not be dispatched again.

A `ready` runtime requires a non-empty `request_id`. Terminal statuses are `complete`, `needs_user`, and `blocked`. A terminal runtime may omit `request_id` only for an initialized idle state that is waiting for the caller to publish the first request.

## Ownership and execution identity

One Patient Oracle worker owns a stream at a time. The stream identity is the repository owner, repository name, branch, and runtime path. A second local worker must not dispatch the same stream concurrently.

Every dispatched ChatGPT turn receives an execution token. Completion, checkpoint, hard-stop, and wake events are valid only when their execution token matches the active execution token. Stale events are ignored.

Redispatch of the same request is bounded by a local circuit breaker. Exceeding the bound requires user intervention rather than unbounded retry.

## Browser safety

A non-empty ChatGPT composer is user-owned state and must not be overwritten. Patient Oracle may submit only into an empty composer.

A dispatch is acknowledged only after visible submission evidence exists, such as the composer clearing or ChatGPT entering a generating state. Merely inserting text is not dispatch evidence.

GitHub approval, OAuth, permission, and administrative controls are always manual. Patient Oracle must never auto-click, bypass, or attempt to decide these controls for the user.

DOM completion is only a wake signal. It is not durable proof that work completed successfully. GitHub reconciliation remains authoritative, and polling remains the recovery path if DOM events are missed.

If repository coordinates, branch, or runtime path change while a worker is active, the worker must stop rather than silently switching streams.

## GitHub rate limits and reconciliation

GitHub reads should use conditional requests when practical. On rate limiting, including HTTP 403 or 429 with rate-limit evidence, Patient Oracle pauses until the server-provided retry/reset time when available rather than treating the condition as successful work or blindly retrying.

After every ChatGPT turn, the worker reconciles against current GitHub state. It must not invent repository writes, successful tests, responses, or terminal status.

## 20-minute execution law

Each Patient Oracle ChatGPT turn has a hard execution budget of 20 minutes.

At approximately minute 18, the worker reaches its checkpoint. After the checkpoint it must begin no new long operation. It must prioritize durable GitHub state and an exact resumable handoff.

If the request cannot be safely completed before the hard stop, the worker must not claim it is complete. It must preserve the same request identity, persist exact resumable state, and publish a higher `ready` runtime revision for that same request so a later disposable ChatGPT turn can continue.

The worker must end before 20 minutes. Any final response artifact required for `complete`, `needs_user`, or `blocked` must be written and verified before the corresponding terminal `runtime.json` revision is written last.

## Caller ordering

For a new request, the caller writes `.patient-oracle/requests/<request_id>.json` first and only then publishes the higher `ready` runtime revision last. Request identities are immutable.

For a successful completion, the worker writes `.patient-oracle/responses/<request_id>.json` first, verifies it, and only then publishes the higher `complete` runtime revision last. The same artifact-before-runtime ordering applies to durable `needs_user` or `blocked` handoffs.
