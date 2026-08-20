import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SKIP_DIRS = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", ".turbo", ".cache", ".ui-converger"]);
const TEXT_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".css", ".scss", ".sass", ".less", ".html", ".json", ".md", ".vue", ".svelte"]);
const ALWAYS_FILES = new Set(["package.json", "vite.config.js", "vite.config.ts", "next.config.js", "next.config.mjs", "next.config.ts", "tailwind.config.js", "tailwind.config.ts", "tsconfig.json"]);

export async function scanRepository(repoPathInput, { maxFiles = 90, maxChars = 650000 } = {}) {
  const requested = path.resolve(String(repoPathInput || ""));
  const gitRoot = (await runGit(["rev-parse", "--show-toplevel"], requested)).trim();
  const root = await fs.realpath(gitRoot);
  const branch = (await runGit(["branch", "--show-current"], root)).trim();
  const status = (await runGit(["status", "--porcelain=v1"], root)).trim();
  const packageInfo = await readJsonIfExists(path.join(root, "package.json"));
  const framework = detectFramework(packageInfo || {});
  const allFiles = await walk(root);
  const ranked = allFiles
    .filter((file) => isTextCandidate(file))
    .map((file) => ({ file, score: scoreFile(file) }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

  const files = [];
  let chars = 0;
  for (const { file } of ranked) {
    if (files.length >= maxFiles || chars >= maxChars) break;
    const absolute = path.join(root, file);
    let content;
    try { content = await fs.readFile(absolute, "utf8"); }
    catch { continue; }
    if (content.includes("\u0000")) continue;
    const remaining = maxChars - chars;
    if (remaining <= 0) break;
    const included = content.length > remaining ? content.slice(0, remaining) : content;
    files.push({ path: file, content: included, truncated: included.length < content.length });
    chars += included.length;
  }

  return {
    root,
    branch,
    clean: !status,
    dirty: status ? status.split("\n") : [],
    framework,
    package: packageInfo ? {
      name: packageInfo.name || null,
      scripts: packageInfo.scripts || {},
      dependencies: packageInfo.dependencies || {},
      devDependencies: packageInfo.devDependencies || {}
    } : null,
    file_count: allFiles.length,
    context_file_count: files.length,
    context_chars: chars,
    files
  };
}

export async function gitStatus(repoPath) {
  const status = (await runGit(["status", "--porcelain=v1"], repoPath)).trim();
  return status ? status.split("\n") : [];
}

async function walk(root) {
  const result = [];
  async function visit(relative) {
    const absolute = path.join(root, relative);
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const child = relative ? path.join(relative, entry.name) : entry.name;
      const normalized = child.split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await visit(child);
      } else if (entry.isFile()) {
        result.push(normalized);
      }
    }
  }
  await visit("");
  return result;
}

function isTextCandidate(file) {
  const base = path.posix.basename(file);
  return ALWAYS_FILES.has(base) || TEXT_EXTENSIONS.has(path.posix.extname(file).toLowerCase());
}

function scoreFile(file) {
  const lower = file.toLowerCase();
  let score = 0;
  if (ALWAYS_FILES.has(path.posix.basename(file))) score += 100;
  if (/^(src|app|pages|components|styles|ui)\//.test(lower)) score += 70;
  if (/(layout|page|route|app|index|main|dashboard|screen|view|component)/.test(lower)) score += 30;
  if (/\.(css|scss|tsx|jsx|vue|svelte)$/.test(lower)) score += 20;
  if (/\.(test|spec|stories)\./.test(lower) || lower.includes("/__tests__/")) score -= 35;
  if (lower.includes("lock")) score -= 100;
  return score;
}

function detectFramework(pkg) {
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  if (deps.next) return "next";
  if (deps["@remix-run/react"]) return "remix";
  if (deps["@sveltejs/kit"]) return "sveltekit";
  if (deps.vue) return deps.nuxt ? "nuxt" : "vue";
  if (deps.react) return deps.vite ? "react-vite" : "react";
  return "unknown";
}

async function readJsonIfExists(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runGit(args, cwd) {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    return stdout;
  } catch (error) {
    throw new Error(`Git ${args.join(" ")} failed in ${cwd}: ${String(error?.stderr || error?.message || error).trim()}`);
  }
}
