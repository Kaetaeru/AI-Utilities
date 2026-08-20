import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseBlueprint, buildPlanPrompt, buildPatchPrompt, parsePlanAnswer, parsePatchAnswer } from "./src/protocol.mjs";
import { scanRepository } from "./src/repo-scan.mjs";
import { captureDomSnapshot } from "./src/dom-snapshot.mjs";
import {
  DEFAULT_ORACLE_COORDINATES,
  askPatientOracle,
  waitPatientOracle,
  makeOracleRequestId
} from "./src/oracle.mjs";
import { createSessionBranch, applyPatchAndCommit, lastCommitDiff } from "./src/apply.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4174);
const HOST = "127.0.0.1";
const sessions = new Map();
const MAX_BODY_BYTES = 3 * 1024 * 1024;

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/health") return json(res, 200, {
      ok: true,
      patient_oracle_token: Boolean(process.env.GITHUB_TOKEN),
      patient_oracle_mailbox: DEFAULT_ORACLE_COORDINATES
    });
    if (req.method === "POST" && req.url === "/api/session/start") return handleStart(req, res);
    if (req.method === "POST" && req.url === "/api/session/plan") return handlePlan(req, res);
    if (req.method === "POST" && req.url === "/api/session/iterate") return handleIterate(req, res);
    if (req.method === "GET") return serveStatic(req, res);
    return json(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    return json(res, Number(error?.statusCode) || 500, {
      error: error instanceof Error ? error.message : String(error),
      ...(error?.code ? { code: error.code } : {}),
      ...(error?.requestId ? { request_id: error.requestId } : {}),
      ...(error?.oracleStatus ? { oracle_status: error.oracleStatus } : {}),
      ...(error?.reason ? { reason: error.reason } : {})
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`UI Converger listening on http://${HOST}:${PORT}`);
  console.log(`Patient Oracle mailbox: ${DEFAULT_ORACLE_COORDINATES.owner}/${DEFAULT_ORACLE_COORDINATES.repo}@${DEFAULT_ORACLE_COORDINATES.branch}`);
  console.log("Patient Oracle uses GITHUB_TOKEN from this process environment.");
});

async function handleStart(req, res) {
  const body = await readJson(req);
  const blueprint = parseBlueprint(body.blueprint);
  const repoContext = await scanRepository(body.repoPath);
  if (!repoContext.clean) throw new Error(`Target repository is dirty. Commit or stash changes first: ${repoContext.dirty.slice(0, 10).join(", ")}`);
  const oracle = normalizeOracle(body.oracle);
  const previewUrl = normalizePreviewUrl(body.previewUrl);
  const protectedPaths = normalizeProtectedPaths(body.protectedPaths);
  const viewport = normalizeViewport(body.viewport);
  const sessionId = makeSessionId();
  const branch = await createSessionBranch(repoContext.root, sessionId);
  const screenshotPath = path.join(repoContext.root, ".ui-converger", "captures", `${sessionId}-initial.png`);
  const domSnapshot = await captureDomSnapshot(previewUrl, { ...viewport, screenshotPath });

  const session = {
    id: sessionId,
    repoRoot: repoContext.root,
    branch,
    previewUrl,
    oracle,
    blueprint,
    protectedPaths,
    userIntent: String(body.userIntent || "").trim(),
    viewport,
    repoContext,
    domSnapshot,
    plan: null,
    planRevision: 0,
    pendingOracle: null,
    iteration: 0,
    history: [],
    createdAt: new Date().toISOString()
  };
  sessions.set(sessionId, session);
  return json(res, 200, publicSession(session));
}

async function handlePlan(req, res) {
  const body = await readJson(req);
  const session = requireSession(body.sessionId);
  assertPendingKind(session, "plan");
  session.repoContext = await scanRepository(session.repoRoot);
  session.domSnapshot = await captureDomSnapshot(session.previewUrl, {
    ...session.viewport,
    screenshotPath: path.join(session.repoRoot, ".ui-converger", "captures", `${session.id}-plan.png`)
  });
  const prompt = buildPlanPrompt({
    blueprint: session.blueprint,
    repoContext: compactRepoContext(session.repoContext),
    domSnapshot: session.domSnapshot,
    protectedPaths: session.protectedPaths,
    userIntent: session.userIntent
  });
  const planRevision = session.pendingOracle?.kind === "plan"
    ? session.pendingOracle.ordinal
    : session.planRevision + 1;
  const requestId = makeOracleRequestId(session.id, "plan", planRevision);
  const oracleResult = await resolveOracleRequest(session, {
    kind: "plan",
    ordinal: planRevision,
    requestId,
    prompt,
    responseFormat: "application/json"
  });
  session.plan = parsePlanAnswer(oracleResult.answer);
  session.planRevision = planRevision;
  return json(res, 200, { request_id: oracleResult.requestId, plan_revision: planRevision, plan: session.plan, session: publicSession(session) });
}

async function handleIterate(req, res) {
  const body = await readJson(req);
  const session = requireSession(body.sessionId);
  if (!session.plan) throw new Error("Create and inspect a plan before running an iteration");
  assertPendingKind(session, "iteration");
  session.repoContext = await scanRepository(session.repoRoot);
  if (!session.repoContext.clean) throw new Error(`Repository changed outside UI Converger: ${session.repoContext.dirty.slice(0, 10).join(", ")}`);
  const nextIteration = session.pendingOracle?.kind === "iteration"
    ? session.pendingOracle.ordinal
    : session.iteration + 1;
  const beforeSnapshot = await captureDomSnapshot(session.previewUrl, {
    ...session.viewport,
    screenshotPath: path.join(session.repoRoot, ".ui-converger", "captures", `${session.id}-iteration-${nextIteration}-before.png`)
  });
  const prompt = buildPatchPrompt({
    blueprint: session.blueprint,
    repoContext: compactRepoContext(session.repoContext),
    domSnapshot: beforeSnapshot,
    plan: session.plan,
    protectedPaths: session.protectedPaths,
    userIntent: session.userIntent,
    iteration: nextIteration
  });
  const requestId = makeOracleRequestId(session.id, "iteration", nextIteration);
  const oracleResult = await resolveOracleRequest(session, {
    kind: "iteration",
    ordinal: nextIteration,
    requestId,
    prompt,
    responseFormat: "application/json"
  });
  const patch = parsePatchAnswer(oracleResult.answer);
  const applied = await applyPatchAndCommit(session.repoRoot, patch, {
    iteration: nextIteration,
    protectedPaths: session.protectedPaths
  });
  await sleep(1200);
  const afterSnapshot = await captureDomSnapshot(session.previewUrl, {
    ...session.viewport,
    screenshotPath: path.join(session.repoRoot, ".ui-converger", "captures", `${session.id}-iteration-${nextIteration}-after.png`)
  });
  session.iteration = nextIteration;
  session.domSnapshot = afterSnapshot;
  session.history.push({
    iteration: nextIteration,
    requestId: oracleResult.requestId,
    summary: patch.summary,
    changed: applied.changed,
    commit: applied.commit,
    createdAt: new Date().toISOString()
  });
  session.repoContext = await scanRepository(session.repoRoot);
  return json(res, 200, {
    iteration: nextIteration,
    request_id: oracleResult.requestId,
    diagnosis: patch.diagnosis,
    summary: patch.summary,
    changed_files: applied.changed,
    commit: applied.commit,
    expected_effect: patch.expected_effect,
    git_summary: await lastCommitDiff(session.repoRoot),
    before: snapshotSummary(beforeSnapshot),
    after: snapshotSummary(afterSnapshot),
    session: publicSession(session)
  });
}

async function resolveOracleRequest(session, { kind, ordinal, requestId, prompt, responseFormat }) {
  const pending = session.pendingOracle;
  if (pending && (pending.kind !== kind || pending.requestId !== requestId)) {
    throw new Error(`Patient Oracle request ${pending.requestId} is still pending; resume it before starting another request`);
  }
  if (!pending) {
    session.pendingOracle = { kind, ordinal, requestId, startedAt: new Date().toISOString() };
  }
  let result;
  try {
    result = pending
      ? await waitPatientOracle({ ...session.oracle, requestId })
      : await askPatientOracle({ ...session.oracle, requestId, prompt, responseFormat });
  } catch (error) {
    if (error?.code === "PATIENT_ORACLE_TIMEOUT") throw error;
    session.pendingOracle = null;
    throw error;
  }
  session.pendingOracle = null;
  if (result.status !== "complete") throw oracleTerminalError(result);
  return result;
}

function oracleTerminalError(result) {
  const error = new Error(`Patient Oracle returned ${result.status}: ${result.reason}`);
  error.code = `PATIENT_ORACLE_${String(result.status).toUpperCase()}`;
  error.statusCode = 409;
  error.requestId = result.requestId;
  error.oracleStatus = result.status;
  error.reason = result.reason;
  return error;
}

function assertPendingKind(session, kind) {
  if (session.pendingOracle && session.pendingOracle.kind !== kind) {
    throw new Error(`Patient Oracle request ${session.pendingOracle.requestId} is still pending; finish ${session.pendingOracle.kind} before starting ${kind}`);
  }
}

function compactRepoContext(context) {
  return {
    branch: context.branch,
    framework: context.framework,
    package: context.package,
    file_count: context.file_count,
    context_file_count: context.context_file_count,
    files: context.files
  };
}

function publicSession(session) {
  return {
    session_id: session.id,
    repo_root: session.repoRoot,
    branch: session.branch,
    preview_url: session.previewUrl,
    oracle: { owner: session.oracle.owner, repo: session.oracle.repo, branch: session.oracle.branch },
    framework: session.repoContext.framework,
    context_files: session.repoContext.context_file_count,
    iteration: session.iteration,
    plan_revision: session.planRevision,
    has_plan: Boolean(session.plan),
    pending_oracle: session.pendingOracle ? {
      kind: session.pendingOracle.kind,
      request_id: session.pendingOracle.requestId,
      started_at: session.pendingOracle.startedAt
    } : null,
    protected_paths: session.protectedPaths,
    history: session.history
  };
}

function snapshotSummary(snapshot) {
  return {
    url: snapshot.url,
    title: snapshot.title,
    viewport: snapshot.viewport,
    body: snapshot.body,
    element_count: snapshot.elements?.length || 0,
    screenshot_path: snapshot.screenshot_path || null
  };
}

function normalizeOracle(value) {
  const owner = String(value?.owner || DEFAULT_ORACLE_COORDINATES.owner).trim() || DEFAULT_ORACLE_COORDINATES.owner;
  const repo = String(value?.repo || DEFAULT_ORACLE_COORDINATES.repo).trim() || DEFAULT_ORACLE_COORDINATES.repo;
  const branch = String(value?.branch || DEFAULT_ORACLE_COORDINATES.branch).trim() || DEFAULT_ORACLE_COORDINATES.branch;
  return { owner, repo, branch };
}

function normalizePreviewUrl(value) {
  const url = new URL(String(value || "").trim());
  if (!/^https?:$/.test(url.protocol)) throw new Error("Preview URL must use http or https");
  return url.href;
}

function normalizeProtectedPaths(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || "").trim().replace(/\\/g, "/")).filter(Boolean))];
}

function normalizeViewport(value) {
  return {
    width: clamp(value?.width, 320, 3840, 1440),
    height: clamp(value?.height, 320, 2160, 1000)
  };
}

function requireSession(id) {
  const session = sessions.get(String(id || ""));
  if (!session) throw new Error("Unknown or expired UI Converger session");
  return session;
}

function makeSessionId() {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(3).toString("hex")}`;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw new Error("Request body must be valid JSON"); }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const mapping = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/styles.css": ["styles.css", "text/css; charset=utf-8"],
    "/src/app.js": ["src/app.js", "text/javascript; charset=utf-8"]
  };
  const target = mapping[url.pathname];
  if (!target) return json(res, 404, { error: "Not found" });
  const content = await fs.readFile(path.join(ROOT, target[0]));
  res.writeHead(200, { "Content-Type": target[1], "Cache-Control": "no-store" });
  res.end(content);
}

function json(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(`${JSON.stringify(value, null, 2)}\n`);
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
