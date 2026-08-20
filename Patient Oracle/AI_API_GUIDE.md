# Patient Oracle AI Caller Guide

This guide is for another AI agent, automation, or program that needs to use the dedicated Patient Oracle sub-PC as an AI worker.

## What Patient Oracle is

Patient Oracle is an **API-like, GitHub-backed bridge to a logged-in ChatGPT browser session** on a dedicated sub-PC. It is not an HTTP server on that PC. Callers do not connect directly to the sub-PC.

```text
caller / AI agent
  -> GitHub request + FIFO queue
  -> dedicated sub-PC Patient Oracle extension
  -> logged-in ChatGPT browser session
  -> generated response file
  -> extension validates it
  -> GitHub durable response
  -> caller reads the response
```

GitHub is the durable source of truth. Browser DOM text, ChatGPT conversation state, and generated-file links are temporary execution transport only.

## Current deployed coordinates

```text
Repository:              Kaetaeru/AI-Utilities
Extension source branch: agent/patient-oracle-mvp
Runtime/mailbox branch:  agent/patient-oracle-e2e
Runtime path:             .patient-oracle/runtime.json
Queue path:               .patient-oracle/queue.json
```

The source branch contains the extension and caller code. The runtime/mailbox branch contains request, queue, runtime, checkpoint, and response state used by the running sub-PC worker.

Do not change these coordinates unless the operator explicitly requests it.

## Preconditions

The caller needs a checkout of `Kaetaeru/AI-Utilities` on branch `agent/patient-oracle-mvp`, Node.js, and a valid `GITHUB_TOKEN` environment variable with appropriate repository Contents access.

The sub-PC is managed separately and normally has Chrome running, ChatGPT logged in, Patient Oracle loaded, Server Mode enabled, and the user-intent latch in Start state. When the user intent is Start, the Side Panel button displays **Stop Oracle**.

Do not attempt to remote-control the sub-PC for an ordinary API call.

## Caller commands

Run commands from:

```text
AI-Utilities/Patient Oracle
```

Available commands:

```text
oracle:ask      enqueue one request and wait for its final response
oracle:enqueue  enqueue one request and return immediately
oracle:wait     wait for a previously enqueued request ID
```

On Windows PowerShell, use `npm.cmd` if PowerShell blocks `npm.ps1`.

## Blocking request: `ask`

Use `ask` for ordinary request/return behavior.

```powershell
npm.cmd run oracle:ask -- `
  --owner Kaetaeru `
  --repo AI-Utilities `
  --branch agent/patient-oracle-e2e `
  --id REQ-MY-TASK-001 `
  --response-format text/markdown `
  --prompt "Perform the requested task and return the result." `
  --timeout-seconds 1800
```

`ask` is logically:

```text
enqueue(request)
wait(request_id)
```

If other requests are ahead of it, it waits in the FIFO queue until its own request is processed.

Typical successful output:

```json
{
  "request_id": "REQ-MY-TASK-001",
  "status": "complete",
  "content_type": "text/markdown",
  "answer": "...full answer...",
  "completed_at": "2026-08-20T07:21:26.446Z"
}
```

The `answer` field is the API result. Never scrape browser-visible assistant prose as the answer.

## Queue work: `enqueue`

Use `enqueue` to submit work without waiting.

```powershell
npm.cmd run oracle:enqueue -- `
  --owner Kaetaeru `
  --repo AI-Utilities `
  --branch agent/patient-oracle-e2e `
  --id REQ-A `
  --prompt "Job A"
```

Submit more requests the same way with distinct IDs.

An idle worker may activate the first request immediately:

```json
{
  "request_id": "REQ-A",
  "status": "ready",
  "queue_position": 0,
  "runtime_revision": 14
}
```

A request waiting behind another request may return:

```json
{
  "request_id": "REQ-B",
  "status": "queued",
  "queue_position": 1,
  "runtime_revision": null
}
```

Queue position is informational and changes as earlier requests finish.

## Retrieve a result: `wait`

```powershell
npm.cmd run oracle:wait -- `
  --owner Kaetaeru `
  --repo AI-Utilities `
  --branch agent/patient-oracle-e2e `
  --id REQ-B `
  --timeout-seconds 1800
```

`wait` polls the durable GitHub response for that exact request ID.

## FIFO semantics

Patient Oracle accepts multiple pending requests but executes **one ChatGPT job at a time per stream**.

```text
Requests arrive: A, B, C, D

Active: A
Queue:  B -> C -> D

A completes -> B starts
B completes -> C starts
C completes -> D starts
```

Therefore:

- enqueue can accept several pending jobs quickly;
- execution is serial, not parallel;
- a long request delays later requests;
- `ask` issued while another request is active joins the same FIFO queue and waits for its own turn.

## Request IDs

Request IDs are durable immutable identities. Use only letters, digits, `.`, `_`, and `-`. Do not use `/` or path traversal.

Examples:

```text
REQ-20260820-001
REQ-REPORT-ALPHA
agent_task_0042
```

Rules:

- Prefer a new unique ID for every logical task.
- Do not reuse an ID that already has a durable response.
- If a request file already exists, re-enqueueing the same ID is valid only when its immutable request content matches.
- A local timeout is not a reason to create a duplicate ID; use `wait` on the same ID.

## Terminal outcomes

The caller must handle:

- `complete`: success; read `answer` and `content_type`.
- `needs_user`: human input or intervention is required; read `reason`.
- `blocked`: the worker could not safely or validly finish; read `reason`.

A long request may internally use `continue` checkpoints across higher runtime revisions. This is normally transparent to the caller; continue waiting on the same request ID.

## Timeouts and polling

Useful caller options:

```text
--timeout-seconds N   maximum time ask/wait waits locally
--poll-seconds N      GitHub response polling interval; minimum 5 seconds
--response-format F   output format hint such as text/markdown
```

The worker has an approximately 18-minute checkpoint and 20-minute hard execution law per ChatGPT turn. A large request can continue across turns, so callers may choose a longer local timeout.

A local timeout does not cancel or delete the durable request. Call `oracle:wait` later with the same ID.

## User Start/Stop semantics

The Side Panel Start/Stop control is **user intent**, not worker health.

If the user has pressed Stop:

- callers can still create durable queued requests;
- queued requests remain in GitHub;
- the sub-PC does not execute them until the user explicitly presses Start again.

Operational errors, browser restarts, watchdog recovery, and queue transitions do not change the user's Start/Stop latch.

A request that remains queued for a long time may therefore indicate intentional Stop state or operator attention rather than data loss.

## Durable mailbox files

```text
.patient-oracle/
├── CONTRACT.md
├── runtime.json
├── queue.json
├── requests/<request_id>.json
├── responses/<request_id>.json
└── checkpoints/<request_id>/revision-<revision>.json
```

Meaning:

- `requests/<id>.json`: immutable caller input;
- `queue.json`: pending FIFO requests not currently selected by runtime;
- `runtime.json`: at most one active request and active durable state;
- `responses/<id>.json`: durable terminal API result;
- `checkpoints/...`: resumable state for long-running requests.

Use the caller commands for ordinary work. Do not hand-edit queue/runtime state unless repairing the protocol deliberately.

## Rules for AI callers

1. Use `ask`, `enqueue`, and `wait` instead of manually editing durable protocol files.
2. Never overwrite request/response/checkpoint history.
3. Never run parallel workers for the same stream.
4. Treat only the durable GitHub response as authoritative output.
5. Do not instruct the worker ChatGPT turn to use GitHub plugins, connectors, OAuth, or repository tools; the extension owns GitHub I/O during execution.
6. Keep authentication credentials out of prompts, chat messages, and logs.
7. Respect FIFO ordering; do not manually promote a later request ahead of the queue head.
8. On `needs_user` or `blocked`, surface the reason to the operator instead of inventing a successful result.

## AI decision procedure

```text
Need one result and can wait?
  -> oracle:ask

Need to submit work and continue other work?
  -> oracle:enqueue
  -> save request_id
  -> oracle:wait later

Need several independent jobs?
  -> enqueue each with a unique ID
  -> execution is FIFO and serial
  -> wait for each ID as needed

Local wait timed out?
  -> do not enqueue a duplicate automatically
  -> oracle:wait using the same request_id

Result is needs_user or blocked?
  -> report the reason to the operator
```

## References

This file is the caller/operator guide. For exact durable ordering, queue CAS rules, runtime revision invariants, browser safety, response envelopes, and recovery rules, read [`CONTRACT.md`](./CONTRACT.md).

For implementation and extension setup, read [`README.md`](./README.md).
