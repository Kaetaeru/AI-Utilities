import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const CALLER_PATH = fileURLToPath(new URL("../../Patient Oracle/caller.mjs", import.meta.url));

export async function askPatientOracle({ owner, repo, branch = "main", prompt, responseFormat = "application/json", timeoutSeconds = 1800 }) {
  const token = String(process.env.GITHUB_TOKEN || "").trim();
  if (!token) throw new Error("GITHUB_TOKEN is required to call Patient Oracle");
  if (!owner || !repo) throw new Error("Patient Oracle owner and repo are required");
  if (!String(prompt || "").trim()) throw new Error("Patient Oracle prompt is empty");

  const args = [
    CALLER_PATH,
    "ask",
    "--owner", String(owner),
    "--repo", String(repo),
    "--branch", String(branch || "main"),
    "--prompt", String(prompt),
    "--response-format", String(responseFormat || "application/json"),
    "--timeout-seconds", String(Math.max(30, Math.floor(timeoutSeconds)))
  ];

  const { stdout, stderr } = await execFileAsync(process.execPath, args, {
    env: process.env,
    timeout: (Math.max(30, Math.floor(timeoutSeconds)) + 30) * 1000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  });
  if (stderr?.trim()) process.stderr.write(stderr);
  let result;
  try { result = JSON.parse(stdout); }
  catch { throw new Error(`Patient Oracle caller returned invalid JSON: ${stdout.slice(0, 500)}`); }
  if (result.status !== "complete") throw new Error(`Patient Oracle returned ${result.status}: ${result.reason || "no reason"}`);
  return {
    requestId: result.request_id,
    contentType: result.content_type,
    answer: result.answer,
    completedAt: result.completed_at,
    metadata: result.metadata || null
  };
}

export function patientOracleCallerPath() {
  return CALLER_PATH;
}
