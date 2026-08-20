import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizePatchPath } from "./protocol.mjs";
import { gitStatus } from "./repo-scan.mjs";

const execFileAsync = promisify(execFile);

export async function createSessionBranch(repoPath, sessionId) {
  const dirty = await gitStatus(repoPath);
  if (dirty.length) throw new Error(`Target repository must be clean before starting UI Converger. Dirty entries: ${dirty.slice(0, 10).join(", ")}`);
  await requireGitIdentity(repoPath);
  const current = (await runGit(["branch", "--show-current"], repoPath)).trim();
  const branch = `ui-converger/${sanitizeBranchPart(sessionId)}`;
  if (current === branch) return branch;
  const exists = await branchExists(repoPath, branch);
  if (exists) throw new Error(`Session branch already exists: ${branch}`);
  await runGit(["switch", "-c", branch], repoPath);
  return branch;
}

export async function applyPatchAndCommit(repoPath, patch, { iteration, protectedPaths = [] } = {}) {
  const dirty = await gitStatus(repoPath);
  if (dirty.length) throw new Error(`Repository changed outside UI Converger. Refusing to overwrite dirty work: ${dirty.slice(0, 10).join(", ")}`);
  const protectedSet = new Set(protectedPaths.map((item) => normalizePatchPath(item)));
  const root = await fs.realpath(repoPath);
  const changed = [];

  for (const file of patch.files) {
    const relative = normalizePatchPath(file.path);
    if (isProtected(relative, protectedSet)) throw new Error(`Patient Oracle attempted to modify protected path: ${relative}`);
    const absolute = path.resolve(root, relative);
    if (!isInside(root, absolute)) throw new Error(`Patch escaped repository root: ${relative}`);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    const previous = await readOptional(absolute);
    if (previous === file.content) continue;
    await fs.writeFile(absolute, file.content, "utf8");
    changed.push(relative);
  }

  if (!changed.length) return { changed: [], commit: null };
  try {
    await runGit(["add", "--", ...changed], root);
    const staged = await hasStagedChanges(root);
    if (!staged) return { changed: [], commit: null };
    const message = `ui-converger: iteration ${Number(iteration) || 1}`;
    await runGit(["commit", "-m", message], root);
    const commit = (await runGit(["rev-parse", "HEAD"], root)).trim();
    return { changed, commit };
  } catch (error) {
    await runGit(["reset", "HEAD", "--", ...changed], root).catch(() => {});
    throw error;
  }
}

export async function lastCommitDiff(repoPath) {
  try { return await runGit(["show", "--format=medium", "--stat", "--oneline", "HEAD"], repoPath); }
  catch { return ""; }
}

function isProtected(relative, protectedSet) {
  for (const protectedPath of protectedSet) {
    if (relative === protectedPath || relative.startsWith(`${protectedPath}/`)) return true;
  }
  return false;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function readOptional(file) {
  try { return await fs.readFile(file, "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function requireGitIdentity(repoPath) {
  const name = (await runGit(["config", "user.name"], repoPath).catch(() => "")).trim();
  const email = (await runGit(["config", "user.email"], repoPath).catch(() => "")).trim();
  if (!name || !email) throw new Error("Git user.name and user.email must be configured before UI Converger can create checkpoint commits");
}

async function branchExists(repoPath, branch) {
  try { await runGit(["show-ref", "--verify", `refs/heads/${branch}`], repoPath); return true; }
  catch { return false; }
}

async function hasStagedChanges(repoPath) {
  try { await runGit(["diff", "--cached", "--quiet"], repoPath); return false; }
  catch (error) { if (error?.exitCode === 1 || error?.code === 1) return true; throw error; }
}

async function runGit(args, cwd) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    return stdout;
  } catch (error) {
    const wrapped = new Error(`Git ${args.join(" ")} failed: ${String(error?.stderr || error?.message || error).trim()}`);
    wrapped.exitCode = error?.code;
    wrapped.code = error?.code;
    throw wrapped;
  }
}

function sanitizeBranchPart(input) {
  return String(input || "session").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "session";
}
