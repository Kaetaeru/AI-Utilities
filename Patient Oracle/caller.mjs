#!/usr/bin/env node
const API_ROOT = "https://api.github.com";
const RUNTIME_PATH = ".patient-oracle/runtime.json";
const [command = "", ...argv] = process.argv.slice(2);
const args = parseArgs(argv);

main().catch((error) => {
  console.error(`[patient-oracle] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

async function main() {
  if (!["enqueue", "wait", "ask"].includes(command)) throw new Error("Usage: caller.mjs <enqueue|wait|ask> --owner OWNER --repo REPO [--branch BRANCH] [--prompt TEXT] [--id REQUEST_ID]");
  const context = {
    owner: required("owner"),
    repo: required("repo"),
    branch: String(args.branch || "main").trim() || "main",
    token: String(process.env.GITHUB_TOKEN || "").trim()
  };
  if (!context.token) throw new Error("GITHUB_TOKEN is required");
  if (command === "enqueue") return print(await enqueue(context));
  if (command === "wait") return print(await wait(context, required("id")));
  const queued = await enqueue(context);
  return print(await wait(context, queued.request_id));
}

async function enqueue(context) {
  const requestId = normalizeId(args.id || makeId());
  const prompt = required("prompt");
  const runtimeFile = await getFile(context, RUNTIME_PATH);
  const runtime = parseRuntime(runtimeFile.text);
  if (runtime.status !== "complete") throw new Error(`runtime status is ${runtime.status}; only complete accepts a new request`);
  const requestPath = `.patient-oracle/requests/${requestId}.json`;
  if (await getFile(context, requestPath, true)) throw new Error(`request ${requestId} already exists`);
  const request = { version: 1, request_id: requestId, prompt, created_at: new Date().toISOString() };
  await putFile(context, requestPath, request, `patient-oracle: enqueue ${requestId}`);
  const nextRuntime = {
    version: 1,
    run_id: runtime.run_id,
    revision: runtime.revision + 1,
    status: "ready",
    request_id: requestId,
    reason: "queued by Patient Oracle caller",
    updated_at: new Date().toISOString()
  };
  try {
    await putFile(context, RUNTIME_PATH, nextRuntime, `patient-oracle: dispatch ${requestId}`, runtimeFile.sha);
  } catch (error) {
    if ([409, 422].includes(Number(error?.status))) throw new Error(`${requestPath} was created but runtime changed concurrently; do not overwrite runtime blindly`);
    throw error;
  }
  return { request_id: requestId, status: "ready", runtime_revision: nextRuntime.revision };
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
        ? { request_id: requestId, status: "complete", answer: response.answer, completed_at: response.completed_at }
        : { request_id: requestId, status: response.status, reason: response.reason };
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

function parseRuntime(text) {
  const value = parseObject(text, "runtime");
  rejectUnknown(value, ["version","run_id","revision","status","request_id","reason","updated_at"], "runtime");
  if (value.version !== 1 || typeof value.run_id !== "string" || !value.run_id || !Number.isSafeInteger(value.revision) || value.revision < 0 || !["ready","complete","needs_user","blocked"].includes(value.status)) throw new Error("invalid runtime");
  if (value.status === "ready" && !String(value.request_id || "").trim()) throw new Error("ready runtime requires request_id");
  return value;
}

function parseResponse(text, requestId) {
  const value = parseObject(text, "response");
  rejectUnknown(value, ["version","request_id","status","answer","reason","completed_at","metadata"], "response");
  if (value.version !== 1 || value.request_id !== requestId || !["complete","needs_user","blocked"].includes(value.status)) throw new Error("invalid response identity or status");
  if (value.status === "complete" && !String(value.answer || "").trim()) throw new Error("complete response requires answer");
  if (value.status !== "complete" && !String(value.reason || "").trim()) throw new Error(`${value.status} response requires reason`);
  return value;
}

function parseObject(text, label) { let value; try { value = JSON.parse(text); } catch { throw new Error(`${label} is not valid JSON`); } if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`); return value; }
function rejectUnknown(value, allowed, label) { const set = new Set(allowed); const unknown = Object.keys(value).filter((key) => !set.has(key)); if (unknown.length) throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}`); }
function normalizeId(value) { const id = String(value || "").trim(); if (!id || id.includes("/") || id.includes("..") || !/^[A-Za-z0-9._-]+$/.test(id)) throw new Error("invalid request id"); return id; }
function makeId() { return `REQ-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0,14)}-${Math.random().toString(36).slice(2,8).toUpperCase()}`; }
function writeUrl(context, path) { const encoded = path.split("/").map(encodeURIComponent).join("/"); return `${API_ROOT}/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repo)}/contents/${encoded}`; }
function readUrl(context, path) { const url = new URL(writeUrl(context, path)); url.searchParams.set("ref", context.branch); return url.toString(); }
function headers(token) { return { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "patient-oracle-caller" }; }
async function githubError(response, action) { let detail = ""; try { const body = await response.json(); detail = body?.message ? `: ${body.message}` : ""; } catch {} const error = new Error(`GitHub ${action} failed with HTTP ${response.status}${detail}`); error.status = response.status; return error; }
function parseArgs(values) { const result = {}; for (let i=0;i<values.length;i+=1) { const token = values[i]; if (!token.startsWith("--")) throw new Error(`unexpected argument ${token}`); const key = token.slice(2); const next = values[i+1]; if (next === undefined || next.startsWith("--")) throw new Error(`missing value for --${key}`); result[key]=next; i+=1; } return result; }
function required(name) { const value = String(args[name] || "").trim(); if (!value) throw new Error(`--${name} is required`); return value; }
function numberArg(name, fallback, min, max) { if (args[name] === undefined) return fallback; const value = Number(args[name]); if (!Number.isFinite(value)) throw new Error(`--${name} must be numeric`); return Math.min(max, Math.max(min, Math.floor(value))); }
function print(value) { console.log(JSON.stringify(value, null, 2)); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
