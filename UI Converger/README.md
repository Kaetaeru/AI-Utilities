# UI Converger

UI Converger is a local, Git-reversible UI implementation loop for AI Utilities. It takes an exact `UI Blueprint` target, reads the current local repository and rendered DOM, asks `Patient Oracle` for a minimal implementation step, applies only validated replacement files, and commits each iteration on a dedicated branch.

The MVP deliberately uses structured UI data rather than screenshot vision because Patient Oracle 0.4 transports text prompts and text response artifacts. Playwright screenshots are still captured locally for human review, while the machine loop compares the UI Blueprint against a structured DOM/computed-style snapshot.

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

## Safety model

- The target repository must be clean before a session starts.
- UI Converger creates a dedicated `ui-converger/<session>` branch.
- Every non-empty iteration becomes a Git commit.
- Patient Oracle may change at most 20 files in one iteration.
- Absolute paths, traversal, `.git`, and `.ui-converger` writes are rejected.
- Protected paths are enforced after the model response, not just mentioned in the prompt.
- The web server listens only on `127.0.0.1`.
- `GITHUB_TOKEN` is read only by the local Node process and is not exposed to the browser UI.
- The target preview server is not started or stopped by UI Converger. Run it yourself and provide its URL.

## Requirements

- Node.js 18+
- Git
- a clean local Git repository containing the target UI
- Patient Oracle extension configured and started on a worker Chrome/ChatGPT session
- a GitHub repository/branch bootstrapped for Patient Oracle durable state
- a GitHub token in `GITHUB_TOKEN` with the Contents permission required by Patient Oracle

## Install

```bash
npm install
npx playwright install chromium
export GITHUB_TOKEN=...
npm start
```

Open `http://127.0.0.1:4174` after starting the target application's development server separately.

## Patient Oracle integration

UI Converger intentionally calls the existing sibling CLI instead of reimplementing the queue protocol:

```text
../Patient Oracle/caller.mjs ask
```

That keeps request creation, FIFO queueing, optimistic GitHub SHA conflict handling, runtime activation, response polling, and durable response identity inside Patient Oracle.

The current Patient Oracle request contract is text-first. UI Converger sends compact repository contents, the target UI Blueprint JSON, a structured Playwright DOM/computed-style snapshot, protected paths and user intent, and the approved implementation plan on patch iterations.

A future Patient Oracle attachment contract can add direct reference-image comparison without changing the rest of the convergence loop.
