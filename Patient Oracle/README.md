# Patient Oracle

> **A question may wait. Its answer must return with its identity intact.**

Patient Oracle is a standalone Chrome extension and GitHub-backed request/response worker. Callers publish durable requests through GitHub, requests wait in a durable FIFO queue, the extension dispatches one active request at a time into a fresh ChatGPT conversation, ChatGPT creates a generated JSON response file, and the extension validates that file and performs the durable GitHub response/runtime writes with the configured GitHub credential.

Patient Oracle does **not** use the ChatGPT GitHub plugin for worker execution. GitHub remains the only durable source of truth; generated ChatGPT files are transient handoff artifacts.

## Flow

```text
external callers
  -> GitHub request files
  -> .patient-oracle/queue.json FIFO
  -> one request promoted to runtime ready
  -> Patient Oracle extension
  -> fresh ChatGPT conversation
  -> generated patient-oracle-response-<request_id>.json
  -> Patient Oracle validates the file/preview
  -> GitHub response/checkpoint first
  -> GitHub runtime terminal state
  -> next FIFO request promoted to ready
  -> callers read durable responses
```

Ordinary assistant prose is never the durable answer API.

## FIFO queue

Patient Oracle 0.4 adds a durable multi-request FIFO queue while preserving **single-active-request / serial execution**.

Each caller writes an immutable request file and appends its `request_id` to `.patient-oracle/queue.json`. Queue updates use GitHub SHA optimistic concurrency, so concurrent enqueue operations retry instead of silently overwriting one another.

Only the queue head can be promoted to `runtime.json`. Promotion writes the higher `ready` runtime revision first and removes the queue head second. If a crash happens between those writes, the request is not lost; reconciliation removes the stale queue entry later.

This means:

- many historical requests/responses: supported;
- many durable pending requests: supported;
- one active ChatGPT request per stream: supported;
- FIFO serial execution: supported;
- several ChatGPT jobs executing in parallel on one stream: not supported.

`enqueue` returns immediately with the request identity and queue state. `ask` is still the blocking convenience command: it enqueues and then waits until that specific request gets a durable response.

## Server Mode

Server Mode is intended for a dedicated always-on Chrome machine.

When Server Mode is enabled and the user has pressed **Start Oracle**:

- the configured ChatGPT tab is maintained as the pinned worker tab;
- Chrome marks the worker as non-discardable;
- extension-local server configuration and the last safe worker snapshot are persisted independently of the tab ID;
- watchdog alarms restore the server worker after Chrome/service-worker restarts;
- if the worker tab disappears, Patient Oracle recreates it;
- interrupted `ready` revisions recover through a higher SHA-protected revision instead of redispatching the same revision;
- after a terminal response, the FIFO queue worker promotes the next pending request automatically.

The **Start/Stop button is user intent only**. Operational failures, watchdog recovery, browser restarts, and queue activation do not change that UI latch. Only the user clicking Start or Stop changes it.

Server Mode does **not** launch Chrome at the operating-system level. For reboot recovery, configure the server machine to start Chrome at sign-in and disable system sleep. ChatGPT must remain logged in.

## Response file

A successful ChatGPT handoff looks like:

```json
{
  "version": 1,
  "request_id": "REQ-001",
  "status": "complete",
  "content_type": "text/markdown",
  "answer": "# Long answer\n\nThe full answer may be many paragraphs long...",
  "completed_at": "2026-08-20T00:00:00Z"
}
```

`answer` can contain long-form Markdown, code, tables, or other text. The current browser handoff limit is 8 MiB. `needs_user` and `blocked` use `reason`. A `continue` handoff uses `reason` plus `resume_state`; the extension writes a checkpoint and publishes a higher `ready` revision for the same request.

## Files

- `manifest.json` — Manifest V3 extension using a persistent Chrome Side Panel.
- `sidepanel-background.js` — loads scheduler, Server Mode recovery, FIFO queue worker, and Side Panel behavior.
- `background.js` — active-request scheduler, durable response/checkpoint writes, revision/rate-limit safety, and fresh-chat dispatch.
- `server-mode.js` — persistent worker ownership, Chrome alarm watchdog, tab recreation, and interrupted-ready recovery.
- `server-resilience.js` — operational recovery while preserving the user Start/Stop intent latch.
- `queue-protocol.js` — strict FIFO queue envelope and append/remove helpers.
- `queue-worker.js` — promotes pending FIFO heads into the single active runtime.
- `content.js` — safe composer submission and lifecycle observation.
- `artifact-preview-v2.js` — generated response-file preview handoff fallback.
- `control.js` — strict runtime/request/response parsing, identities, file-handoff prompt, and 18/20-minute execution budget.
- `popup.html` / `popup.js` — persistent Side Panel controls including Server Mode and user-intent Start/Stop.
- `caller.mjs` — external GitHub-only enqueue/wait/ask client.
- `CONTRACT.md` — durable protocol contract.

## Run

```bash
git clone https://github.com/Kaetaeru/AI-Utilities.git
cd AI-Utilities
git switch agent/patient-oracle-mvp
cd "Patient Oracle"
npm run check
npm test
```

Then open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `AI-Utilities/Patient Oracle/`.

Open a ChatGPT tab and click the Patient Oracle toolbar icon. Configure GitHub owner/repository/branch and a least-privilege GitHub credential with Contents read/write for the target repository. For an always-on machine, enable **Server Mode** and then click **Start Oracle**.

## Caller examples

Set a GitHub token in the caller environment:

```bash
export GITHUB_TOKEN=...
```

Blocking request: enqueue and wait for the specific response.

```bash
npm run oracle:ask -- --owner OWNER --repo REPOSITORY --branch BRANCH --prompt "Your question"
```

Queue several jobs immediately:

```bash
npm run oracle:enqueue -- --owner OWNER --repo REPOSITORY --branch BRANCH --id REQ-A --prompt "Job A"
npm run oracle:enqueue -- --owner OWNER --repo REPOSITORY --branch BRANCH --id REQ-B --prompt "Job B"
npm run oracle:enqueue -- --owner OWNER --repo REPOSITORY --branch BRANCH --id REQ-C --prompt "Job C"
```

Then wait for any one of them later:

```bash
npm run oracle:wait -- --owner OWNER --repo REPOSITORY --branch BRANCH --id REQ-B
```

With Server Mode started, the worker executes A, then B, then C. An `ask` command issued while another request is active simply joins the FIFO queue and waits for its own turn.

The generated-file handoff has completed a real Chrome/ChatGPT E2E run in the development environment, but ChatGPT's browser UI remains product UI and may change, so selectors should still be treated as compatibility-sensitive.
