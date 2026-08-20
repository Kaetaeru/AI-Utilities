#!/usr/bin/env node
import { ORACLE_QUEUE_PATH, appendQueueItem, emptyQueue, parseQueuePayload, queuePosition, removeQueueItem } from "./queue-protocol.js";

const API_ROOT = "https://api.github.com";
const RUNTIME_PATH = ".patient-oracle/runtime.json";
const MAX_QUEUE_CAS_ATTEMPTS = 10;
const [command = "", ...argv] = process.argv.slice(2);
const args = parseArgs(argv);

main().catch((error) => {
  console.error(`[patient-oracle] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

async function main() {
  if (!["enqueue", "wait", "ask"].includes(command)) throw new Error("Usage: caller.mjs <enqueue|wait|ask> --owner OWNER --repo REPO [--branch BRANCH] [--prompt TEXT] [--id REQUEST_ID] [--response-format FORMAT]");
  const context = {
    owner: required("owner"),
    repo: required("repo"),
    branch: String(args.branch || "main").trim() || "main",
    token: String(process.env.GITHUB_TOKEN || "").trim()
  };
  validateToken(context.token);
  if (command === "enqueue") return print(await enqueue(context));
  if (command === "wait") return print(await wait(context, required("id")));
  const queued = await enqueue(context);
  return print(await wait(context, queued.request_id));
}

async function enqueue(context) {
  const requestId = normalizeId(args.id || makeId());
  const prompt = required("prompt");
  const responseFormat = args["response-format"] ? String(args["response-format"]) : "";
  const requestPath = `.patient-oracle/requests/${requestId}.json`;
  const responsePath = `.patient-oracle/responses/${requestId}.json`;

  if (await getFile(context, responsePath, true)) throw new Error(`request ${requestId} already has a durable response and cannot be reused`);

  let request;
  const existing = await getFile(context, requestPath, true);
  if (existing) {
    request = parseRequest(existing.text, requestId);
    if (request.prompt !== prompt || String(request.response_format || "") !== responseFormat) throw new Error(`request ${requestId} already exists with different content`);
  } else {
    request = {
      version: 1,
      request_id: requestId,
      prompt,
      created_at: new Date().toISOString(),
      ...(responseFormat ? { response_format: responseFormat } : {})
    };
    await putFile(context, requestPath, request, `patient-oracle: request ${requestId}`);
  }

  const queued = await appendToQueue(context, requestId, request.created_at);
  const activation = await tryActivateQueueHead(context);
  const latestQueue = await getQueue(context);
  const position = latestQueue ? queuePosition(latestQueue.queue, requestId) : 0;
  const runtime = parseRuntime((await getFile(context, RUNTIME_PATH)).text);
  const active = runtime.status === "ready" && runtime.request_id === requestId;
  return {
    request_id: requestId,
    status: active ? "ready" : "queued",
    queue_position: active ? 0 : (position || queued.position),
    runtime_revision: active ? runtime.revision : null,
    ...(activation.activated ? { activated_request_id: activation.requestId } : {})
  };
}

async function appendToQueue(context, requestId, enqueuedAt) {
  for (let attempt = 0; attempt < MAX_QUEUE_CAS_ATTEMPTS; attempt += 1) {
    const file = await getFile(context, ORACLE_QUEUE_PATH, true);
    const queue = file ? parseQueuePayload(file.text) : emptyQueue();
    const result = appendQueueItem(queue, requestId, enqueuedAt);
    if (!result.inserted) return { inserted: false, position: result.position };
    try {
      await putFile(context, ORACLE_QUEUE_PATH, result.queue, `patient-oracle: enqueue ${requestId}`, file?.sha || null);
      return { inserted: true, position: result.position };
    } catch (error) {
      if (!isConflict(error)) throw error;
      await sleep(100 + attempt * 50);
    }
  }
  throw new Error(`could not append ${requestId} to Patient Oracle queue after concurrent updates`);
}

async function tryActivateQueueHead(context) {
  for (let stale = 0; stale < 20; stale += 1) {
    const runtimeFile = await getFile(context, RUNTIME_PATH);
    const runtime = parseRuntime(runtimeFile.text);
    if (runtime.status === "ready") return { activated: false, reason: "already_active", requestId: runtime.request_id };

    const queueFile = await getQueue(context);
    const head = queueFile?.queue.items[0];
    if (!head) return { activated: false, reason: "queue_empty" };

    if (await getFile(context, `.patient-oracle/responses/${head.request_id}.json`, true)) {
      await removeFromQueue(context, head.request_id);
      continue;
    }

    const requestFile = await getFile(context, `.patient-oracle/requests/${head.request_id}.json`, true);
    if (!requestFile) return { activated: false, reason: "missing_request", requestId: head.request_id };

    const nextRuntime = {
      version: 1,
      run_id: runtime.run_id,
      revision: runtime.revision + 1,
      status: "ready",
      request_id: head.request_id,
      reason: "activated from Patient Oracle FIFO queue",
      updated_at: new Date().toISOString()
    };
    try {
      await putFile(context, RUNTIME_PATH, nextRuntime, `patient-oracle: activate ${head.request_id}`, runtimeFile.sha);
    } catch (error) {
      if (isConflict(error)) return { activated: false, reason: "runtime_raced", requestId: head.request_id };
      throw error;
    }
    await removeFromQueue(context, head.request_id);
    return { activated: true, requestId: head.request_id, revision: nextRuntime.revision };
  }
  return { activated: false, reason: "too_many_stale_heads" };
}

async function removeFromQueue(context, requestId) {
  for (let attempt = 0; attempt < MAX_QUEUE_CAS_ATTEMPTS; attempt += 1) {
    const file = await getFile(context, ORACLE_QUEUE_PATH, true);
    if (!file) return { removed: false };
    const queue = parseQueuePayload(file.text);
    const result = removeQueueItem(queue, requestId);
    if (!result.removed) return { removed: false };
    try {
      await putFile(context, ORACLE_QUEUE_PATH, result.queue, `patient-oracle: dequeue ${requestId}`, file.sha);
      return { removed: true };
    } catch (error) {
      if (!isConflict(error)) throw error;
      await sleep(100 + attempt * 50);
    }
  }
  return { removed: false, reason: "queue_conflict" };
}

async function getQueue(context) {
  const file = await getFile(context, ORACLE_QUEUE_PATH, true);
  return file ? { file, queue: parseQueuePayload(file.text) } : null;
}

async function wait(context, requestIdInput) {
  const requestId = normalizeId(requestIdInput);
  const responsePath = `.patient-oracle/responses/${requestId}.json`;
  const pollSeconds = numberArg("poll-seconds", 5, 5, 300);
  const timeoutSeconds = numberArg("timeout-seconds", 1800, 5, 86400);
  const started = Date.now();
  while (Date.now() - started < timeoutSeconds * 1000) {
    const responseFile = await getFile(context, responsePath, true);
    if (responseFile) {
      const response = parseResponse(responseFile.text, requestId);
      return response.status === "complete"
        ? { request_id: requestId, status: "complete", content_type: response.content_type, answer: response.answer, completed_at: response.completed_at, ...(response.metadata ? { metadata: response.metadata } : {}) }
        : { request_id: requestId, status: response.status, reason: response.reason, completed_at: response.completed_at };
    }
    const runtime = parseRuntime((await getFile(context, RUNTIME_PATH)).text);
    if (runtime.request_id === requestId && ["needs_user", "blocked"].includes(runtime.status)) return { request_id: requestId, status: runtime.status, reason: runtime.reason || "Patient Oracle requires intervention" };
    await sleep(pollSeconds * 1000);
  }
  throw new Error(`timed out waiting for ${responsePath}`);
}

async function getFile(context, path, allow404 = false) {
  const response = await fetch(readUrl(context, path), { headers: headers(context.token), cache: "no-store" });
  if (response.status === 404 && allow404) return null;
  if (!response.ok) throw await githubError(response, `read ${path}`);
  const body = await response.json();
  if (body?.type !== "file" || typeof body.content !== "string" || typeof body.sha !== "string") throw new Error(`${path} did not resolve to a file`);
  return { sha: body.sha, text: Buffer.from(body.content.replace(/\n/g, ""), "base64").toString("utf8") };
}

async function putFile(context, path, value, message, sha = null) {
  const body = { message, branch: context.branch, content: Buffer.from(`${JSON.stringify(value, null, 2)}\n`).toString("base64") };
  if (sha) body.sha = sha;
  const response = await fetch(writeUrl(context, path), { method: "PUT", headers: { ...headers(context.token), "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw await githubError(response, `write ${path}`);
}

function parseRequest(text, requestId) {
  const value = parseObject(text, "request");
  if (value.version !== 1 || value.request_id !== requestId || typeof value.prompt !== "string" || !value.prompt.trim() || typeof value.created_at !== "string" || !Number.isFinite(Date.parse(value.created_at))) throw new Error(`request ${requestId} is invalid`);
  return value;
}

function parseRuntime(text) {
  const value = parseObject(text, "runtime");
  rejectUnknown(value, ["version","run_id","revision","status","request_id","reason","updated_at"], "runtime");
  if (value.version !== 1 || typeof value.run_id !== "string" || !value.run_id || !Number.isSafeInteger(value.revision) || value.revision < 0 || !["ready","complete","needs_user","blocked"].includes(value.status)) throw new Error("invalid runtime");
  if (value.status === "ready" && !String(value.request_id || "").trim()) throw new Error("ready runtime requires request_id");
  return value;
}

function parseResponse(text, requestId) {
  const value = parseObject(text, "response");
  rejectUnknown(value, ["version","request_id","status","content_type","answer","reason","completed_at","metadata"], "response");
  if (value.version !== 1 || value.request_id !== requestId || !["complete","needs_user","blocked"].includes(value.status)) throw new Error("invalid response identity or status");
  if (typeof value.completed_at !== "string" || !Number.isFinite(Date.parse(value.completed_at))) throw new Error("response completed_at must be ISO-8601");
  if (value.metadata !== undefined && (!value.metadata || typeof value.metadata !== "object" || Array.isArray(value.metadata))) throw new Error("response metadata must be an object");
  if (value.status === "complete") {
    if (!String(value.answer || "").trim()) throw new Error("complete response requires answer");
    if (!String(value.content_type || "").trim()) throw new Error("complete response requires content_type");
  } else if (!String(value.reason || "").trim()) {
    throw new Error(`${value.status} response requires reason`);
  }
  return value;
}

function parseObject(text, label) { let value; try { value = JSON.parse(text); } catch { throw new Error(`${label} is not valid JSON`); } if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`); return value; }
function rejectUnknown(value, allowed, label) { const set = new Set(allowed); const unknown = Object.keys(value).filter((key) => !set.has(key)); if (unknown.length) throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}`); }
function normalizeId(value) { const id = String(value || "").trim(); if (!id || id.includes("/") || id.includes("..") || !/^[A-Za-z0-9._-]+$/.test(id)) throw new Error("invalid request id"); return id; }
function makeId() { return `REQ-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0,14)}-${Math.random().toString(36).slice(2,8).toUpperCase()}`; }
function writeUrl(context, path) { const encoded = path.split("/").map(encodeURIComponent).join("/"); return `${API_ROOT}/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repo)}/contents/${encoded}`; }
function readUrl(context, path) { const url = new URL(writeUrl(context, path)); url.searchParams.set("ref", context.branch); return url.toString(); }
function headers(token) { return { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "patient-oracle-caller" }; }
function validateToken(token) { if (!token) throw new Error("GITHUB_TOKEN is required"); if (/[^\x21-\x7E]/.test(token)) throw new Error("GITHUB_TOKEN must be the actual ASCII token value"); }
async function githubError(response, action) { let detail = ""; try { const body = await response.json(); detail = body?.message ? `: ${body.message}` : ""; } catch {} const error = new Error(`GitHub ${action} failed with HTTP ${response.status}${detail}`); error.status = response.status; return error; }
function parseArgs(values) { const result = {}; for (let i=0;i<values.length;i+=1) { const token = values[i]; if (!token.startsWith("--")) throw new Error(`unexpected argument ${token}`); const key = token.slice(2); const next = values[i+1]; if (next === undefined || next.startsWith("--")) throw new Error(`missing value for --${key}`); result[key]=next; i+=1; } return result; }
function required(name) { const value = String(args[name] || "").trim(); if (!value) throw new Error(`--${name} is required`); return value; }
function numberArg(name, fallback, min, max) { if (args[name] === undefined) return fallback; const value = Number(args[name]); if (!Number.isFinite(value)) throw new Error(`--${name} must be numeric`); return Math.min(max, Math.max(min, Math.floor(value))); }
function print(value) { console.log(JSON.stringify(value, null, 2)); }
function isConflict(error) { return [409, 422].includes(Number(error?.status)); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
