# Patient Oracle 1.0 Planning Document

> Status: **Design target / not yet implemented**
>
> This document defines the intended Patient Oracle 1.0 product direction. Patient Oracle 0.4 remains the currently implemented GitHub-backed FIFO system until 1.0 replaces it through verified end-to-end milestones.

## 1. Product definition

**Patient Oracle turns a dedicated always-on sub-PC with a logged-in ChatGPT client into a remotely callable AI execution service.**

The sub-PC is not merely storage, a generic remote-control target, or a queue processor. Its primary role is to host and manage ChatGPT worker conversations.

Multiple kinds of callers must be able to use the same Patient Oracle service:

- a main ChatGPT session delegating work to Patient Oracle as an external subagent;
- another AI or automation system;
- Node.js, Python, Roblox tooling, CI, bots, or other custom applications;
- future adapters that can speak the Patient Oracle job protocol.

Every accepted job is executed by creating a **fresh ChatGPT conversation** on the sub-PC, submitting the job prompt, collecting a validated result, and returning that result to the original caller.

```text
Caller
  ├─ ChatGPT / GPT App / MCP
  ├─ another AI
  ├─ Node / Python program
  ├─ Roblox or development tool
  └─ automation / service
          │
          ▼
   Patient Oracle ingress
          │
          ▼
      Oracle Host
          │
    Worker allocation
          │
          ▼
   fresh ChatGPT tab
          │
      prompt execution
          │
     validated result
          │
          ▼
        Caller
```

## 2. Governing product policy

All major design decisions should be evaluated against this question:

> **Does this make the dedicated sub-PC's ChatGPT workers easier, faster, safer, or more reliable to manage and use remotely?**

If yes, it belongs in Patient Oracle Core or one of its adapters.

If a feature is only generic PC remote control and does not materially serve ChatGPT worker management or use, it should be a separate capability or external tool rather than part of Patient Oracle Core.

### Core policies

1. **ChatGPT is the AI execution engine.** Patient Oracle manages execution; it does not replace ChatGPT with its own inference layer.
2. **Many caller types, one job model.** GPT/MCP calls and ordinary program/API calls enter the same Oracle Core.
3. **Fresh conversation per job.** Unrelated jobs never reuse an existing ChatGPT conversation.
4. **Immediate execution is the default.** If capacity exists, a new job starts immediately.
5. **Parallelism comes from independent workers.** Multiple jobs run simultaneously in separate ChatGPT tabs/conversations.
6. **No mandatory FIFO queue.** If all worker capacity is occupied, the default result is `busy`. Waiting may be added later only as an explicit caller option.
7. **Worker tabs are ephemeral.** Once a job reaches a finalized state and its result is safely captured, the job tab is closed immediately.
8. **Worker capacity is configurable.** Patient Oracle has no product-level fixed worker count. The safe operational value depends on the host PC and ChatGPT/browser behavior.
9. **The 8 GB reference host is memory-sensitive.** The initial default should be conservative and optimized around zero idle worker tabs.
10. **Transport is replaceable.** MCP, HTTP, SDKs, and other ingress adapters must not leak transport-specific logic into ChatGPT worker execution.
11. **Every job has explicit identity.** Job state and worker events are correlated by `job_id`, `worker_id`, `tab_id`, and an execution token.
12. **Result capture precedes cleanup.** A worker tab may be closed only after its result or terminal failure state has been safely accepted by Oracle Core.

## 3. 1.0 target architecture

```text
                         external callers
          ┌──────────────────┼───────────────────┐
          │                  │                   │
     ChatGPT App          HTTP API            SDKs
       / MCP            / SSE or WS        Node / Python
          │                  │                   │
          └──────────────────┼───────────────────┘
                             ▼
                    ┌─────────────────┐
                    │   Oracle Host   │
                    │                 │
                    │ Authentication  │
                    │ Job Manager     │
                    │ Worker Manager  │
                    │ Result Store    │
                    │ Health / Logs   │
                    └────────┬────────┘
                             │ local bridge
                             ▼
                    ┌─────────────────┐
                    │ Chrome Extension│
                    │ Background      │
                    └────────┬────────┘
                             │
           ┌─────────────────┼─────────────────┐
           ▼                 ▼                 ▼
     ChatGPT tab A     ChatGPT tab B     ChatGPT tab C
     content worker    content worker    content worker
        JOB-A             JOB-B             JOB-C
```

The **Oracle Host** is the server-side control plane. The Chrome extension is the ChatGPT browser adapter.

The extension should not be treated as the whole product in 1.0.

## 4. Sub-PC lifecycle

The intended always-on host lifecycle is:

```text
Windows sign-in / boot
  -> Oracle Host starts
  -> Chrome is available
  -> Patient Oracle extension is available
  -> ChatGPT login health is checked
  -> remote ingress becomes READY
  -> zero worker tabs while idle
```

The sub-PC should remain useful as an appliance. Routine operation should not require manually preparing a worker tab before every request.

### Idle target

For the 8 GB RAM server PC, the desired idle state is:

```text
Oracle Host: running
Chrome: running if required by the selected browser-control architecture
Patient Oracle extension: loaded
ChatGPT worker tabs: 0
Active jobs: 0
```

If Chrome/extension constraints require one persistent control tab, 1.0 may retain exactly one low-cost control tab, but this must be justified by implementation reliability rather than assumed as a product requirement.

## 5. Worker model

A **worker is an execution slot**, not a permanently open ChatGPT tab.

A worker exists logically in Oracle Core and receives a browser tab only while it owns a job.

### Worker lifecycle

```text
IDLE SLOT
  -> job accepted
  -> create fresh ChatGPT tab/conversation
  -> bind job_id + worker_id + tab_id + execution_token
  -> dispatch prompt
  -> observe execution
  -> capture and validate result
  -> commit terminal job state
  -> close ChatGPT tab
  -> release browser references and transient state
  -> IDLE SLOT
```

Terminal cleanup applies to every terminal outcome:

```text
complete   -> persist result -> close tab -> release slot
failed     -> persist failure -> close tab -> release slot
timeout    -> persist timeout -> close tab -> release slot
cancelled  -> stop execution  -> persist cancellation -> close tab -> release slot
```

No completed or failed worker tab should remain open merely for convenience.

## 6. Parallel worker pool

Patient Oracle 1.0 supports multiple simultaneous ChatGPT jobs.

Example:

```text
max_workers = 3

Worker 1 -> JOB-A -> ChatGPT conversation A
Worker 2 -> JOB-B -> ChatGPT conversation B
Worker 3 -> idle

new JOB-C
  -> Worker 3
  -> new ChatGPT conversation C
  -> starts immediately
```

### Worker limit

`max_workers` is a configurable operational limit, not a hard-coded product maximum.

For the current 8 GB RAM sub-PC, the initial recommended default is:

```text
max_workers = 2
idle_worker_retention = 0
```

The implementation must work correctly for other configured values. The safe value should later be established empirically with memory, browser stability, and simultaneous ChatGPT execution tests.

Suggested validation progression:

```text
2 workers -> stability baseline
3 workers -> load and memory validation
4 workers -> load and memory validation
higher    -> only after measured evidence
```

### Capacity exhaustion

Default behavior when every worker slot is active:

```json
{
  "status": "busy",
  "active_workers": 2,
  "max_workers": 2
}
```

1.0 should not silently turn this into a durable FIFO job unless the caller explicitly opts into a future waiting mode.

## 7. One installed extension, independent per-tab execution

Patient Oracle does **not** require a separately installed browser extension for every worker tab.

The intended design is:

- one installed Patient Oracle Chrome extension;
- one extension background/service-worker control plane;
- one independent content-script execution context inside each ChatGPT worker tab;
- an explicit mapping between Oracle jobs and Chrome tabs.

Example internal registry:

```text
JOB-A -> worker-1 -> tab 104 -> execution token EA
JOB-B -> worker-2 -> tab 108 -> execution token EB
```

Each content worker must accept commands only for its bound execution identity. Events from another tab, a closed job, or an older execution token must be ignored.

This preserves tab isolation without multiplying extension installations.

## 8. Fresh conversation policy

Every unrelated job receives a fresh ChatGPT conversation.

```text
JOB-A -> Conversation A
JOB-B -> Conversation B
JOB-C -> Conversation C
```

Conversation reuse across unrelated jobs is prohibited because it introduces:

- accidental context leakage;
- cross-caller data contamination;
- harder cancellation and timeout semantics;
- ambiguous result attribution;
- growing browser memory use;
- unpredictable model behavior due to hidden prior conversation context.

### Continuation exception

A continuation belongs to the same logical job. If a job requires continuation beyond one execution window, Patient Oracle may create a **new** ChatGPT conversation using an explicit checkpoint/resume payload.

The preferred memory-sensitive behavior is:

```text
capture checkpoint
  -> close old job tab
  -> open fresh tab
  -> submit checkpoint + continuation instruction
```

A long-running job should not keep an obsolete browser tab alive solely to preserve conversation state when a safe explicit checkpoint can be used instead.

## 9. Caller interfaces

Patient Oracle Core exposes one job service through multiple adapters.

### 9.1 GPT / subagent interface

A ChatGPT App/MCP adapter should expose a compact surface such as:

```text
patient_oracle.ask
patient_oracle.start
patient_oracle.get
patient_oracle.cancel
patient_oracle.status
```

This allows a main GPT to delegate work to the sub-PC as an external subagent.

Example conceptual use:

```text
Parent GPT
  -> patient_oracle.ask("Independently analyze this problem...")
  -> Oracle Host
  -> fresh sub-PC ChatGPT conversation
  -> result
  -> Parent GPT synthesizes result
```

The parent GPT must explicitly send the context needed by the child worker. Hidden parent context is not assumed to be available to Patient Oracle workers.

### 9.2 Programmatic interface

Ordinary programs should be able to use the same service without ChatGPT/MCP.

Candidate HTTP interface:

```text
POST   /v1/ask
POST   /v1/jobs
GET    /v1/jobs/{job_id}
DELETE /v1/jobs/{job_id}
GET    /v1/status
```

`/v1/ask` is blocking request/response convenience behavior.

`POST /v1/jobs` starts an immediately executable asynchronous job and returns a `job_id`.

`GET /v1/jobs/{job_id}` returns progress or the terminal result.

`DELETE /v1/jobs/{job_id}` requests cancellation.

SSE or WebSocket support may later provide progress/lifecycle events without changing Oracle Core semantics.

### 9.3 SDKs

Node.js and Python SDKs may be thin wrappers around the same programmatic interface.

Conceptual Node usage:

```js
const result = await oracle.ask({
  prompt: "Analyze this problem independently."
});
```

Conceptual concurrent use:

```js
const [a, b] = await Promise.all([
  oracle.ask({ prompt: "Analyze document A" }),
  oracle.ask({ prompt: "Analyze document B" })
]);
```

If two worker slots are available, both jobs should start in separate fresh ChatGPT conversations without waiting on each other.

## 10. Unified job model

All ingress adapters create the same internal job type.

Candidate shape:

```json
{
  "job_id": "PO-01K...",
  "origin": "chatgpt",
  "parent_job_id": null,
  "status": "running",
  "prompt": "...",
  "created_at": "...",
  "started_at": "...",
  "completed_at": null,
  "worker_id": "worker-2"
}
```

Core statuses for 1.0:

```text
starting
running
complete
failed
timeout
cancelled
```

`busy` is preferably an admission response when no worker can be allocated, rather than a stored job status for a job that never started.

## 11. GPT subagent policy

Patient Oracle should make subagent delegation natural without allowing uncontrolled recursive spawning.

Initial policy recommendation:

- Main GPT may call Patient Oracle.
- Patient Oracle worker ChatGPT sessions should **not** initially receive the Patient Oracle App themselves.
- Therefore a Patient Oracle worker cannot recursively spawn another Oracle worker in v1.0.

This provides a simple one-level delegation model:

```text
Main GPT
  -> Oracle worker A
  -> Oracle worker B
```

rather than:

```text
Main GPT
  -> worker A
     -> worker B
        -> worker C
           -> ...
```

Recursive delegation can be added later only with explicit depth, budget, and authorization controls.

## 12. Prompt dispatch and result handoff

Patient Oracle should preserve the strongest safety property from the 0.x implementation:

> **Ordinary assistant prose DOM is not the authoritative machine response channel.**

For 1.0, the initially preferred completion handoff remains an explicitly generated, job-bound response artifact if it proves reliable under multi-tab load.

Example:

```text
patient-oracle-response-<job_id>.json
```

A complete result should contain at minimum:

```json
{
  "version": 1,
  "job_id": "PO-...",
  "status": "complete",
  "content_type": "text/markdown",
  "answer": "..."
}
```

The extension/controller validates job identity before delivering the result to Oracle Host.

The result channel may be replaced in the future if ChatGPT exposes a more reliable machine-readable browser integration, but 1.0 must not regress to scraping arbitrary assistant prose as durable proof of completion.

## 13. Per-tab execution safety

Multi-worker execution makes event isolation a first-class requirement.

Each worker tab must be bound to:

```text
job_id
worker_id
tab_id
execution_token
conversation identity, when reliably observable
```

Every lifecycle event must carry enough identity to prove which worker produced it.

A stale event is ignored if any binding no longer matches the active worker assignment.

Examples of stale events:

- a late artifact event from a tab already cancelled;
- a DOM completion event from a previous job on a recycled internal worker slot;
- an event from tab A accidentally delivered while processing job B;
- an extension event emitted after Oracle Host has already timed out and invalidated the execution token.

## 14. Composer and dispatch safety

Existing 0.x browser safety rules remain valuable and should be preserved per worker tab:

- do not overwrite a non-empty ChatGPT composer;
- dispatch only into an expected fresh job conversation;
- require visible submission evidence after sending;
- distinguish composer missing, composer synchronization failure, and dispatch evidence failure;
- never infer successful execution merely because prompt text was inserted;
- never auto-approve GitHub/OAuth/admin/permission UI or other privileged browser prompts.

With ephemeral job tabs, a non-empty composer should be exceptional. If encountered, the controller should treat it as an unexpected state rather than silently replacing it.

## 15. Memory policy for the 8 GB host

The current target sub-PC has **8 GB RAM**. 1.0 must be designed around that constraint.

### Required memory behaviors

- zero idle ChatGPT worker tabs where practical;
- create worker tabs only after a job has been admitted;
- close job tabs immediately after safe terminal result capture;
- close failed, cancelled, and timed-out tabs as part of terminal cleanup;
- do not retain completed conversations as local history for Patient Oracle's benefit;
- do not preload `max_workers` tabs;
- avoid using browser tabs as the durable job database;
- release per-tab extension/background state when the worker terminates.

### Initial operating profile

```text
RAM: 8 GB
max_workers default: 2
worker tabs while idle: 0
completed worker retention: 0 seconds
failed worker retention: 0 seconds
timeout worker retention: 0 seconds
```

Memory telemetry should later be used to recommend a higher or lower worker count for a specific host.

## 16. Local state and recovery

GitHub is not required as the 1.0 execution transport.

Oracle Host should maintain minimal local durable state sufficient for:

- job identity;
- terminal results;
- crash recovery metadata;
- worker ownership;
- operational logs;
- configuration.

SQLite is a strong candidate, but the storage engine is an implementation choice rather than a product requirement.

The local store is **not** intended to recreate the 0.4 FIFO model.

On restart, any job that was `starting` or `running` and cannot be proven to still own a valid worker should become an explicit interrupted/failed recovery state rather than being silently duplicated.

## 17. Remote availability and server administration

Patient Oracle 1.0 manages use of the sub-PC as a GPT host.

The administration surface should expose at least:

```text
Remote Access: enabled / disabled
Host status
ChatGPT login health
Chrome/extension bridge health
Configured max workers
Active workers
Active jobs
Recent terminal jobs
Errors / recovery state
Emergency stop
```

The remote-access intent setting should follow the same principle already proven in 0.3.2:

> **Only the user changes user intent. Operational failures do not silently flip the user's Start/Stop or Remote Access choice.**

A failure changes health/status; it does not rewrite user intent.

## 18. Security boundaries

Patient Oracle grants remote callers access to a logged-in ChatGPT execution environment, so caller authentication and job isolation are mandatory.

1. Remote ingress must require authentication.
2. Credentials must never be embedded into delegated prompts.
3. Caller identity should be logged with each job.
4. One caller's job must not inherit another caller's ChatGPT conversation.
5. Job results must be returned only through the job identity that owns them.
6. Worker tabs must never expose existing unrelated user conversations as execution targets.
7. Remote API exposure should be restricted to the smallest practical network surface.
8. Cancellation and emergency stop must invalidate execution tokens before tab teardown to prevent late-result resurrection.

## 19. What 1.0 keeps from Patient Oracle 0.x

The 0.x implementation contains browser-control techniques worth preserving and generalizing:

- fresh ChatGPT conversation dispatch;
- composer protection;
- prompt synchronization and dispatch evidence;
- generated response-file handoff;
- exact response identity validation;
- execution tokens and stale-event rejection;
- bounded execution time;
- checkpoint/continuation concepts;
- browser lifecycle observation;
- user-intent Start/Stop semantics;
- server/watchdog recovery lessons.

These should be extracted from GitHub-stream assumptions and made worker-scoped.

## 20. What 1.0 is allowed to remove

The following 0.4 mechanisms are **not architectural commitments** for 1.0:

```text
GitHub as runtime transport
.patient-oracle/runtime.json
.patient-oracle/queue.json
requests/ mailbox
responses/ mailbox
GitHub polling
GitHub SHA queue CAS
single-stream FIFO scheduling
caller.mjs GitHub transport
one persistent worker tab
```

They may remain temporarily during migration/testing, but 1.0 design decisions should not preserve them merely because they already exist.

## 21. Proposed 1.0 implementation components

Candidate structure:

```text
Patient Oracle/
├─ host/
│  ├─ oracle-host
│  ├─ job-manager
│  ├─ worker-manager
│  ├─ result-store
│  └─ bridge
│
├─ extension/
│  ├─ background
│  ├─ worker-content
│  ├─ response-handoff
│  └─ lifecycle
│
├─ adapters/
│  ├─ mcp
│  ├─ http
│  └─ sdk
│
├─ dashboard/
│  └─ host administration UI
│
└─ tests/
   ├─ unit
   ├─ multi-worker
   ├─ browser-e2e
   └─ recovery
```

The exact repository migration can be decided during implementation; this is a responsibility split, not a required immediate folder rewrite.

## 22. Development milestones

### Milestone 1 — Live single-worker transport

Goal: remove GitHub from the hot path for one job.

```text
program -> Oracle Host -> extension -> fresh ChatGPT tab
        -> prompt -> validated result -> program
```

Success criteria:

- one live request starts without GitHub polling;
- fresh ChatGPT conversation is created;
- answer is captured by explicit job identity;
- result returns to caller;
- worker tab closes automatically;
- idle state returns to zero worker tabs.

### Milestone 2 — Host API

Add the unified job service:

```text
ask
start
get
cancel
status
```

Validate cancellation, timeout, crash recovery, and terminal cleanup.

### Milestone 3 — Multi-worker browser execution

Goal: prove true parallel ChatGPT jobs.

Success criteria:

- `max_workers = 2` on the 8 GB host;
- two simultaneous jobs create two independent ChatGPT tabs;
- job events cannot cross between tabs;
- both results return to their correct caller identities;
- each tab closes after its own terminal result;
- third concurrent job returns `busy` when both slots are occupied.

### Milestone 4 — GPT/MCP adapter

Expose Patient Oracle as an external subagent tool to a main GPT using the same Oracle Core job model.

Validate:

```text
Main GPT -> Oracle worker A
Main GPT -> Oracle worker B
Main GPT combines results
```

### Milestone 5 — 8 GB stability and worker tuning

Measure:

- idle RAM;
- one-worker RAM;
- two-worker RAM;
- three-worker RAM;
- completion cleanup;
- repeated job memory growth;
- Chrome/extension stability over long uptime.

Use measured results to choose the default/recommended `max_workers` for the server PC.

### Milestone 6 — Server appliance behavior

Implement:

- startup recovery;
- health checks;
- management dashboard;
- Remote Access intent control;
- emergency stop;
- logs and diagnostics.

## 23. 1.0 acceptance scenario

The representative end-to-end scenario is:

```text
1. Sub-PC is on, logged in, and idle with zero worker tabs.
2. A main GPT delegates Task A through Patient Oracle MCP.
3. At nearly the same time, a custom program sends Task B through the normal API.
4. Oracle Host allocates two worker slots.
5. Two fresh ChatGPT conversations open on the sub-PC.
6. Each tab receives only its assigned prompt.
7. ChatGPT executes both jobs independently.
8. Each result is captured and validated against the correct job identity.
9. Task A returns to the parent GPT.
10. Task B returns to the custom program.
11. Each worker tab closes immediately after its result is secured.
12. Both worker slots return to idle.
13. The sub-PC again has zero worker tabs and remains ready for the next call.
```

If this behavior is reliable, Patient Oracle 1.0 has achieved its central purpose.

## 24. Short product statement

> **Patient Oracle manages and exposes ChatGPT sessions running on a dedicated always-on sub-PC as remotely callable, parallel, ephemeral AI workers for GPTs and ordinary programs.**
