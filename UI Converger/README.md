# UI Converger

UI Converger is a local, Git-reversible UI implementation loop for AI Utilities. It takes an exact `UI Blueprint` target, reads the current local repository and rendered DOM, asks `Patient Oracle` for a minimal implementation step, applies only validated replacement files, and commits each iteration on a dedicated branch.

The MVP uses structured UI data rather than screenshot vision because Patient Oracle 0.4 transports text prompts and text response artifacts. Playwright screenshots are still captured locally for human review, while the machine loop compares the UI Blueprint against a structured DOM/computed-style snapshot.

## Flow

```text
UI Blueprint target
       +
local repository scan
       +
Playwright DOM snapshot
       |
       v
Patient Oracle plan / patch request
       |
       v
validated full-file replacements
       |
       v
git checkpoint commit
       |
       v
render again -> next iteration
```

## Patient Oracle deployed coordinates

UI Converger follows `Patient Oracle/AI_API_GUIDE.md`.

```text
Repository:              Kaetaeru/AI-Utilities
Extension/caller source: agent/patient-oracle-mvp
Runtime/mailbox branch:  agent/patient-oracle-e2e
Runtime path:             .patient-oracle/runtime.json
Queue path:               .patient-oracle/queue.json
```

The source branch contains Patient Oracle and `caller.mjs`. The runtime/mailbox branch is the durable API channel used by the running sub-PC worker. UI Converger defaults its Oracle fields to the deployed mailbox coordinates above. Change them only when the operator intentionally moves the mailbox.

## Durable request behavior

UI Converger uses the official sibling caller instead of editing Patient Oracle protocol files itself:

```text
../Patient Oracle/caller.mjs ask
../Patient Oracle/caller.mjs wait
```

Every logical plan or implementation iteration receives an explicit durable request ID, for example:

```text
REQ-UI-CONVERGER-20260820170700-a1b2c3-PLAN-001
REQ-UI-CONVERGER-20260820170700-a1b2c3-ITER-001
```

The first attempt uses `oracle:ask`. If the local wait times out, UI Converger keeps that exact request ID in the in-memory session. Pressing the same action again calls `oracle:wait` on that ID instead of enqueueing a duplicate request.

Terminal Patient Oracle outcomes are handled as follows:

- `complete`: parse the durable `answer` and continue.
- `needs_user`: stop the operation and surface the durable `reason`.
- `blocked`: stop the operation and surface the durable `reason`.

Patient Oracle `continue` checkpoints are internal to the worker and remain transparent to UI Converger; the caller continues waiting on the same durable request ID.

## Safety model

- The target repository must be clean before a session starts.
- UI Converger creates a dedicated `ui-converger/<session>` branch.
- Every non-empty iteration becomes a Git commit.
- Patient Oracle may change at most 20 files in one iteration.
- Absolute paths, traversal, `.git`, and `.ui-converger` model writes are rejected.
- Protected paths are enforced after the model response, not just mentioned in the prompt.
- Plan and iteration Patient Oracle work is serial; one pending request must finish before another kind starts.
- The web server listens only on `127.0.0.1`.
- `GITHUB_TOKEN` is read only by the local Node process and is not exposed to the browser UI.
- The target preview server is not started or stopped by UI Converger. Run it yourself and provide its URL.

## Requirements

- Node.js 18+
- Git
- a clean local Git repository containing the target UI
- Patient Oracle installed on the dedicated sub-PC, with ChatGPT logged in
- Patient Oracle Server Mode enabled and the user-intent latch in Start state for immediate execution
- a local checkout that contains `Patient Oracle/caller.mjs`
- a `GITHUB_TOKEN` with repository Contents access for the Patient Oracle mailbox

A stopped Patient Oracle worker does not lose requests. Calls can still enqueue durable work, but execution waits until the operator presses Start again.

## Install and run

From the UI Converger directory:

```bash
npm install
npx playwright install chromium
export GITHUB_TOKEN=...
npm start
```

On Windows PowerShell, use the appropriate environment-variable syntax; Patient Oracle's own caller commands may require `npm.cmd` when `npm.ps1` is blocked.

Start the target application's development server separately, then open:

```text
http://127.0.0.1:4174
```

The default Oracle connection shown in the UI is:

```text
Owner:                 Kaetaeru
Repository:            AI-Utilities
Runtime/mailbox branch: agent/patient-oracle-e2e
```

## Session sequence

1. Enter the target repository path and preview URL.
2. Import or paste a `uib/0.2` UI Blueprint.
3. Start the controlled session. UI Converger creates a reversible local branch and captures the current DOM/screenshot.
4. Create an implementation plan. The plan gets its own durable Patient Oracle request ID.
5. Inspect the plan, then run one implementation iteration at a time.
6. If an action reports a local Patient Oracle timeout, press that same action again. UI Converger waits on the same durable request ID rather than creating another request.
7. If Patient Oracle returns `needs_user` or `blocked`, resolve the reported reason before continuing.

The browser-visible ChatGPT response is never treated as the API result. Only Patient Oracle's durable GitHub response returned by `caller.mjs` is authoritative.
