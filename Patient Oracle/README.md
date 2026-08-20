# Patient Oracle

> **A question may wait. Its answer must return with its identity intact.**

Patient Oracle is a standalone Chrome extension and GitHub-backed request/response worker. A caller publishes durable requests through GitHub, the extension dispatches each authorized request into a fresh ChatGPT conversation, ChatGPT creates a generated JSON response file, and the extension validates that file and performs the durable GitHub response/runtime writes with the configured GitHub credential.

Patient Oracle does **not** use the ChatGPT GitHub plugin for worker execution. GitHub remains the only durable source of truth; generated ChatGPT files are transient handoff artifacts.

## Flow

```text
external caller
  -> GitHub request + ready runtime
  -> Patient Oracle extension
  -> fresh ChatGPT conversation
  -> generated patient-oracle-response-<request_id>.json
  -> Patient Oracle validates the file/preview
  -> GitHub response/checkpoint first
  -> GitHub runtime last
  -> caller reads durable response
```

Ordinary assistant prose is never the durable answer API.

## Server Mode

Patient Oracle 0.3 adds an optional persistent **Server Mode** for a dedicated always-on Chrome machine.

When Server Mode is enabled and Oracle is started:

- the current ChatGPT tab becomes the pinned worker tab;
- Chrome marks the worker as non-discardable;
- extension-local server configuration and the last safe worker snapshot are persisted independently of the tab ID;
- a Chrome alarm watchdog checks the worker once per minute;
- if the worker tab disappears, Patient Oracle creates a new inactive pinned ChatGPT worker tab and restores the stream;
- after Chrome restarts, the worker is restored when Chrome starts;
- if an already-dispatched `ready` revision was interrupted by the browser/tab loss, recovery publishes a SHA-protected higher `ready` revision for the same `request_id` rather than dispatching the same revision twice.

Server Mode does **not** launch Chrome at the operating-system level. For reboot recovery, configure the server machine to start Chrome at sign-in and disable system sleep. ChatGPT must remain logged in.

Fatal protocol stops such as revision regression are not blindly restarted by the watchdog.

## Request IDs and concurrency

Every request gets a durable `request_id` such as `REQ-...`. That identity lets requests and responses remain separate and is the foundation for a future queue.

The current 0.3 protocol is still **single-active-request / serial execution**. `runtime.json` selects one active request, and `caller.mjs` accepts a new request only when runtime is `complete`. Multiple callers therefore cannot currently enqueue several jobs at once. A durable multi-request queue can be added on top of these request IDs without changing the response identity model.

This distinction is intentional:

- many historical requests/responses: supported;
- one active request at a time: supported;
- several requests waiting in a durable queue: not yet implemented;
- several ChatGPT jobs executing in parallel on one stream: not supported.

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
- `sidepanel-background.js` — loads the scheduler, Server Mode watchdog, and Side Panel behavior.
- `background.js` — GitHub scheduler, direct bootstrap, durable response/checkpoint writes, revision/rate-limit safety, and fresh-chat dispatch.
- `server-mode.js` — persistent worker ownership, Chrome alarm watchdog, tab recreation, and interrupted-ready recovery.
- `content.js` — safe composer submission and lifecycle observation.
- `artifact-preview-v2.js` — generated response-file preview handoff fallback.
- `control.js` — strict runtime/request/response parsing, identities, file-handoff prompt, and 18/20-minute execution budget.
- `popup.html` / `popup.js` — persistent Side Panel controls including Server Mode.
- `caller.mjs` — external GitHub-only request publisher and response waiter.
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

For external requests:

```bash
export GITHUB_TOKEN=...
npm run oracle:ask -- --owner OWNER --repo REPOSITORY --branch BRANCH --prompt "Your question" --response-format text/markdown
```

The generated-file handoff has completed a real Chrome/ChatGPT E2E run in the development environment, but ChatGPT's browser UI remains product UI and may change, so selectors should still be treated as compatibility-sensitive.
