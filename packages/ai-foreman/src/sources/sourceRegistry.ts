import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse, stringify } from "yaml";
import type {
  PendingSourceDescription,
  ProjectSourceEntry,
  ProjectSourceLocator,
  ProjectSourceType,
  ProjectSourceVersion,
  SourceRegistryConfig,
  SourceSnapshotStorage,
  TicketSetupSource,
} from "rafi-spec";
import { fetchAndSnapshotUrl, normalizePublicHttpUrl, snapshotExternalLocalFile } from "../tickets/sourceFetch.js";
import { fetchJiraIssues, fetchLinearIssues } from "../tickets/importer.js";
import { withActivityPhase } from "../activity.js";

const execFileAsync = promisify(execFile);

export const SOURCE_REQUEST_START = "RAFI_SOURCE_REQUEST_START";
export const SOURCE_REQUEST_END = "RAFI_SOURCE_REQUEST_END";
const CONFIG_FILE = "rafi-config.yaml";
const DEFAULT_REGISTRY: SourceRegistryConfig = { version: 1, snapshot_storage: "local", entries: [] };

export interface StructuredSourceRequest {
  type?: ProjectSourceType;
  description?: string;
  label?: string;
  locator?: ProjectSourceLocator;
}

export interface LoadedSourceRegistry {
  registry: SourceRegistryConfig;
  configured: boolean;
  migrated: boolean;
  warnings: string[];
}

export interface CaptureResult {
  registry: SourceRegistryConfig;
  entries: ProjectSourceEntry[];
  snapshots: string[];
  pending: string[];
}

export function emptySourceRegistry(storage: SourceSnapshotStorage = "local"): SourceRegistryConfig {
  return { ...DEFAULT_REGISTRY, snapshot_storage: storage, entries: [] };
}

/** Read the shared registry and merge legacy source fields in memory. The next source-aware save persists migration. */
export function loadSourceRegistry(projectDir: string): LoadedSourceRegistry {
  const path = join(resolve(projectDir), CONFIG_FILE);
  if (!existsSync(path)) return { registry: emptySourceRegistry(), configured: false, migrated: false, warnings: [] };
  const raw = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const parsed = normalizeRegistry(raw.sources);
  const registry = cloneRegistry(parsed ?? DEFAULT_REGISTRY);
  const warnings: string[] = [];
  let migrated = false;
  const planning = asObject(raw.planning);
  if (Array.isArray(planning?.sources)) {
    for (const value of planning.sources) {
      if (typeof value !== "string" || !value.trim()) continue;
      migrated = true;
      migrateLegacyString(registry, value, warnings);
    }
  }
  const tickets = asObject(raw.tickets);
  if (Array.isArray(tickets?.sources)) {
    for (const source of tickets.sources) {
      migrated = true;
      migrateTicketSource(registry, source as TicketSetupSource, warnings);
    }
  }
  warnings.push(...legacyTicketReferenceWarnings(projectDir, registry));
  return { registry, configured: Boolean(parsed), migrated, warnings };
}

/** Persist the registry while preserving ticket populate/build settings and removing only superseded legacy fields. */
export function saveSourceRegistry(projectDir: string, registry: SourceRegistryConfig): void {
  const root = resolve(projectDir);
  const configPath = join(root, CONFIG_FILE);
  const raw = existsSync(configPath) ? parse(readFileSync(configPath, "utf8")) as Record<string, unknown> : {};
  raw.sources = cloneRegistry(registry);
  const planning = asObject(raw.planning);
  if (planning) {
    delete planning.sources;
    if (Object.keys(planning).length === 0) delete raw.planning;
    else raw.planning = planning;
  }
  const tickets = asObject(raw.tickets);
  if (tickets) {
    delete tickets.sources;
    raw.tickets = tickets;
  }
  mkdirSync(root, { recursive: true });
  writeFileSync(configPath, stringify(raw, { lineWidth: 100 }), "utf8");
  backfillUniqueTicketSourceIds(root, registry);
  ensurePrivateCacheIgnored(root);
}

export function addPendingSourceDescription(registry: SourceRegistryConfig, description: string, now = new Date()): SourceRegistryConfig {
  const value = description.trim();
  if (!value) return cloneRegistry(registry);
  const next = cloneRegistry(registry);
  next.pending ??= [];
  if (!next.pending.some((item) => item.description === value)) next.pending.push({ description: value, created_at: now.toISOString() });
  return next;
}

export function setSourceStorage(registry: SourceRegistryConfig, storage: SourceSnapshotStorage): SourceRegistryConfig {
  return { ...cloneRegistry(registry), snapshot_storage: storage };
}

export function deactivateSource(registry: SourceRegistryConfig, id: string): SourceRegistryConfig {
  const next = cloneRegistry(registry);
  const entry = next.entries.find((item) => item.id === id);
  if (!entry) throw new Error(`unknown source: ${id}`);
  entry.active = false;
  return next;
}

/** Remove only capture files introduced by a staged registry; existing history is never touched. */
export function discardStagedSourceCaptures(projectDir: string, original: SourceRegistryConfig, staged: SourceRegistryConfig): void {
  const root = resolve(projectDir);
  const retained = new Set(original.entries.flatMap((entry) => entry.versions.map((version) => `${entry.id}:${version.fingerprint}`)));
  const originalIds = new Set(original.entries.map((entry) => entry.id));
  for (const entry of staged.entries) {
    for (const version of entry.versions) if (!retained.has(`${entry.id}:${version.fingerprint}`)) {
      for (const path of [version.snapshot_path, version.manifest_path]) {
        const absolute = resolve(root, path); const rel = relative(root, absolute);
        if (!rel.startsWith("..") && (rel.startsWith(".rafi/source-cache/") || rel.startsWith(".rafi/sources/"))) rmSync(absolute, { force: true });
      }
    }
    if (!originalIds.has(entry.id) && entry.type === "local" && entry.locator.path?.startsWith(".tickets/imports/local-")) rmSync(resolve(root, entry.locator.path), { recursive: true, force: true });
  }
}

/** Compatibility bridge for legacy ticket setup callers. Existing entries and versions are retained. */
export function appendLegacyTicketSources(registry: SourceRegistryConfig, sources: TicketSetupSource[]): SourceRegistryConfig {
  const next = cloneRegistry(registry); const warnings: string[] = [];
  for (const source of sources) migrateTicketSource(next, source, warnings);
  return next;
}

export function extractSourceRequests(output: string): StructuredSourceRequest[] {
  const requests: StructuredSourceRequest[] = [];
  let cursor = 0;
  while (true) {
    const start = output.indexOf(SOURCE_REQUEST_START, cursor);
    if (start < 0) break;
    const end = output.indexOf(SOURCE_REQUEST_END, start + SOURCE_REQUEST_START.length);
    if (end < 0) throw new Error(`source request is missing ${SOURCE_REQUEST_END}`);
    const body = output.slice(start + SOURCE_REQUEST_START.length, end).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let value: unknown;
    try { value = JSON.parse(body); } catch (error) { throw new Error(`source request is invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) if (item && typeof item === "object" && !Array.isArray(item)) requests.push(item as StructuredSourceRequest);
    cursor = end + SOURCE_REQUEST_END.length;
  }
  // Compatibility with the original single-line protocol. Preserve the complete remainder.
  for (const match of output.matchAll(/^SOURCE_REQUEST:\s*(.+)$/gim)) requests.push({ description: match[1]!.trim() });
  return requests;
}

/** Deterministically recognize only an entire obvious locator; all other language stays pending for agent interpretation. */
export function sourceRequestFromAnswer(answer: string, projectDir: string): StructuredSourceRequest {
  const value = answer.trim();
  if (/^https?:\/\/\S+$/i.test(value)) return requestFromUrl(value);
  const candidate = resolve(projectDir, value);
  if (value && existsSync(candidate)) {
    const rel = relative(resolve(projectDir), candidate);
    const path = !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel) ? rel || "." : candidate;
    return { type: "local", label: basename(candidate), locator: { path } };
  }
  if (hasGlobMagic(value) || /^(?:\.{0,2}\/|\/)/.test(value) || /^[^\s]+[\\/][^\\/]+\.[A-Za-z0-9]{1,12}$/.test(value)) return { type: "local", label: basename(value), locator: { path: value } };
  if (/^(?:open\s+)?issues\s+for\s+(?:this|the)\s+repo(?:sitory)?$/i.test(value)) return { type: inferOriginProvider(projectDir), label: "Open repository issues", locator: { repository: inferOriginRepository(projectDir), mode: "issues", filters: { state: "open" } } };
  return { description: value };
}

export async function registerSourceRequests(
  projectDir: string,
  registry: SourceRegistryConfig,
  requests: StructuredSourceRequest[],
  opts: { capture?: boolean; storage?: SourceSnapshotStorage } = {},
): Promise<CaptureResult> {
  const next = cloneRegistry(registry);
  if (opts.storage) next.snapshot_storage = opts.storage;
  const added: ProjectSourceEntry[] = [];
  const snapshots: string[] = [];
  const pending: string[] = [];
  for (const raw of requests) {
    const request = raw.description && !raw.locator ? sourceRequestFromAnswer(raw.description, projectDir) : raw;
    if (!request.type || !request.locator) {
      if (request.description?.trim()) {
        const value = request.description.trim(); pending.push(value);
        const updated = addPendingSourceDescription(next, value);
        next.pending = updated.pending;
      }
      continue;
    }
    let locatorInput = request.locator;
    if (request.type === "local" && locatorInput.path && opts.capture !== false) {
      const absolute = resolve(projectDir, locatorInput.path); const rel = relative(resolve(projectDir), absolute);
      if (existsSync(absolute) && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) locatorInput = { ...locatorInput, path: snapshotExternalLocalFile(projectDir, absolute) };
    }
    const locator = normalizeLocator(request.type, locatorInput, projectDir);
    const key = sourceKey(request.type, locator);
    let entry = next.entries.find((item) => sourceKey(item.type, item.locator) === key);
    if (!entry) {
      entry = { id: stableSourceId(key), type: request.type, label: request.label?.trim() || defaultLabel(request.type, locator), active: true, locator, versions: [] };
      next.entries.push(entry); added.push(entry);
    } else if (!entry.active) entry.active = true;
    if (raw.description?.trim() && next.pending) next.pending = next.pending.filter((item) => item.description !== raw.description!.trim());
    if (opts.capture !== false) {
      const version = await captureEntry(projectDir, entry, next.snapshot_storage);
      if (!entry.versions.some((item) => item.fingerprint === version.fingerprint)) entry.versions.push(version);
      snapshots.push(version.snapshot_path);
    }
  }
  return { registry: next, entries: added, snapshots: [...new Set(snapshots)], pending };
}

export async function refreshSourceRegistry(projectDir: string, registry: SourceRegistryConfig, ids?: string[]): Promise<CaptureResult> {
  if (ids?.length) {
    const known = new Set(registry.entries.map((entry) => entry.id)); const missing = ids.filter((id) => !known.has(id));
    if (missing.length) throw new Error(`unknown source${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`);
  }
  const selected = registry.entries.filter((entry) => entry.active && (!ids?.length || ids.includes(entry.id)));
  const next = cloneRegistry(registry); const snapshots: string[] = [];
  for (const selectedEntry of selected) {
    const entry = next.entries.find((item) => item.id === selectedEntry.id)!;
    const version = await captureEntry(projectDir, entry, next.snapshot_storage);
    if (!entry.versions.some((item) => item.fingerprint === version.fingerprint)) entry.versions.push(version);
    snapshots.push(version.snapshot_path);
  }
  return { registry: next, entries: [], snapshots, pending: [] };
}

export function sourceContext(registry: SourceRegistryConfig, options: { metadataOnly?: Set<string>; pinned?: Map<string, Set<string>> } = {}): Array<Record<string, unknown>> {
  return registry.entries.map((entry) => {
    const pinned = options.pinned?.get(entry.id);
    const newest = entry.versions.at(-1);
    const versions = entry.versions.filter((version) => pinned?.has(version.fingerprint) || (!options.metadataOnly?.has(entry.id) && version === newest));
    return { id: entry.id, type: entry.type, label: entry.label, active: entry.active, locator: entry.locator, versions };
  });
}

export function validateSourceVersionRef(registry: SourceRegistryConfig, ref: { source_id: string; fingerprint: string }, projectDir = process.cwd()): string | undefined {
  const source = registry.entries.find((entry) => entry.id === ref.source_id);
  if (!source) return `unknown source registry entry ${ref.source_id}`;
  const version = source.versions.find((item) => item.fingerprint === ref.fingerprint);
  if (!version) return `unknown captured version ${ref.fingerprint} for ${ref.source_id}`;
  if (!existsSync(resolve(projectDir, version.snapshot_path))) return `${version.storage === "local" ? "private" : "tracked"} source snapshot is missing for ${ref.source_id}@${ref.fingerprint}; restore it instead of substituting a newer version`;
  return undefined;
}

async function captureEntry(projectDir: string, entry: ProjectSourceEntry, storage: SourceSnapshotStorage): Promise<ProjectSourceVersion> {
  if (entry.type === "local") return captureLocal(projectDir, entry, storage);
  if (entry.type === "url") return captureUrl(projectDir, entry, storage);
  if (entry.type === "github" || entry.type === "gitlab") return captureCliProvider(projectDir, entry, storage);
  return captureApiProvider(projectDir, entry, storage);
}

function captureLocal(projectDir: string, entry: ProjectSourceEntry, storage: SourceSnapshotStorage): ProjectSourceVersion {
  const locator = entry.locator.path;
  if (!locator) throw new Error(`${entry.id}: local source needs a path`);
  const absolute = isAbsolute(locator) ? locator : resolve(projectDir, locator);
  const files = hasGlobMagic(locator) ? expandLocalGlob(projectDir, locator) : existsSync(absolute) ? collectLocalFiles(absolute) : [];
  if (!files.length) throw new Error(`${entry.id}: local source did not match files: ${locator}`);
  const chunks = files.map((file) => {
    const bytes = readFileSync(file);
    return `\n===== ${isAbsolute(locator) ? basename(file) : relative(projectDir, file)} =====\n${bytes.toString("utf8")}`;
  });
  return writeCapture(projectDir, entry, storage, chunks.join("").trimStart(), "text/plain", files.length);
}

async function captureUrl(projectDir: string, entry: ProjectSourceEntry, storage: SourceSnapshotStorage): Promise<ProjectSourceVersion> {
  if (!entry.locator.url) throw new Error(`${entry.id}: URL source needs a URL`);
  const fetched = await fetchAndSnapshotUrl(projectDir, entry.locator.url);
  const version = writeCapture(projectDir, entry, storage, fetched.text, fetched.contentType, 1);
  rmSync(resolve(projectDir, fetched.snapshotPath), { force: true });
  rmSync(resolve(projectDir, fetched.metadataPath), { force: true });
  return version;
}

async function captureCliProvider(projectDir: string, entry: ProjectSourceEntry, storage: SourceSnapshotStorage): Promise<ProjectSourceVersion> {
  const repository = entry.locator.repository || inferOriginRepository(projectDir);
  const mode = entry.locator.mode ?? "issues";
  let command: string; let args: string[];
  if (entry.type === "github") {
    command = "gh";
    if (mode === "issue") args = ["issue", "view", String(entry.locator.issue), "--repo", repository, "--json", "number,title,body,state,url,labels,comments"];
    else if (mode === "project") args = ["project", "item-list", String(entry.locator.project), "--owner", repository.split("/")[0]!, "--format", "json", "--limit", "500"];
    else {
      args = ["issue", "list", "--repo", repository, "--state", entry.locator.filters?.state ?? "open", "--limit", entry.locator.filters?.limit ?? "500", "--json", "number,title,body,state,url,labels"];
      appendCliFilter(args, "--search", entry.locator.filters?.q ?? entry.locator.filters?.search);
      appendCliFilter(args, "--label", entry.locator.filters?.label ?? entry.locator.filters?.labels);
      appendCliFilter(args, "--assignee", entry.locator.filters?.assignee);
      appendCliFilter(args, "--author", entry.locator.filters?.author);
      appendCliFilter(args, "--milestone", entry.locator.filters?.milestone);
    }
  } else {
    command = "glab";
    if (mode === "issue") args = ["issue", "view", String(entry.locator.issue), "--repo", repository, "--output", "json"];
    else if (mode === "board") {
      const query = new URLSearchParams({ state: entry.locator.filters?.state ?? "opened", per_page: "100", ...(entry.locator.filters ?? {}) });
      args = ["api", "--paginate", `projects/${encodeURIComponent(repository)}/issues?${query.toString()}`];
    }
    else {
      args = ["issue", "list", "--repo", repository, "--state", entry.locator.filters?.state ?? "opened", "--per-page", entry.locator.filters?.limit ?? "500", "--output", "json"];
      appendCliFilter(args, "--search", entry.locator.filters?.search);
      appendCliFilter(args, "--label", entry.locator.filters?.label ?? entry.locator.filters?.labels);
      appendCliFilter(args, "--assignee", entry.locator.filters?.assignee);
    }
  }
  let text: string;
  try {
    const result = await withActivityPhase(`fetching ${entry.type} source`, () => execFileAsync(command, args, { cwd: projectDir, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }));
    text = result.stdout;
  }
  catch (error) { throw new Error(`${entry.type} source ${entry.label} could not be retrieved with authenticated ${command}: ${error instanceof Error ? error.message : String(error)}`); }
  return writeCapture(projectDir, entry, storage, text, "application/json", countProviderItems(text));
}

async function captureApiProvider(projectDir: string, entry: ProjectSourceEntry, storage: SourceSnapshotStorage): Promise<ProjectSourceVersion> {
  const opts = { importCap: 500, commentLimit: 10 };
  const items = entry.type === "linear"
    ? await fetchLinearIssues({ type: "linear", api_key_env: entry.locator.api_key_env ?? "LINEAR_API_KEY", team_key: entry.locator.team_key, filter: entry.locator.filter }, opts)
    : await fetchJiraIssues({ type: "jira", site: required(entry.locator.site, `${entry.id}: Jira site`), email_env: entry.locator.email_env ?? "JIRA_EMAIL", token_env: entry.locator.token_env ?? "JIRA_API_TOKEN", jql: required(entry.locator.jql, `${entry.id}: Jira JQL`) }, opts);
  return writeCapture(projectDir, entry, storage, `${JSON.stringify(items.map((item) => item.raw), null, 2)}\n`, "application/json", items.length);
}

function writeCapture(projectDir: string, entry: ProjectSourceEntry, storage: SourceSnapshotStorage, content: string, contentType: string, itemCount: number): ProjectSourceVersion {
  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  const fingerprint = createHash("sha256").update(normalized).digest("hex");
  const root = resolve(projectDir);
  const base = join(root, storage === "tracked" ? ".rafi/sources" : ".rafi/source-cache", entry.id);
  const extension = contentType.includes("json") ? "json" : "md";
  const snapshot = join(base, `${fingerprint}.${extension}`);
  const manifest = join(base, `${fingerprint}.manifest.json`);
  mkdirSync(base, { recursive: true });
  if (!existsSync(snapshot)) writeFileSync(snapshot, normalized, "utf8");
  const version: ProjectSourceVersion = {
    fingerprint, captured_at: new Date().toISOString(), storage,
    snapshot_path: relative(root, snapshot), manifest_path: relative(root, manifest),
    content_type: contentType, bytes: Buffer.byteLength(normalized), item_count: itemCount,
  };
  if (!existsSync(manifest)) writeFileSync(manifest, `${JSON.stringify({ source_id: entry.id, type: entry.type, label: entry.label, locator: entry.locator, ...version }, null, 2)}\n`, "utf8");
  return version;
}

function collectLocalFiles(path: string): string[] {
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) throw new Error(`unsupported local source: ${path}`);
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (item.isSymbolicLink() || [".git", "node_modules", ".rafi", ".tickets"].includes(item.name)) continue;
      const child = join(dir, item.name);
      if (item.isDirectory()) visit(child); else if (item.isFile()) out.push(child);
      if (out.length > 1000) throw new Error("local source directory exceeds 1000 file limit");
    }
  };
  visit(path); return out.sort();
}

function hasGlobMagic(value: string): boolean { return /[*?\[]/.test(value); }
function expandLocalGlob(projectDir: string, pattern: string): string[] {
  if (isAbsolute(pattern)) throw new Error("absolute globs are not supported; name an external file or directory explicitly");
  const normalized = pattern.split(sep).join("/").replace(/^\.\//, "");
  let body = "";
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index]!;
    if (char === "*" && normalized[index + 1] === "*") { body += ".*"; index++; }
    else if (char === "*") body += "[^/]*";
    else if (char === "?") body += "[^/]";
    else body += /[\\^$.[\]{}()+|]/.test(char) ? `\\${char}` : char;
  }
  const expression = new RegExp(`^${body}$`);
  return collectLocalFiles(projectDir).filter((file) => expression.test(relative(projectDir, file).split(sep).join("/")));
}

function requestFromUrl(value: string): StructuredSourceRequest {
  const url = new URL(normalizePublicHttpUrl(value));
  const parts = url.pathname.split("/").filter(Boolean);
  if (url.hostname.toLowerCase() === "github.com" && parts.length >= 2) {
    const issueIndex = parts.indexOf("issues"); const projectIndex = parts.indexOf("projects");
    if (issueIndex < 0 && projectIndex < 0) return { type: "url", label: url.hostname, locator: { url: url.toString() } };
    const projectOwner = ["orgs", "users"].includes(parts[0]!) && projectIndex === 2 ? parts[1] : undefined;
    const locator: ProjectSourceLocator = { repository: projectOwner ?? `${parts[0]}/${parts[1]}`, mode: "issues", filters: Object.fromEntries(url.searchParams) };
    if (issueIndex >= 0 && /^\d+$/.test(parts[issueIndex + 1] ?? "")) { locator.mode = "issue"; locator.issue = Number(parts[issueIndex + 1]); }
    else if (projectIndex >= 0) { locator.mode = "project"; locator.project = parts[projectIndex + 1]; }
    return { type: "github", label: `GitHub ${locator.repository}`, locator };
  }
  if (url.hostname.toLowerCase().includes("gitlab") && parts.length >= 2) {
    const issueIndex = parts.indexOf("issues");
    if (issueIndex < 0 && !parts.includes("boards")) return { type: "url", label: url.hostname, locator: { url: url.toString() } };
    const locator: ProjectSourceLocator = { repository: parts.slice(0, parts.indexOf("-") >= 0 ? parts.indexOf("-") : 2).join("/"), mode: "issues", filters: Object.fromEntries(url.searchParams) };
    if (issueIndex >= 0 && /^\d+$/.test(parts[issueIndex + 1] ?? "")) { locator.mode = "issue"; locator.issue = Number(parts[issueIndex + 1]); }
    if (parts.includes("boards")) locator.mode = "board";
    return { type: "gitlab", label: `GitLab ${locator.repository}`, locator };
  }
  return { type: "url", label: url.hostname, locator: { url: url.toString() } };
}

function normalizeLocator(type: ProjectSourceType, locator: ProjectSourceLocator, projectDir: string): ProjectSourceLocator {
  const value = { ...locator, filters: locator.filters ? Object.fromEntries(Object.entries(locator.filters).sort()) : undefined };
  if (type === "url" && value.url) value.url = normalizePublicHttpUrl(value.url);
  if (type === "local" && value.path) value.path = normalizeLocalPath(projectDir, value.path);
  if (value.site) value.site = value.site.replace(/\/+$/, "").toLowerCase();
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as ProjectSourceLocator;
}

function normalizeLocalPath(projectDir: string, value: string): string {
  const root = resolve(projectDir); const absolute = resolve(projectDir, value); const rel = relative(root, absolute);
  // Do not persist external absolute locators. The immutable snapshot remains usable.
  return !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel) ? rel || "." : basename(absolute);
}

function sourceKey(type: ProjectSourceType, locator: ProjectSourceLocator): string {
  return `${type}:${canonical(locator)}`;
}
function stableSourceId(key: string): string { return `src_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`; }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function defaultLabel(type: ProjectSourceType, locator: ProjectSourceLocator): string { return locator.path || locator.url || locator.repository || locator.site || locator.team_key || type; }
function countProviderItems(text: string): number { try { const value = JSON.parse(text) as unknown; return Array.isArray(value) ? value.length : 1; } catch { return 0; } }
function appendCliFilter(args: string[], flag: string, value: string | undefined): void { if (value) args.push(flag, value); }
function required(value: string | undefined, label: string): string { if (!value) throw new Error(`${label} is required`); return value; }

function inferOriginProvider(projectDir: string): "github" | "gitlab" {
  const url = originUrl(projectDir).toLowerCase(); return url.includes("gitlab") ? "gitlab" : "github";
}
function inferOriginRepository(projectDir: string): string {
  const value = originUrl(projectDir).replace(/\.git$/, "");
  const match = value.match(/(?:github|gitlab)(?:\.com|\.[^/:]+)[/:](.+)$/i) ?? value.match(/[:/]([^/:]+\/[^/]+)$/);
  if (!match?.[1]) throw new Error("could not infer repository from git origin; provide owner/repository");
  return match[1];
}
function originUrl(projectDir: string): string {
  try { return execFileSync("git", ["remote", "get-url", "origin"], { cwd: projectDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { throw new Error("could not infer source provider because this project has no readable origin remote"); }
}

function migrateLegacyString(registry: SourceRegistryConfig, value: string, warnings: string[]): void {
  const trimmed = value.trim();
  if (/^https?:\/\/\S+$/i.test(trimmed)) { const req = requestFromUrl(trimmed); addLegacyEntry(registry, req.type!, req.label!, req.locator!); return; }
  if (/^[.~\/]|[*?\[]|\.[A-Za-z0-9]{1,8}$/i.test(trimmed)) { addLegacyEntry(registry, "local", trimmed, { path: trimmed }); return; }
  registry.pending ??= []; registry.pending.push({ description: trimmed, created_at: new Date().toISOString() }); warnings.push(`legacy source needs interpretation: ${trimmed}`);
}
function migrateTicketSource(registry: SourceRegistryConfig, raw: TicketSetupSource, warnings: string[]): void {
  if (!raw || typeof raw !== "object") return;
  if (raw.type === "local") for (const path of raw.paths ?? []) addLegacyEntry(registry, "local", path, { path });
  else if (raw.type === "url") { const req = requestFromUrl(raw.url); addLegacyEntry(registry, req.type!, req.label!, req.locator!); }
  else if (raw.type === "linear") addLegacyEntry(registry, "linear", raw.team_key ? `Linear ${raw.team_key}` : "Linear", { api_key_env: raw.api_key_env ?? "LINEAR_API_KEY", team_key: raw.team_key, filter: raw.filter });
  else if (raw.type === "jira") addLegacyEntry(registry, "jira", `Jira ${raw.site}`, { site: raw.site, email_env: raw.email_env ?? "JIRA_EMAIL", token_env: raw.token_env ?? "JIRA_API_TOKEN", jql: raw.jql });
  else warnings.push("unsupported legacy ticket source was left unchanged");
}
function addLegacyEntry(registry: SourceRegistryConfig, type: ProjectSourceType, label: string, locator: ProjectSourceLocator): void {
  const key = sourceKey(type, locator);
  if (!registry.entries.some((entry) => sourceKey(entry.type, entry.locator) === key)) registry.entries.push({ id: stableSourceId(key), type, label, active: true, locator, versions: [] });
}
function normalizeRegistry(value: unknown): SourceRegistryConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Partial<SourceRegistryConfig>;
  if (raw.version !== 1 || !Array.isArray(raw.entries)) return undefined;
  return { version: 1, snapshot_storage: raw.snapshot_storage === "tracked" ? "tracked" : "local", entries: raw.entries, ...(Array.isArray(raw.pending) ? { pending: raw.pending } : {}) };
}
function cloneRegistry(registry: SourceRegistryConfig): SourceRegistryConfig { return JSON.parse(JSON.stringify(registry)) as SourceRegistryConfig; }
function asObject(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function ensurePrivateCacheIgnored(projectDir: string): void {
  const path = join(projectDir, ".gitignore"); const marker = ".rafi/source-cache/";
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (!current.split(/\r?\n/).includes(marker)) writeFileSync(path, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${marker}\n`, "utf8");
}

function legacyTicketReferenceWarnings(projectDir: string, registry: SourceRegistryConfig): string[] {
  const path = join(projectDir, ".tickets", "tickets.yaml"); if (!existsSync(path)) return [];
  const raw = parse(readFileSync(path, "utf8")) as { tickets?: Array<{ id?: string; source_refs?: Array<{ source?: string; source_id?: string }> }> };
  const warnings: string[] = [];
  for (const ticket of raw?.tickets ?? []) for (const ref of ticket.source_refs ?? []) if (!ref.source_id && ref.source) {
    const matches = matchingSourceIds(registry, ref.source);
    if (matches.length > 1) warnings.push(`ticket ${ticket.id ?? "unknown"} has ambiguous legacy source reference ${ref.source}: ${matches.join(", ")}`);
  }
  return warnings;
}

function backfillUniqueTicketSourceIds(projectDir: string, registry: SourceRegistryConfig): void {
  const path = join(projectDir, ".tickets", "tickets.yaml"); if (!existsSync(path)) return;
  const raw = parse(readFileSync(path, "utf8")) as { tickets?: Array<{ source_refs?: Array<{ source?: string; source_id?: string }> }> };
  let changed = false;
  for (const ticket of raw?.tickets ?? []) for (const ref of ticket.source_refs ?? []) if (!ref.source_id && ref.source) {
    const matches = matchingSourceIds(registry, ref.source);
    if (matches.length === 1) { ref.source_id = matches[0]; changed = true; }
  }
  if (changed) writeFileSync(path, stringify(raw, { lineWidth: 120 }), "utf8");
}

function matchingSourceIds(registry: SourceRegistryConfig, value: string): string[] {
  return registry.entries.filter((entry) => {
    const candidates = [entry.id, entry.label, entry.type, entry.locator.url, entry.locator.path, entry.locator.repository, entry.locator.site];
    return candidates.some((candidate) => candidate === value);
  }).map((entry) => entry.id);
}
