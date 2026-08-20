import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const CALLER_PATH = fileURLToPath(new URL("../../Patient Oracle/caller.mjs", import.meta.url));

export const DEFAULT_ORACLE_COORDINATES = Object.freeze({
  owner: "Kaetaeru",
  repo: "AI-Utilities",
  branch: "agent/patient-oracle-e2e"
});

export class PatientOracleTimeoutError extends Error {
  constructor(requestId, message = "Patient Oracle wait timed out locally") {
    super(`${message}. The durable request is still valid; retry with the same request ID ${requestId}.`);
    this.name = "PatientOracleTimeoutError";
    this.code = "PATIENT_ORACLE_TIMEOUT";
    this.statusCode = 504;
    this.requestId = requestId;
  }
}

export async function askPatientOracle(options) {
  const normalized = normalizeOptions(options, { requirePrompt: true });
  return runCaller("ask", normalized);
}

export async function waitPatientOracle(options) {
  const normalized = normalizeOptions(options, { requirePrompt: false });
  return runCaller("wait", normalized);
}

export function makeOracleRequestId(sessionId, kind, iteration = null) {
  const session = normalizeIdPart(sessionId, "session ID");
  const label = String(kind || "").trim().toLowerCase();
  if (label === "plan") {
    const number = Number(iteration);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error("Plan request IDs require a positive revision number");
    return `REQ-UI-CONVERGER-${session}-PLAN-${String(number).padStart(3, "0")}`;
  }
  if (label === "iteration") {
    const number = Number(iteration);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error("Iteration request IDs require a positive iteration number");
    return `REQ-UI-CONVERGER-${session}-ITER-${String(number).padStart(3, "0")}`;
  }
  throw new Error(`Unsupported Patient Oracle request kind: ${String(kind || "")}`);
}

export function buildCallerArgs(command, options) {
  if (!["ask", "wait"].includes(command)) throw new Error(`Unsupported Patient Oracle caller command: ${command}`);
  const args = [
    CALLER_PATH,
    command,
    "--owner", options.owner,
    "--repo", options.repo,
    "--branch", options.branch,
    "--id", options.requestId,
    "--timeout-seconds", String(options.timeoutSeconds)
  ];
  if (options.pollSeconds) args.push("--poll-seconds", String(options.pollSeconds));
  if (command === "ask") {
    args.push("--prompt", options.prompt);
    args.push("--response-format", options.responseFormat);
  }
  return args;
}

export function normalizeCallerResult(result, expectedRequestId) {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Patient Oracle caller returned a non-object result");
  if (String(result.request_id || "") !== expectedRequestId) throw new Error(`Patient Oracle response identity mismatch: expected ${expectedRequestId}`);
  if (!["complete", "needs_user", "blocked"].includes(result.status)) throw new Error(`Patient Oracle returned unsupported status ${String(result.status || "")}`);
  if (result.status === "complete") {
    if (!String(result.answer || "").trim()) throw new Error("Patient Oracle complete result is missing answer");
    return {
      requestId: expectedRequestId,
      status: "complete",
      contentType: String(result.content_type || "text/markdown"),
      answer: result.answer,
      completedAt: result.completed_at || null,
      metadata: result.metadata || null
    };
  }
  return {
    requestId: expectedRequestId,
    status: result.status,
    reason: String(result.reason || "Patient Oracle requires operator attention"),
    completedAt: result.completed_at || null
  };
}

export function patientOracleCallerPath() {
  return CALLER_PATH;
}

async function runCaller(command, options) {
  const token = String(process.env.GITHUB_TOKEN || "").trim();
  if (!token) throw new Error("GITHUB_TOKEN is required to call Patient Oracle");
  const args = buildCallerArgs(command, options);
  let stdout;
  let stderr;
  try {
    ({ stdout, stderr } = await execFileAsync(process.execPath, args, {
      env: process.env,
      timeout: (options.timeoutSeconds + 30) * 1000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    }));
  } catch (error) {
    if (isLocalWaitTimeout(error)) throw new PatientOracleTimeoutError(options.requestId);
    const detail = String(error?.stderr || error?.message || error || "Patient Oracle caller failed").trim();
    throw new Error(`Patient Oracle caller failed for ${options.requestId}: ${detail}`);
  }
  if (stderr?.trim()) process.stderr.write(stderr);
  let result;
  try { result = JSON.parse(stdout); }
  catch { throw new Error(`Patient Oracle caller returned invalid JSON: ${String(stdout || "").slice(0, 500)}`); }
  return normalizeCallerResult(result, options.requestId);
}

function normalizeOptions(options, { requirePrompt }) {
  const owner = String(options?.owner || DEFAULT_ORACLE_COORDINATES.owner).trim();
  const repo = String(options?.repo || DEFAULT_ORACLE_COORDINATES.repo).trim();
  const branch = String(options?.branch || DEFAULT_ORACLE_COORDINATES.branch).trim() || DEFAULT_ORACLE_COORDINATES.branch;
  const requestId = normalizeRequestId(options?.requestId);
  const timeoutSeconds = clampInteger(options?.timeoutSeconds, 5, 86400, 1800);
  const pollSeconds = clampInteger(options?.pollSeconds, 5, 300, 5);
  const prompt = String(options?.prompt || "");
  const responseFormat = String(options?.responseFormat || "application/json").trim() || "application/json";
  if (!owner || !repo) throw new Error("Patient Oracle owner and repo are required");
  if (requirePrompt && !prompt.trim()) throw new Error("Patient Oracle prompt is empty");
  return { owner, repo, branch, requestId, timeoutSeconds, pollSeconds, prompt, responseFormat };
}

function normalizeRequestId(value) {
  const id = String(value || "").trim();
  if (!id || id.includes("/") || id.includes("..") || !/^[A-Za-z0-9._-]+$/.test(id)) throw new Error("A durable Patient Oracle request ID is required");
  return id;
}

function normalizeIdPart(value, label) {
  const text = String(value || "").trim();
  if (!text || !/^[A-Za-z0-9._-]+$/.test(text)) throw new Error(`Invalid ${label}`);
  return text;
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function isLocalWaitTimeout(error) {
  const text = `${String(error?.stderr || "")} ${String(error?.message || "")}`.toLowerCase();
  return Boolean(error?.killed) || error?.signal === "SIGTERM" || text.includes("timed out waiting for") || text.includes("timeout");
}
