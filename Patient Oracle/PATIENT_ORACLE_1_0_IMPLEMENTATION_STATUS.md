# Patient Oracle 1.0 Implementation Status

> Current code version: **0.5.0**
>
> This file tracks implementation progress toward the design in `PATIENT_ORACLE_1_0_PLAN.md`. It distinguishes code that exists from behavior that has been browser-E2E verified.

## Implemented in 0.5.0

The first Live 1.0 foundation is now present alongside the verified 0.4 GitHub-backed path.

- `live-control.js`
  - unified live Job model;
  - configurable worker capacity;
  - default `maxWorkers = 2` for the 8 GB reference host;
  - no mandatory queue: full capacity returns `busy`;
  - disposable worker prompt and strict generated-file result contract.
- `live-store.js`
  - IndexedDB-backed live job/result persistence so large answers are not kept only in service-worker memory.
- `live-worker-manager.js`
  - accepts internal Live start/status/get/cancel messages;
  - atomically reserves worker capacity;
  - creates a fresh background ChatGPT tab per accepted job;
  - maps `job_id`, `worker_id`, `tab_id`, and execution token;
  - supports multiple independent live jobs up to configured capacity;
  - verifies result identity before terminalizing a job;
  - closes terminal worker tabs after the result is safely stored;
  - returns `busy` rather than silently queueing when capacity is full;
  - marks missing/closed active worker tabs failed during recovery.
- `live-content.js`
  - isolated live prompt dispatch path;
  - empty-composer protection;
  - dispatch evidence requirement;
  - lifecycle observation;
  - 18-minute finalization checkpoint and 20-minute hard stop;
  - direct generated-file capture when ChatGPT exposes a readable URL.
- `live-artifact-preview.js`
  - isolated preview fallback for generated-file cards that do not expose a directly readable URL.
- `live-panel.js`
  - one Side Panel controls the Live worker pool;
  - user-controlled `Accept live jobs` switch;
  - configurable maximum workers;
  - active worker/capacity display;
  - recent job display and cancel action;
  - manual test prompt entry for browser E2E testing.

The existing extension is still a single installed extension. Worker tabs do **not** install separate extensions; each ChatGPT tab receives its own isolated content-script state while the extension service worker owns the global job-to-tab mapping.

## Validation completed so far

Assistant-side isolated validation:

- syntax checks passed for all newly added Live 1.0 JavaScript modules;
- `tests/live-control.test.mjs`: **6/6 passed**.

The assistant execution environment could not clone GitHub for a full repository test because outbound DNS access to `github.com` was unavailable. The remote branch files and wiring were therefore re-read through the GitHub connector after publication.

## Not yet browser-E2E verified

Do not claim the following until tested on the dedicated sub-PC:

- fresh Live job opens a new ChatGPT tab and dispatches successfully;
- two Live jobs run concurrently in two independent tabs;
- a valid response artifact closes only the matching worker tab;
- a third request returns `busy` when `maxWorkers = 2` and two jobs are active;
- cancel and hard-stop close the correct worker without affecting another worker;
- service-worker restart recovery works during multiple active Live jobs.

## Not implemented yet

These are the next major 1.0 layers:

1. external real-time ingress for ordinary programs (HTTP/streaming API);
2. ChatGPT App/MCP ingress for using Patient Oracle as an external subagent;
3. authentication and remote-access boundary for those ingress adapters;
4. Node/Python client SDKs over the same unified Job API;
5. production server lifecycle/health controls and richer Side Panel administration;
6. continuation policy for work that cannot finalize in one 20-minute Live worker turn.

The 0.4 GitHub queue/runtime transport remains present only as a compatibility path while Live 1.0 is developed and verified. It is not the target transport architecture for 1.0.
