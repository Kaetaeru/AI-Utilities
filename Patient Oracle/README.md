# Patient Oracle

> **A question may wait. Its answer must return with its identity intact.**

Patient Oracle is a standalone Chrome extension and GitHub-backed request/response worker. A caller publishes durable requests through GitHub, the extension dispatches each authorized request into a fresh ChatGPT conversation, ChatGPT creates a generated JSON response file, and the extension validates that file and performs the durable GitHub response/runtime writes with the configured GitHub credential.

Patient Oracle does **not** use the ChatGPT GitHub plugin for worker execution. This removes recurring GitHub plugin approval prompts from the normal request path. GitHub remains the only durable source of truth; generated ChatGPT files are transient handoff artifacts.

This utility is independent from the Rerun extension. Rerun is only the reference for inherited safety rules such as the 18-minute checkpoint, 20-minute hard stop, duplicate-dispatch prevention, revision monotonicity, composer protection, manual approval safety, and recovery polling.

## Flow

```text
external caller
  -> GitHub request + ready runtime
  -> Patient Oracle extension
  -> fresh ChatGPT conversation
  -> generated patient-oracle-response-<request_id>.json
  -> Patient Oracle extension validates the file
  -> GitHub response/checkpoint first
  -> GitHub runtime last
  -> caller reads durable response
```

Ordinary assistant DOM text is never the answer API. The content script observes lifecycle state and locates the generated response-file link only.

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
- `sidepanel-background.js` — opens the Side Panel and loads the scheduler worker.
- `background.js` — GitHub scheduler, direct bootstrap, durable response/checkpoint writes, revision/rate-limit safety, and fresh-chat dispatch.
- `content.js` — safe composer submission, lifecycle observation, and generated response-file capture; never scrapes assistant prose.
- `control.js` — strict runtime/request/response parsing, identities, file-handoff prompt, and 18/20-minute execution budget.
- `popup.html` / `popup.js` — persistent Side Panel controls.
- `caller.mjs` — external GitHub-only request publisher and response waiter.
- `CONTRACT.md` — protocol contract copied into target repositories during extension-owned bootstrap.

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

Open a ChatGPT tab and click the Patient Oracle toolbar icon. Configure GitHub owner/repository/branch and a least-privilege GitHub credential with Contents read/write for the target repository, then click **Start Oracle**. The credential is required because the extension now owns all durable GitHub writes.

For external requests:

```bash
export GITHUB_TOKEN=...
npm run oracle:ask -- --owner OWNER --repo REPOSITORY --branch BRANCH --prompt "Your question" --response-format text/markdown
```

## Current E2E gate

The code path is designed to recognize the exact generated response filename and fetch the linked file directly, with a service-worker fallback for `chatgpt.com` and `*.oaiusercontent.com` URLs. ChatGPT's generated-file DOM is product UI and may change, so a real Chrome + ChatGPT E2E run is required before treating the file capture selectors as stable.
