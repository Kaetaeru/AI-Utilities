# Patient Oracle Protocol v1

Patient Oracle uses GitHub as its only durable request/response channel. A ChatGPT conversation is disposable execution state.

## Paths

- `.patient-oracle/CONTRACT.md`
- `.patient-oracle/runtime.json`
- `.patient-oracle/requests/<request_id>.json`
- `.patient-oracle/responses/<request_id>.json`

## Runtime

`runtime.json` contains only `version`, `run_id`, `revision`, `status`, optional `request_id`, optional `reason`, and `updated_at`.

Statuses are `ready`, `complete`, `needs_user`, and `blocked`. `revision` is monotonic within one `run_id`. A `ready` runtime requires `request_id`. Only a newer `ready` revision authorizes dispatch.

The caller writes an immutable request artifact first and updates `runtime.json` last. The worker writes a response artifact first, verifies it, and updates `runtime.json` last. Runtime is the final authoritative handoff write.

## Response

A terminal response contains `version: 1`, the exact `request_id`, and one of `complete`, `needs_user`, or `blocked`. `complete` requires a non-empty `answer`; the other terminal states require a non-empty `reason`.

Assistant message DOM text is never the durable answer channel.

## Safety

One stream is `owner/repo/branch/runtime-path` and has at most one active browser owner. Revision regression stops local execution. A request has a bounded local dispatch circuit breaker. A non-empty user composer is never overwritten. Prompt submission requires observable send evidence. GitHub approval, OAuth, and administrative controls are never auto-approved. Rate limits pause polling. DOM completion is only a wake signal; GitHub reconciliation determines durable completion.

## 20-minute law

Each ChatGPT execution gets its own 20-minute budget. Around minute 18, begin no new long operation and prioritize durable checkpointing. Never mark unfinished work complete. If continuation is required, preserve the same request identity and publish a higher `ready` revision before ending the turn. A new fresh turn receives a new 20-minute budget.
