const PATCH_VERSION = 1;

export function parseBlueprint(input) {
  const value = typeof input === "string" ? parseJson(input, "UI Blueprint") : input;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("UI Blueprint must be a JSON object");
  if (typeof value.schema !== "string" || !value.schema.startsWith("uib/")) throw new Error("UI Blueprint schema must start with uib/");
  if (!Array.isArray(value.screens) || value.screens.length === 0) throw new Error("UI Blueprint must contain at least one screen");
  return value;
}

export function buildPlanPrompt({ blueprint, repoContext, domSnapshot = null, protectedPaths = [], userIntent = "" }) {
  return [
    "You are the planning stage of UI Converger, a deterministic UI implementation utility.",
    "Do not write code yet. Analyze the existing repository before proposing changes.",
    "The target UI is an exact UI Blueprint document. Existing project conventions win over inventing a new design system.",
    "Respect protected paths and avoid unrelated refactors, dependency changes, routing changes, or component API changes unless the target cannot be achieved otherwise.",
    "Return JSON only, with no Markdown fence.",
    "Required shape:",
    JSON.stringify({
      version: 1,
      summary: "short implementation strategy",
      target_structure: ["important target observations"],
      existing_system: ["existing design-system or architecture observations"],
      files: [{ path: "relative/path", reason: "why this file should change" }],
      constraints: ["constraints that must be preserved"],
      steps: ["ordered minimal implementation steps"],
      risks: ["specific implementation risks"]
    }, null, 2),
    `USER INTENT:\n${userIntent || "Match the blueprint while preserving existing application behavior."}`,
    `PROTECTED PATHS:\n${JSON.stringify(protectedPaths)}`,
    `TARGET UI BLUEPRINT:\n${JSON.stringify(blueprint)}`,
    `CURRENT DOM SNAPSHOT:\n${JSON.stringify(domSnapshot || { available: false })}`,
    `REPOSITORY CONTEXT:\n${JSON.stringify(repoContext)}`
  ].join("\n\n");
}

export function buildPatchPrompt({ blueprint, repoContext, domSnapshot = null, plan = null, protectedPaths = [], userIntent = "", iteration = 1 }) {
  return [
    "You are the implementation stage of UI Converger.",
    `This is iteration ${iteration}. Make the smallest coherent change that moves the rendered UI toward the target blueprint.`,
    "Use only repository files included in the supplied repository context, except that you may create a small new UI file when clearly necessary.",
    "Do not modify protected paths. Do not perform unrelated refactors. Do not add or change dependencies unless the user intent explicitly requires it.",
    "Prefer existing components, design tokens, utility classes, and CSS conventions.",
    "Return complete replacement content for every changed file. Do not return diffs or ellipses.",
    "Return JSON only, with no Markdown fence.",
    "Required shape:",
    JSON.stringify({
      version: PATCH_VERSION,
      diagnosis: ["largest current mismatches, ordered by impact"],
      summary: "what this iteration changes",
      files: [{ path: "relative/path", content: "complete file contents" }],
      expected_effect: ["observable improvements after render"]
    }, null, 2),
    `USER INTENT:\n${userIntent || "Match the blueprint while preserving existing application behavior."}`,
    `PROTECTED PATHS:\n${JSON.stringify(protectedPaths)}`,
    `APPROVED PLAN:\n${JSON.stringify(plan || { available: false })}`,
    `TARGET UI BLUEPRINT:\n${JSON.stringify(blueprint)}`,
    `CURRENT DOM SNAPSHOT:\n${JSON.stringify(domSnapshot || { available: false })}`,
    `CURRENT REPOSITORY CONTEXT:\n${JSON.stringify(repoContext)}`
  ].join("\n\n");
}

export function parsePlanAnswer(answer) {
  const value = parseModelJson(answer, "Patient Oracle plan");
  if (value.version !== 1) throw new Error("Patient Oracle plan version must be 1");
  if (typeof value.summary !== "string" || !value.summary.trim()) throw new Error("Patient Oracle plan requires summary");
  if (!Array.isArray(value.files) || !Array.isArray(value.steps)) throw new Error("Patient Oracle plan requires files and steps arrays");
  return value;
}

export function parsePatchAnswer(answer) {
  const value = parseModelJson(answer, "Patient Oracle patch");
  if (value.version !== PATCH_VERSION) throw new Error(`Patient Oracle patch version must be ${PATCH_VERSION}`);
  if (typeof value.summary !== "string" || !value.summary.trim()) throw new Error("Patient Oracle patch requires summary");
  if (!Array.isArray(value.files) || value.files.length === 0) throw new Error("Patient Oracle patch requires at least one file");
  if (value.files.length > 20) throw new Error("Patient Oracle patch may change at most 20 files per iteration");
  const seen = new Set();
  const files = value.files.map((file, index) => {
    if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error(`Patch file ${index} must be an object`);
    const path = normalizePatchPath(file.path);
    if (seen.has(path)) throw new Error(`Patch contains duplicate file path ${path}`);
    seen.add(path);
    if (typeof file.content !== "string") throw new Error(`Patch file ${path} requires complete string content`);
    return { path, content: file.content };
  });
  return {
    version: PATCH_VERSION,
    diagnosis: Array.isArray(value.diagnosis) ? value.diagnosis.map(String) : [],
    summary: value.summary,
    files,
    expected_effect: Array.isArray(value.expected_effect) ? value.expected_effect.map(String) : []
  };
}

export function normalizePatchPath(input) {
  const path = String(input || "").trim().replace(/\\/g, "/");
  if (!path || path.startsWith("/") || /^[A-Za-z]:\//.test(path)) throw new Error("Patch paths must be repository-relative");
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`Unsafe patch path: ${path}`);
  if (path === ".git" || path.startsWith(".git/") || path === ".ui-converger" || path.startsWith(".ui-converger/")) throw new Error(`Reserved patch path: ${path}`);
  return path;
}

function parseModelJson(text, label) {
  let source = String(text || "").trim();
  const fenced = source.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) source = fenced[1].trim();
  return parseJson(source, label);
}

function parseJson(text, label) {
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}
