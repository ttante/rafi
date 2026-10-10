import ignore from "ignore";
import { readWorkspaceIdentity } from "../sessionIdentity.js";
import { WorkflowReader } from "../workflowReader.js";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { extname, join } from "node:path";
import type { GraphInputV1, GraphSourceBindingV1 } from "rafi-spec";
import { loadSourceRegistry } from "../sources/sourceRegistry.js";
import type { EffectiveGraphConfig } from "./config.js";
import { bytesDigest, confined, digest, readBounded } from "./util.js";
export interface CapturedGraphCorpus {
  inputs: GraphInputV1[];
  bytes: Map<string, Buffer>;
  corpusDigest: string;
  binding: GraphSourceBindingV1;
  exclusionsDigest: string;
}
const forbidden = new Set([".git", ".rafi", ".foreman", ".tickets", "graphify-out", "node_modules", "dist", "build", "coverage", ".agents", ".codex", ".claude", "__pycache__", ".venv", "venv"]);
const code = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".cs", ".rb", ".swift", ".kt", ".vue", ".svelte", ".json", ".sql"]);
const semantic = new Set([".md", ".mdx", ".txt", ".rst", ".yaml", ".yml", ".toml", ".xml"]);
export function globMatch(path: string, pattern: string): boolean {
  pattern = pattern.replace(/^\//, "");
  const directory = pattern.endsWith("/");
  if (directory)
    pattern = pattern.slice(0, -1);
  let regex = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      i++;
      if (pattern[i + 1] === "/") {
        i++;
        regex += "(?:.*/)?";
      }
      else
        regex += ".*";
    }
    else if (c === "*")
      regex += "[^/]*";
    else if (c === "?")
      regex += "[^/]";
    else
      regex += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern.includes("/") ? "" : "(?:.*/)?"}${regex}${directory ? "(?:/.*)?" : ""}$`).test(path);
}
export function graphExclusions(workspace: string, inputPaths: string[] = []): {
  text: string;
  patterns: string[];
} {
  const path = join(workspace, ".graphifyignore");
  const text = existsSync(path) ? readBounded(path, 128 * 1024).toString("utf8") : "";
  const ignorePaths = new Set([".gitignore"]);
  for (const input of inputPaths) {
    const parts = input.split("/");
    parts.pop();
    for (let i = 1; i <= parts.length; i++)
      ignorePaths.add(`${parts.slice(0, i).join("/")}/.gitignore`);
  }
  const gitIgnores = [...ignorePaths].sort().filter(p => existsSync(join(workspace, p))).map(p => ({ path: p, text: readBounded(confined(workspace, p), 128 * 1024).toString("utf8") }));
  return { text: JSON.stringify({ graphify: text, gitIgnores }), patterns: text.split(/\r?\n/) };
}
export function graphPathAllowed(path: string, config: EffectiveGraphConfig, patterns: string[]): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some(p => p === ".." || forbidden.has(p)))
    return false;
  const base = path.split("/").at(-1)!;
  if (/^(\.env(?:\.|$)|credentials(?:\.|$)|id_(rsa|ed25519)|\.npmrc$)|\.(pem|key|p12|pfx)$/i.test(base))
    return false;
  if (!config.config?.include.some(p => globMatch(path, p)))
    return false;
  // Preserve escaping, anchored patterns, character classes and excluded-parent
  // semantics. Trimming lines before parsing changes Git's meaning.
  return !ignore({ ignorecase: false }).add(patterns).ignores(path)
    && !config.config.exclude.some(p => globMatch(path, p));
}
export function captureGraphCorpus(workspace: string, configRoot: string, config: EffectiveGraphConfig, sourceRef = "unknown"): CapturedGraphCorpus {
  if (!config.enabled)
    throw new Error(`Graph is ${config.reason}`);
  const root = realpathSync(workspace), started = Date.now();
  let exclusions = graphExclusions(root);
  const check = (): void => {
    if (Date.now() - started > config.limits.inventoryMs)
      throw new Error("Graph inventory deadline exceeded");
  };
  let paths: string[];
  let gitRepository = true;
  try {
    paths = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, timeout: config.limits.inventoryMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }).split("\0").filter(Boolean);
  }
  catch (error) {
    if (!String((error as {
      stderr?: unknown;
    }).stderr ?? error).includes("not a git repository"))
      throw error;
    gitRepository = false;
    paths = [];
    const walk = (prefix: string, rules: Array<{ prefix: string; matcher: ReturnType<typeof ignore> }> = []): void => {
      const ignorePath = join(root, prefix, ".gitignore");
      if (existsSync(ignorePath)) rules = [...rules, { prefix, matcher: ignore({ ignorecase: false }).add(readBounded(confined(root, prefix ? `${prefix}/.gitignore` : ".gitignore"), 128 * 1024).toString("utf8")) }];
      check(); for (const e of readdirSync(join(root, prefix), { withFileTypes: true })) {
        const p = prefix ? `${prefix}/${e.name}` : e.name;
        if (forbidden.has(e.name) || e.isSymbolicLink())
          continue;
        let excluded = false;
        for (const rule of rules) {
          const result = rule.matcher.test((rule.prefix ? p.slice(rule.prefix.length + 1) : p) + (e.isDirectory() ? "/" : ""));
          if (result.ignored) excluded = true;
          else if (result.unignored) excluded = false;
        }
        if (excluded) continue;
        if (e.isDirectory())
          walk(p, rules);
        else if (e.isFile())
          paths.push(p);
        if (paths.length > config.limits.maxFiles * 4)
          throw new Error("Graph scope-decision-required: inventory too large");
      }
    };
    walk("");
  }
  exclusions = graphExclusions(root, paths.filter(p => graphPathAllowed(p, config, exclusions.patterns)));
  if (gitRepository) {
  const ignored = spawnSync("git", ["check-ignore", "--no-index", "-z", "--stdin"], { cwd: root, input: paths.join("\0") + (paths.length ? "\0" : ""), encoding: "utf8", timeout: Math.max(1, config.limits.inventoryMs - (Date.now() - started)), maxBuffer: 16 * 1024 * 1024 });
  if (ignored.error)
    throw ignored.error;
  if (ignored.status === 0) {
    const excluded = new Set(ignored.stdout.split("\0"));
    paths = paths.filter(p => !excluded.has(p));
  }
  else if (ignored.status !== 1 && !String(ignored.stderr).includes("not a git repository"))
    throw new Error(`Git exclusion check failed: ${ignored.stderr}`);
  }
  const inputs: GraphInputV1[] = [], bytes = new Map<string, Buffer>();
  let total = 0, words = 0;
  const add = (path: string, content: Buffer, mode: number, kind: GraphInputV1["kind"], extra: Partial<GraphInputV1> = {}): void => {
    total += content.length;
    // Incrementally count without allocating an array proportional to the input.
    for (const _ of content.toString("utf8").matchAll(/\S+/gu)) {
      if (++words > config.limits.maxWords)
        throw new Error("Graph scope-decision-required: adopted word limit exceeded");
    }
    if (inputs.length >= config.limits.maxFiles || total > config.limits.maxInputBytes)
      throw new Error("Graph scope-decision-required: adopted inventory limits exceeded");
    inputs.push({ path, digest: bytesDigest(content), bytes: content.length, mode, kind, ...extra });
    bytes.set(path, content);
  };
  for (const path of [...new Set(paths)].sort()) {
    check();
    if (!graphPathAllowed(path, config, exclusions.patterns))
      continue;
    const extension = extname(path).toLowerCase();
    if (!code.has(extension) && !semantic.has(extension))
      continue;
    const full = join(root, path);
    if (!existsSync(full))
      continue; // tracked deletion
    if (lstatSync(full).isSymbolicLink())
      throw new Error(`Graph symlink input is unsupported: ${path}`);
    const safe = confined(root, path), stat = lstatSync(safe);
    if (!stat.isFile())
      continue;
    const content = readBounded(safe, Math.min(config.limits.maxInputBytes, 8 * 1024 * 1024));
    if (content.includes(0))
      continue;
    add(path, content, stat.mode & 0o777, code.has(extension) ? "code" : "semantic");
  }
  const registry = loadSourceRegistry(configRoot).registry;
  for (const id of config.config!.sourceIds) {
    check();
    const entry = registry.entries.find(e => e.id === id);
    if (!entry || !entry.active)
      throw new Error(`Registered graph source is absent or revoked: ${id}`);
    const pin = config.config!.sourceVersions?.[id];
    const version = pin ? entry.versions.find(v => v.fingerprint === pin) : undefined;
    if (!version)
      throw new Error(`Registered graph source has no captured version: ${id}`);
    const content = readBounded(confined(configRoot, version.snapshot_path), 8 * 1024 * 1024);
    if (bytesDigest(content) !== version.fingerprint)
      throw new Error(`Registered graph source capture checksum mismatch: ${id}@${version.fingerprint}`);
    const key = `registered-sources/${digest("source-key", id)}.md`;
    add(key, content, 0o444, "semantic", { sourceId: id, sourceVersion: version.fingerprint, provenance: { classification: "registered-reference", authority: "reference-only; approval not inferred", label: entry.label, sourceType: entry.type, capturedAt: version.captured_at } });
  }
  inputs.sort((a, b) => a.path<b.path?-1:a.path>b.path?1:0);
  const exclusionsDigest = digest("exclusions", graphExclusions(root, inputs.filter(i => !i.sourceId).map(i => i.path)).text);
  const corpusDigest = digest("corpus", { inputs, policy: config.policyDigest, exclusionsDigest, package: "0.9.82", bridge: 1 });
  const stat = lstatSync(root);
  const identityReader=new WorkflowReader(configRoot);let hostProjectRef:string|undefined;try{hostProjectRef=identityReader.graphHostProjectIdentity();}finally{identityReader.close();}
  const binding: GraphSourceBindingV1 = { version: 1, projectRef: config.projectRef, hostProjectRef,hostWorkspaceRef:readWorkspaceIdentity(root),workspaceRef: digest("workspace", { root, dev: stat.dev, ino: stat.ino, birthtime: stat.birthtimeMs }), sourceRef, corpusDigest, policyDigest: config.policyDigest };
  return { inputs, bytes, corpusDigest, binding, exclusionsDigest };
}
