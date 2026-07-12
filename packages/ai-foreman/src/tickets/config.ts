import { readFileSync, existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { parse } from "yaml";

export interface TicketsPaths {
  tickets: string;
  stateDb: string;
  trackerRules: string;
  progressDoc: string;
  archiveDoc: string;
}

export interface TicketsRendering {
  preserveLegacyLlmQueueHeading: boolean;
  includeRulesInProgressDoc: boolean;
  maxWorkLogRows: number;
  maxValidationSnapshotRows: number;
  maxRecentCompletedRows: number;
  generatedDocWarning: boolean;
}

export interface TicketsBehavior {
  regenerateProgressDocAfterEveryUpdate: boolean;
  requireValidationEvidenceForDone: boolean;
  blockOnUnresolvedDependencies: boolean;
  useAtomicFileWrites: boolean;
  backupBeforeImportOrMigration: boolean;
}

export interface TicketsConfig {
  appName: string;
  queueLimit: number;
  timezone: string;
  paths: TicketsPaths;
  rendering: TicketsRendering;
  behavior: TicketsBehavior;
}

export const DEFAULT_TICKETS_CONFIG: TicketsConfig = {
  appName: "My App",
  queueLimit: 50,
  timezone: "UTC",
  paths: {
    tickets: ".tickets/tickets.yaml",
    stateDb: ".tickets/ticket-state.sqlite",
    trackerRules: ".tickets/tracker-rules.md",
    progressDoc: "docs/ticket-progress.md",
    archiveDoc: "docs/ticket-archive.md",
  },
  rendering: {
    preserveLegacyLlmQueueHeading: true,
    includeRulesInProgressDoc: true,
    maxWorkLogRows: 50,
    maxValidationSnapshotRows: 20,
    maxRecentCompletedRows: 20,
    generatedDocWarning: true,
  },
  behavior: {
    regenerateProgressDocAfterEveryUpdate: true,
    requireValidationEvidenceForDone: true,
    blockOnUnresolvedDependencies: true,
    useAtomicFileWrites: true,
    backupBeforeImportOrMigration: true,
  },
};

export const DEFAULT_DOCS_ROOT = "docs";

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

export function validateDocsRoot(projectDir: string, docsRoot: string): string {
  const normalized = normalizeDocsRoot(docsRoot);
  const repoRoot = resolve(projectDir);
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

export function initDocsRoot(projectDir: string, override?: string): string {
  if (override) return validateDocsRoot(projectDir, override);
  const configured = readRafiDocsRoot(projectDir);
  return validateDocsRoot(projectDir, configured ?? DEFAULT_DOCS_ROOT);
}

function readRafiDocsRoot(projectDir: string): string | undefined {
  const configPath = join(projectDir, "rafi-config.yaml");
  if (!existsSync(configPath)) return undefined;
  const raw = (parse(readFileSync(configPath, "utf8")) as Record<string, unknown>) ?? {};
  const docs = raw.docs as Record<string, unknown> | undefined;
  return typeof docs?.root === "string" ? docs.root : undefined;
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => (c as string).toUpperCase());
}

function camelizeObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[snakeToCamel(k)] = v;
  }
  return result;
}

export function loadTicketsConfig(projectDir: string): TicketsConfig {
  const configPath = join(projectDir, ".tickets", "config.yaml");
  if (!existsSync(configPath)) {
    return {
      ...DEFAULT_TICKETS_CONFIG,
      paths: { ...DEFAULT_TICKETS_CONFIG.paths },
      rendering: { ...DEFAULT_TICKETS_CONFIG.rendering },
      behavior: { ...DEFAULT_TICKETS_CONFIG.behavior },
    };
  }
  const raw = (parse(readFileSync(configPath, "utf8")) as Record<string, unknown>) ?? {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${configPath}: expected a YAML object`);
  }
  assertPlainObject(raw.paths, "paths", configPath);
  assertPlainObject(raw.rendering, "rendering", configPath);
  assertPlainObject(raw.behavior, "behavior", configPath);
  const config = {
    appName: (raw.app_name as string) ?? DEFAULT_TICKETS_CONFIG.appName,
    queueLimit: (raw.queue_limit as number) ?? DEFAULT_TICKETS_CONFIG.queueLimit,
    timezone: (raw.timezone as string) ?? DEFAULT_TICKETS_CONFIG.timezone,
    paths: {
      ...DEFAULT_TICKETS_CONFIG.paths,
      ...(raw.paths ? camelizeObject(raw.paths as Record<string, unknown>) : {}),
    } as TicketsPaths,
    rendering: {
      ...DEFAULT_TICKETS_CONFIG.rendering,
      ...(raw.rendering ? camelizeObject(raw.rendering as Record<string, unknown>) : {}),
    } as TicketsRendering,
    behavior: {
      ...DEFAULT_TICKETS_CONFIG.behavior,
      ...(raw.behavior ? camelizeObject(raw.behavior as Record<string, unknown>) : {}),
    } as TicketsBehavior,
  };
  validateTicketsConfig(config, configPath);
  return config;
}

function assertPlainObject(value: unknown, name: string, configPath: string): void {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw new Error(`${configPath}: ${name} must be an object`);
  }
}

function validateTicketsConfig(config: TicketsConfig, configPath: string): void {
  if (!config.appName || typeof config.appName !== "string") {
    throw new Error(`${configPath}: app_name must be a non-empty string`);
  }
  if (!Number.isInteger(config.queueLimit) || config.queueLimit < 1) {
    throw new Error(`${configPath}: queue_limit must be a positive integer`);
  }
  if (!config.timezone || typeof config.timezone !== "string") {
    throw new Error(`${configPath}: timezone must be a non-empty IANA timezone string`);
  }

  for (const [key, value] of Object.entries(config.paths)) {
    if (!value || typeof value !== "string") {
      throw new Error(`${configPath}: paths.${camelToSnake(key)} must be a non-empty string`);
    }
    if (isAbsolute(value)) {
      throw new Error(`${configPath}: paths.${camelToSnake(key)} must be repo-relative`);
    }
  }

  for (const [key, value] of Object.entries(config.rendering)) {
    if (key.startsWith("max")) {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
        throw new Error(`${configPath}: rendering.${camelToSnake(key)} must be a positive integer`);
      }
    } else if (typeof value !== "boolean") {
      throw new Error(`${configPath}: rendering.${camelToSnake(key)} must be a boolean`);
    }
  }

  for (const [key, value] of Object.entries(config.behavior)) {
    if (typeof value !== "boolean") {
      throw new Error(`${configPath}: behavior.${camelToSnake(key)} must be a boolean`);
    }
  }
}

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export function isTicketsInitialized(projectDir: string): boolean {
  return existsSync(join(projectDir, ".tickets", "config.yaml"));
}

export function resolveTicketPaths(
  config: TicketsConfig,
  projectDir: string,
): {
  tickets: string;
  stateDb: string;
  trackerRules: string;
  progressDoc: string;
  archiveDoc: string;
} {
  const p = config.paths;
  const r = (rel: string) => join(projectDir, rel);
  return {
    tickets: r(p.tickets),
    stateDb: r(p.stateDb),
    trackerRules: r(p.trackerRules),
    progressDoc: r(p.progressDoc),
    archiveDoc: r(p.archiveDoc),
  };
}

export function pathExistsOrSymlink(path: string): boolean {
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
