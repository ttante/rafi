import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { DOCS_DIR, loadDocsIndex, render } from "special-agents";
import type { ProjectFlags } from "rafi-spec";
import { DEFAULT_DOCS_ROOT } from "./project.js";
import { capturePreimage, finalizeOwnedWrite } from "./ownership.js";

export interface CopyDocsOptions {
  force?: boolean;
  docsRoot?: string;
}

const GLOB_CHARS = /[*?[\]{}]/;

export function normalizeDocsRoot(docsRoot: string): string {
  const raw = docsRoot.trim();
  if (!raw) throw new Error("docs root must be a non-empty repo-relative directory");
  if (isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new Error(`docs root must be repo-relative: ${docsRoot}`);
  }
  if (GLOB_CHARS.test(raw)) {
    throw new Error(`docs root must be a concrete directory, not a glob: ${docsRoot}`);
  }

  const normalized = normalize(raw.replace(/\\/g, "/")).replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized || normalized === "." || normalized === "..") {
    throw new Error(`docs root must be a named repo-relative directory: ${docsRoot}`);
  }
  if (normalized.split("/").includes("..")) {
    throw new Error(`docs root must not contain parent-directory traversal: ${docsRoot}`);
  }
  return normalized.replace(/^\.\/+/, "");
}

export function validateDocsRoot(targetDir: string, docsRoot: string): string {
  const normalized = normalizeDocsRoot(docsRoot);
  const repoRoot = resolve(targetDir);
  const repoRootReal = realOrResolved(repoRoot);
  const rootPath = resolve(repoRoot, normalized);
  const rel = relative(repoRoot, rootPath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`docs root must stay inside the repository: ${docsRoot}`);
  }

  if (pathExistsOrSymlink(rootPath)) {
    let realRoot;
    try {
      realRoot = realpathSync(rootPath);
    } catch {
      throw new Error(`docs root resolves to a non-directory: ${normalized}`);
    }
    assertInsideRepo(repoRootReal, realRoot, docsRoot);
    let stat;
    try {
      stat = statSync(rootPath);
    } catch {
      throw new Error(`docs root resolves to a non-directory: ${normalized}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`docs root resolves to a non-directory: ${normalized}`);
    }
  } else {
    assertExistingAncestorInsideRepo(repoRoot, repoRootReal, rootPath, docsRoot);
  }

  return normalized;
}

export function firstAvailableDocsRoot(targetDir: string, base = "docs-rafi"): string {
  const safeBase = normalizeDocsRoot(base);
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? safeBase : `${safeBase}-${i}`;
    const rootPath = resolve(targetDir, candidate);
    if (!pathExistsOrSymlink(rootPath)) return validateDocsRoot(targetDir, candidate);
  }
  throw new Error(`could not find an available ${safeBase} docs root`);
}

export function docsRootPathExists(targetDir: string, docsRoot: string): boolean {
  return pathExistsOrSymlink(resolve(targetDir, normalizeDocsRoot(docsRoot)));
}

/**
 * Copy starter doc templates from special-agents into `<targetDir>/<docsRoot>/`,
 * respecting gate flags. Returns the list of paths actually written.
 */
export function copyDocs(
  targetDir: string,
  flags: ProjectFlags,
  opts: CopyDocsOptions = {},
): string[] {
  const entries = loadDocsIndex();
  const written: string[] = [];
  const docsRoot = validateDocsRoot(targetDir, opts.docsRoot ?? DEFAULT_DOCS_ROOT);

  for (const entry of entries) {
    const include =
      entry.gate === "always" ||
      (entry.gate === "ai" && flags.usesAI) ||
      (entry.gate === "frontend" && flags.hasFrontend);
    if (!include) continue;

    const dest = join(targetDir, docsRoot, entry.path);
    if (!opts.force && existsSync(dest)) continue;

    mkdirSync(dirname(dest), { recursive: true });
    const ownership = capturePreimage(targetDir, `${docsRoot}/${entry.path}`, `docs:${entry.path}`);
    const raw = readFileSync(join(DOCS_DIR, entry.path), "utf8");
    const rendered = render(raw, { vars: { docsRoot }, flags: {} });
    writeFileSync(dest, rendered, "utf8");
    finalizeOwnedWrite(targetDir, ownership);
    written.push(entry.path);
  }

  return written;
}

function pathExistsOrSymlink(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function assertExistingAncestorInsideRepo(repoRoot: string, repoRootReal: string, rootPath: string, docsRoot: string): void {
  let current = dirname(rootPath);
  while (current !== repoRoot && !pathExistsOrSymlink(current)) {
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
  if (!pathExistsOrSymlink(current)) return;
  try {
    const stat = statSync(current);
    if (!stat.isDirectory()) {
      throw new Error(`docs root resolves to a non-directory: ${docsRoot}`);
    }
  } catch {
    throw new Error(`docs root resolves to a non-directory: ${docsRoot}`);
  }
  if (current === repoRoot) return;
  let realAncestor;
  try {
    realAncestor = realpathSync(current);
  } catch {
    throw new Error(`docs root resolves to a non-directory: ${docsRoot}`);
  }
  assertInsideRepo(repoRootReal, realAncestor, docsRoot);
}

function assertInsideRepo(repoRootReal: string, candidateReal: string, docsRoot: string): void {
  const rel = relative(repoRootReal, candidateReal);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`docs root must stay inside the repository: ${docsRoot}`);
  }
}
