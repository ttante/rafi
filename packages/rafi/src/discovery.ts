import { Command } from "commander";
import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  EffortLevel,
  RoleInstructionRunOptions,
  RoleInstructionRunResult,
} from "ai-foreman/agent-run.js";
import type {
  CaptureResult,
  LoadedSourceRegistry,
  StructuredSourceRequest,
} from "ai-foreman/sources/source-registry.js";
import type { ProjectSourceEntry, SourceRegistryConfig } from "rafi-spec";
import { findNearestRafiProject, RAFI_CONFIG_FILE, resolveExplicitRafiProject } from "./project.js";

export const DISCOVERY_ENVELOPE_START = "RAFI_DISCOVERY_REPORT_START";
export const DISCOVERY_ENVELOPE_END = "RAFI_DISCOVERY_REPORT_END";
export const SOURCE_REQUEST_START = "RAFI_SOURCE_REQUEST_START";
export const SOURCE_REQUEST_END = "RAFI_SOURCE_REQUEST_END";
const MAX_SOURCE_ROUNDS = 3;
const VALID_EFFORT = ["low", "medium", "high", "xhigh"] as const;

export interface DiscoveryAnswers {
  online: string[];
  background: string[];
  local: string[];
  rafiHistory?: string;
}

export interface DiscoveryEnvelope {
  version: 1;
  discovered_artifacts?: unknown[];
  likely_current_state?: unknown;
  relevant_prior_plans_docs_tickets?: unknown[];
  rafi_history_confidence?: unknown;
  recommended_next_command?: string;
  source_candidates?: unknown[];
  excluded_or_avoided_resources?: unknown[];
  handoff_brief?: string;
}

export interface DiscoveryInventoryEntry {
  path: string;
  kind: "file" | "directory";
  bytes?: number;
  reason: string;
}

export interface DiscoveryResult {
  projectDir: string;
  initialized: boolean;
  answers: DiscoveryAnswers;
  inventory: DiscoveryInventoryEntry[];
  output: string;
  envelope?: DiscoveryEnvelope;
  savedSources: ProjectSourceEntry[];
  snapshots: string[];
  pendingSources: string[];
}

export interface DiscoveryOptions {
  project?: string;
  online?: string[];
  background?: string[];
  local?: string[];
  rafiHistory?: string;
  agent?: string;
  model?: string;
  effort?: string;
  fast?: boolean;
  sourceStorage?: string;
  json?: boolean;
  yes?: boolean;
  suppressNextCommand?: boolean;
  runRole?: (opts: RoleInstructionRunOptions) => Promise<RoleInstructionRunResult>;
  loadSources?: (projectDir: string) => LoadedSourceRegistry;
  registerSources?: (projectDir: string, registry: SourceRegistryConfig, requests: StructuredSourceRequest[], opts?: { capture?: boolean; storage?: SourceRegistryConfig["snapshot_storage"] }) => Promise<CaptureResult>;
  saveSources?: (projectDir: string, registry: SourceRegistryConfig) => void;
  sourceRequestFromAnswer?: (answer: string, projectDir: string) => StructuredSourceRequest;
  extractSourceRequests?: (output: string) => StructuredSourceRequest[];
  setSourceStorage?: (registry: SourceRegistryConfig, storage: SourceRegistryConfig["snapshot_storage"]) => SourceRegistryConfig;
  prompt?: DiscoveryPromptAdapter;
}

export interface DiscoverySourceCapture {
  round: number;
  entries: ProjectSourceEntry[];
  snapshots: string[];
  pending: string[];
}

export interface DiscoveryPromptAdapter {
  text(input: { message: string; placeholder?: string; initialValue?: string; defaultValue?: string }): Promise<unknown>;
  select(input: { message: string; options: Array<{ value: string; label: string }>; initialValue?: string }): Promise<unknown>;
  confirm(input: { message: string; initialValue?: boolean }): Promise<unknown>;
  isCancel(value: unknown): boolean;
}

export function buildDiscoveryCommand(): Command {
  return new Command("discover")
    .description("Run a read-only project continuation discovery report.")
    .argument("[project]", "project directory", ".")
    .option("--online <text>", "online resources to include; repeatable", collect, [] as string[])
    .option("--background <text>", "background information; repeatable", collect, [] as string[])
    .option("--local <text>", "local files, folders, globs, areas, or avoids; repeatable", collect, [] as string[])
    .option("--rafi-history <answer>", "whether Rafi was used previously")
    .option("-a, --agent <agent>", "session runtime (claude | codex)")
    .option("-m, --model <model>", "session-only model override")
    .option("--effort <level>", "session-only reasoning override (low|medium|high|xhigh)")
    .option("--fast", "enable provider fast/speed capability")
    .option("--source-storage <mode>", "storage for newly captured source versions (local | tracked)")
    .option("--json", "print machine-readable JSON")
    .option("-y, --yes", "approve source-registry persistence non-interactively")
    .action(async (project: string, opts) => {
      await runDiscovery({ ...opts, project });
    });
}

export async function runDiscovery(opts: DiscoveryOptions): Promise<DiscoveryResult> {
  assertDiscoveryEffort(opts.effort);
  const projectDir = resolveDiscoveryProject(opts.project);
  const initialized = existsSync(join(projectDir, RAFI_CONFIG_FILE));
  const interactive = !opts.yes && process.stdin.isTTY && process.stdout.isTTY;
  const answers = await collectDiscoveryAnswers(opts, interactive);
  const inventory = buildLocalInventory(projectDir, readConfiguredDocsRoot(projectDir));
  const sourceRegistryApi = await loadSourceRegistryApi(opts);
  const loadedSources = sourceRegistryApi.loadSources(projectDir);
  const selectedStorage = parseSourceStorage(opts.sourceStorage);
  let stagedSources = selectedStorage ? sourceRegistryApi.setSourceStorage(loadedSources.registry, selectedStorage) : loadedSources.registry;
  const rawRequests = initialSourceRequests(projectDir, answers, sourceRegistryApi.sourceRequestFromAnswer);
  const sourceAccess = classifySourceAccess(answers);
  const avoidRules = extractAvoidRules(answers);
  const register = sourceRegistryApi.registerSources;
  const save = sourceRegistryApi.saveSources;
  const savedSources: ProjectSourceEntry[] = [];
  const snapshots: string[] = [];
  const pendingSources: string[] = [];
  const sourceCaptures: DiscoverySourceCapture[] = [];
  const lifecycle = buildLifecycleSummary(projectDir, initialized);
  const history = buildHistorySummary(projectDir);

  if (initialized && sourceAccess !== "none" && rawRequests.length > 0) {
    const registered = await register(projectDir, stagedSources, filterSourceRequests(rawRequests, sourceAccess, avoidRules), { storage: selectedStorage });
    stagedSources = registered.registry;
    savedSources.push(...registered.entries);
    snapshots.push(...registered.snapshots);
    pendingSources.push(...registered.pending);
    sourceCaptures.push({
      round: 0,
      entries: registered.entries,
      snapshots: registered.snapshots,
      pending: registered.pending,
    });
  }

  let instruction = buildDiscoveryInstruction({
    projectDir,
    initialized,
    answers,
    inventory,
    sourceRegistry: stagedSources,
    lifecycle,
    history,
    sourceAccess,
  });
  const runRole = opts.runRole ?? await loadRoleRunner();
  let result = await runRole(buildDiscoveryRunOptions({ ...opts, projectDir, instruction }));
  let output = result.turn.result.text;
  let resumeSessionRef = result.sessionRef;

  for (let round = 0; round < MAX_SOURCE_ROUNDS; round++) {
    const requests = filterSourceRequests(sourceRegistryApi.extractSourceRequests(output), sourceAccess, avoidRules);
    if (!initialized || sourceAccess === "none" || requests.length === 0) break;
    const registered = await register(projectDir, stagedSources, requests, { storage: selectedStorage });
    stagedSources = registered.registry;
    savedSources.push(...registered.entries);
    snapshots.push(...registered.snapshots);
    pendingSources.push(...registered.pending);
    sourceCaptures.push({
      round: round + 1,
      entries: registered.entries,
      snapshots: registered.snapshots,
      pending: registered.pending,
    });
    instruction = buildDiscoverySourceContinuation({
      projectDir,
      initialized,
      answers,
      inventory,
      sourceRegistry: stagedSources,
      lifecycle,
      history,
      sourceAccess,
      sourceCaptures,
      priorOutput: output,
      round: round + 1,
      finalRound: round + 1 >= MAX_SOURCE_ROUNDS,
    });
    result = await runRole(buildDiscoveryRunOptions({ ...opts, projectDir, instruction, resumeSessionRef }));
    resumeSessionRef = result.sessionRef ?? resumeSessionRef;
    output = result.turn.result.text;
  }

  if (hasUnresolvedSourceRequest(output, sourceRegistryApi.extractSourceRequests) || !tryExtractDiscoveryEnvelope(output)) {
    output = buildDiscoveryFallbackReport({
      projectDir,
      initialized,
      answers,
      inventory,
      sourceRegistry: stagedSources,
      lifecycle,
      history,
      sourceCaptures,
      priorOutput: output,
    });
  }

  if (initialized && await shouldSaveSources(opts, interactive, savedSources.length, snapshots.length)) {
    save(projectDir, stagedSources);
  }

  const envelope = extractDiscoveryEnvelope(output);
  if (opts.json) {
    console.log(JSON.stringify({ projectDir, initialized, answers, inventory, output, envelope, savedSources, snapshots, pendingSources }, null, 2));
  } else {
    console.log(output.trimEnd());
    if (!opts.suppressNextCommand) {
      printDiscoveryNext(projectDir, initialized, envelope, inventory);
    }
  }

  return { projectDir, initialized, answers, inventory, output, envelope, savedSources, snapshots, pendingSources };
}

async function loadSourceRegistryApi(opts: DiscoveryOptions): Promise<{
  loadSources: (projectDir: string) => LoadedSourceRegistry;
  registerSources: NonNullable<DiscoveryOptions["registerSources"]>;
  saveSources: NonNullable<DiscoveryOptions["saveSources"]>;
  sourceRequestFromAnswer: NonNullable<DiscoveryOptions["sourceRequestFromAnswer"]>;
  extractSourceRequests: NonNullable<DiscoveryOptions["extractSourceRequests"]>;
  setSourceStorage: NonNullable<DiscoveryOptions["setSourceStorage"]>;
}> {
  if (
    opts.loadSources &&
    opts.registerSources &&
    opts.saveSources &&
    opts.sourceRequestFromAnswer &&
    opts.extractSourceRequests &&
    opts.setSourceStorage
  ) {
    return {
      loadSources: opts.loadSources,
      registerSources: opts.registerSources,
      saveSources: opts.saveSources,
      sourceRequestFromAnswer: opts.sourceRequestFromAnswer,
      extractSourceRequests: opts.extractSourceRequests,
      setSourceStorage: opts.setSourceStorage,
    };
  }
  const mod = await import("ai-foreman/sources/source-registry.js");
  return {
    loadSources: opts.loadSources ?? mod.loadSourceRegistry,
    registerSources: opts.registerSources ?? mod.registerSourceRequests,
    saveSources: opts.saveSources ?? mod.saveSourceRegistry,
    sourceRequestFromAnswer: opts.sourceRequestFromAnswer ?? mod.sourceRequestFromAnswer,
    extractSourceRequests: opts.extractSourceRequests ?? mod.extractSourceRequests,
    setSourceStorage: opts.setSourceStorage ?? mod.setSourceStorage,
  };
}

export function buildDiscoveryRunOptions(opts: {
  projectDir: string;
  instruction: string;
  agent?: string;
  model?: string;
  effort?: string;
  fast?: boolean;
  yes?: boolean;
  resumeSessionRef?: RoleInstructionRunOptions["resumeSessionRef"];
}): RoleInstructionRunOptions {
  return {
    projectDir: opts.projectDir,
    role: "discovery",
    agent: opts.agent,
    model: opts.model,
    effort: opts.effort as EffortLevel | undefined,
    fast: opts.fast,
    yes: opts.yes,
    label: "rafi discover",
    instruction: opts.instruction,
    permissionConfig: readOnlyPermissionConfig(),
    sandboxMode: "read-only",
    persistSessionBindings: false,
    resumeSessionRef: opts.resumeSessionRef,
  };
}

function assertDiscoveryEffort(effort: string | undefined): asserts effort is EffortLevel | undefined {
  if (effort && !(VALID_EFFORT as readonly string[]).includes(effort)) {
    throw new Error(`unknown effort "${effort}" - choose: ${VALID_EFFORT.join(" | ")}`);
  }
}

async function loadRoleRunner(): Promise<(opts: RoleInstructionRunOptions) => Promise<RoleInstructionRunResult>> {
  const mod = await import("ai-foreman/agent-run.js");
  return mod.runRoleInstruction;
}

function readOnlyPermissionConfig() {
  return {
    allowBash: [
      "pwd", "ls", "cat ", "sed -n ", "grep ", "rg ", "head ", "tail ", "wc ",
      "git status", "git diff --stat", "git diff --name-only", "git log --oneline", "git show --stat", "git ls-files", "git grep",
    ],
    escalateBash: ["git add", "git commit", "git checkout", "git restore", "git stash", "mkdir ", "touch ", "mv ", "cp ", "rm "],
    strictShellRedirection: true,
    allowTools: ["Read", "Glob", "Grep", "TodoWrite"],
    escalateTools: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
  };
}

export function buildDiscoveryInstruction(opts: {
  projectDir: string;
  initialized: boolean;
  answers: DiscoveryAnswers;
  inventory: DiscoveryInventoryEntry[];
  sourceRegistry: SourceRegistryConfig;
  lifecycle: Record<string, unknown>;
  history: Record<string, unknown>;
  sourceAccess: "none" | "local-only" | "all";
}): string {
  return `You are Rafi's read-only discovery agent. Produce a continuation report for this project.

Project directory: ${opts.projectDir}
Rafi initialized: ${opts.initialized}
Online access policy from the user and host: ${opts.sourceAccess === "all" ? "user-directed online sources may be requested" : opts.sourceAccess === "local-only" ? "do not request online refreshes; local sources and saved snapshots only" : "do not request any online refreshes; inspect only local files and already-captured snapshots"}

User answers, preserved verbatim:
${JSON.stringify(opts.answers, null, 2)}

Local inventory:
${JSON.stringify(opts.inventory, null, 2)}

Existing source registry summary:
${JSON.stringify(sourceRegistrySummary(opts.sourceRegistry), null, 2)}

Lifecycle/status summary:
${JSON.stringify(opts.lifecycle, null, 2)}

Workflow/ticket/run history summary:
${JSON.stringify(opts.history, null, 2)}

Discovery requirements:
- Report the latest known project state, including what was inspected and the evidence for each material claim.
- Identify the most recent relevant completed, current, or abandoned plan/work item you can find, and explain why it is current or stale.
- Distinguish stale artifacts from current artifacts. Do not assume the newest-looking file is authoritative without supporting evidence.
- Recommend the next plan or command to run from the discovered state.
- Include confidence and concrete gaps, especially when sources were unavailable, avoided, or stale.

Artifact discovery checklist:
- Current Rafi artifacts: rafi-config.yaml, .rafi/recovery.sqlite3, .rafi/interviews/, .rafi/source-cache/, .rafi/sources/, .rafi/state-transfer.json
- Plan artifacts: configured docs root rafi-plan.md, rafi-plan.json, rafi-plans/, legacy docs/rafi-plan.md
- Ticket artifacts: .tickets/tickets.yaml, .tickets/ticket-state.sqlite, .tickets/config.yaml, .tickets/delivery-sessions/, docs/ticket-progress.md, docs/ticket-archive.md, .tickets/history.jsonl
- Older artifacts: project.yaml, .foreman/runs/, foreman.yaml, root or docs-local tickets.yaml, older .tickets/config.yaml with queue_limit
- Non-Rafi project artifacts: roadmap, spec, design, plan, TODO, backlog, milestone docs, and obvious local issue exports

Source intake protocol:
- Preserve every user source answer verbatim. Do not split it on spaces, commas, or plus signs.
- If a supported source is needed, emit one JSON object or array between:
${SOURCE_REQUEST_START}
{ "type": "local|url|github|gitlab|linear|jira", "description": "exact pending description when resolving one", "label": "human label", "locator": { "...": "normalized non-secret locator fields" } }
${SOURCE_REQUEST_END}
- Online sources must be user-directed. If the online policy disallows refreshes, do not request url, github, gitlab, linear, or jira sources.
- For Linear and Jira, request only team/filter/site/query and environment-variable names. Never request or emit a secret.

Permissions:
- This is a non-mutating discovery run. Read, search, inspect, and ask only when needed.
- Do not edit source files, docs, .tickets, .rafi, generated artifacts, configuration, git branches, or commits.
- Host-owned source registry writes, if any, happen outside this agent after approval.

Output:
- Print a readable discovery report first.
- Then print exactly one JSON object between ${DISCOVERY_ENVELOPE_START} and ${DISCOVERY_ENVELOPE_END}.
- Envelope shape: {"version":1,"discovered_artifacts":[],"likely_current_state":{},"relevant_prior_plans_docs_tickets":[],"rafi_history_confidence":{"answer":"...","confidence":"low|medium|high","basis":"..."},"recommended_next_command":"rafi tickets plan|rafi tickets populate|rafi create|none","source_candidates":[],"excluded_or_avoided_resources":[],"handoff_brief":"..."}.
- End with exactly one final marker line:
STEP_STATUS: plan_complete | summary="discovery_complete"`;
}

export function discoveryEnvelopePlanningSources(envelope: DiscoveryEnvelope | undefined, answers: DiscoveryAnswers): string | undefined {
  const sections: string[] = [
    ...answers.online,
    ...answers.local,
  ].map((value) => value.trim()).filter(Boolean);
  if (envelope?.likely_current_state !== undefined) {
    sections.push(`Discovery likely_current_state:\n${JSON.stringify(envelope.likely_current_state, null, 2)}`);
  }
  if (envelope?.relevant_prior_plans_docs_tickets !== undefined) {
    sections.push(`Discovery relevant_prior_plans_docs_tickets:\n${JSON.stringify(envelope.relevant_prior_plans_docs_tickets, null, 2)}`);
  }
  if (envelope?.handoff_brief?.trim()) {
    sections.push(`Discovery handoff:\n${envelope.handoff_brief.trim()}`);
  }
  return sections.length ? sections.join("\n\n") : undefined;
}

export function extractDiscoveryEnvelope(output: string): DiscoveryEnvelope | undefined {
  const start = output.lastIndexOf(DISCOVERY_ENVELOPE_START);
  const end = output.lastIndexOf(DISCOVERY_ENVELOPE_END);
  if (start < 0 || end <= start) return undefined;
  const body = output.slice(start + DISCOVERY_ENVELOPE_START.length, end).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(body) as DiscoveryEnvelope;
  if (parsed.version !== 1) throw new Error("discovery envelope version must be 1");
  return parsed;
}

export function buildLocalInventory(projectDir: string, docsRoot = "docs", limit = 400): DiscoveryInventoryEntry[] {
  const root = resolve(projectDir);
  const entries = new Map<string, DiscoveryInventoryEntry>();
  const add = (rel: string, reason: string): void => {
    const abs = join(root, rel);
    if (!existsSync(abs)) return;
    const stat = statSync(abs);
    entries.set(rel, { path: rel, kind: stat.isDirectory() ? "directory" : "file", bytes: stat.isFile() ? stat.size : undefined, reason });
  };
  for (const rel of [
    "rafi-config.yaml", ".rafi/recovery.sqlite3", ".rafi/interviews", ".rafi/source-cache", ".rafi/sources", ".rafi/state-transfer.json",
    `${docsRoot}/rafi-plan.md`, `${docsRoot}/rafi-plan.json`, `${docsRoot}/rafi-plans`, "docs/rafi-plan.md",
    ".tickets/tickets.yaml", ".tickets/ticket-state.sqlite", ".tickets/config.yaml", ".tickets/delivery-sessions", "docs/ticket-progress.md", "docs/ticket-archive.md", ".tickets/history.jsonl",
    "project.yaml", ".foreman/runs", "foreman.yaml", "tickets.yaml", "docs/tickets.yaml",
  ]) add(rel, "known Rafi, Foreman, ticket, or plan artifact path");

  const visit = (dir: string, depth: number): void => {
    if (entries.size >= limit || depth > 5) return;
    for (const item of safeReadDir(dir)) {
      if (entries.size >= limit) break;
      const abs = join(dir, item.name);
      const rel = relative(root, abs);
      if (shouldSkip(rel, item.name)) continue;
      if (item.isDirectory()) {
        if (isInterestingName(item.name)) add(rel, "interesting project directory name");
        visit(abs, depth + 1);
      } else if (item.isFile() && isInterestingName(item.name)) {
        add(rel, "interesting project planning or issue filename");
      }
    }
  };
  visit(root, 0);
  return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function parseSourceStorage(value: unknown): SourceRegistryConfig["snapshot_storage"] | undefined {
  if (value === undefined) return undefined;
  if (value === "local" || value === "tracked") return value;
  throw new Error("--source-storage must be local or tracked");
}

async function collectDiscoveryAnswers(opts: DiscoveryOptions, interactive: boolean): Promise<DiscoveryAnswers> {
  const answers: DiscoveryAnswers = {
    online: opts.online ?? [],
    background: opts.background ?? [],
    local: opts.local ?? [],
    rafiHistory: opts.rafiHistory,
  };
  if (!interactive) return answers;
  const prompts = opts.prompt ?? await import("@clack/prompts");
  const online = await prompts.text({ message: "Online resources to include:", placeholder: "URLs/tickets, all Linear tickets for this repo, GitHub issues labeled billing, or do not use online sources" });
  if (prompts.isCancel(online)) process.exit(0);
  answers.online.push(String(online));
  const background = await prompts.text({ message: "Background information:", placeholder: "Anything the discovery agent should know" });
  if (prompts.isCancel(background)) process.exit(0);
  answers.background.push(String(background));
  const local = await prompts.text({ message: "Local files, folders, globs, areas to include, focus on, or avoid:", placeholder: "docs/**, .tickets, avoid docs/foo" });
  if (prompts.isCancel(local)) process.exit(0);
  answers.local.push(String(local));
  const selected = await prompts.select({ message: "Was Rafi used previously?", options: [
    { value: "yes - for the last work done", label: "yes - for the last work done" },
    { value: "yes - but not for the most recent updates", label: "yes - but not for the most recent updates" },
    { value: "no", label: "no" },
    { value: "custom", label: "custom free text" },
  ] });
  if (prompts.isCancel(selected)) process.exit(0);
  if (selected === "custom") {
    const custom = await prompts.text({ message: "Describe prior Rafi usage:" });
    if (prompts.isCancel(custom)) process.exit(0);
    answers.rafiHistory = String(custom);
  } else {
    answers.rafiHistory = String(selected);
  }
  return answers;
}

function resolveDiscoveryProject(project = "."): string {
  const explicit = resolve(project);
  if (project !== ".") return resolveExplicitRafiProject(project)?.root ?? explicit;
  return findNearestRafiProject(process.cwd())?.root ?? explicit;
}

function buildLifecycleSummary(projectDir: string, initialized: boolean): Record<string, unknown> {
  return {
    initialized,
    config: existsSync(join(projectDir, "rafi-config.yaml")),
    legacy_config: existsSync(join(projectDir, "project.yaml")),
    tickets_initialized: existsSync(join(projectDir, ".tickets", "config.yaml")),
    tickets_populated: existsSync(join(projectDir, ".tickets", "tickets.yaml")),
    state_db: existsSync(join(projectDir, ".tickets", "ticket-state.sqlite")),
  };
}

function buildHistorySummary(projectDir: string): Record<string, unknown> {
  const files = [
    ".foreman", ".foreman/runs", ".rafi/interviews", ".tickets/history.jsonl",
    ".tickets/tickets.yaml", "docs/ticket-progress.md", "docs/ticket-archive.md",
  ];
  return {
    present: files.filter((rel) => existsSync(join(projectDir, rel))),
  };
}

function readConfiguredDocsRoot(projectDir: string): string {
  for (const file of ["rafi-config.yaml", "project.yaml"]) {
    const path = join(projectDir, file);
    if (!existsSync(path)) continue;
    try {
      const raw = parseYaml(readFileSync(path, "utf8")) as { docs?: { root?: unknown } } | undefined;
      if (typeof raw?.docs?.root === "string" && raw.docs.root.trim()) return raw.docs.root;
    } catch {
      return "docs";
    }
  }
  return "docs";
}

function initialSourceRequests(
  projectDir: string,
  answers: DiscoveryAnswers,
  sourceRequest: (answer: string, projectDir: string) => StructuredSourceRequest,
): StructuredSourceRequest[] {
  return [...answers.online, ...answers.local]
    .map((answer) => sourceRequest(answer, projectDir))
    .filter((request) => request.type && request.locator);
}

function sourceRegistrySummary(registry: SourceRegistryConfig): Array<Record<string, unknown>> {
  return registry.entries.map((entry) => {
    const latest = entry.versions.at(-1);
    return {
      id: entry.id,
      type: entry.type,
      label: entry.label,
      active: entry.active,
      locator: entry.locator,
      versions: latest ? [latest] : [],
    };
  });
}

function classifySourceAccess(answers: DiscoveryAnswers): "none" | "local-only" | "all" {
  const online = answers.online.join("\n").trim();
  const all = [...answers.online, ...answers.local].join("\n");
  if (/\b(?:no sources|do not use sources|skip sources)\b/i.test(all)) return "none";
  if (!online || /\b(?:do not|don't|no|none|avoid|skip)\b[\s\S]{0,40}\bonline|online[\s\S]{0,40}\b(?:do not|don't|no|none|avoid|skip)\b/i.test(all)) return "local-only";
  return "all";
}

function filterSourceRequests(
  requests: StructuredSourceRequest[],
  access: "none" | "local-only" | "all",
  avoidRules: AvoidRules = { types: new Set(), pathFragments: [] },
): StructuredSourceRequest[] {
  if (access === "none") return [];
  return requests.filter((request) => {
    if (access === "local-only" && request.type && request.type !== "local") return false;
    if (request.type && avoidRules.types.has(request.type)) return false;
    const path = typeof request.locator?.path === "string" ? request.locator.path : undefined;
    if (path && avoidRules.pathFragments.some((fragment) => path.includes(fragment))) return false;
    const label = request.label ?? request.description ?? "";
    return !avoidRules.pathFragments.some((fragment) => label.includes(fragment));
  });
}

interface AvoidRules {
  types: Set<string>;
  pathFragments: string[];
}

function extractAvoidRules(answers: DiscoveryAnswers): AvoidRules {
  const text = [...answers.online, ...answers.local].join("\n");
  const types = new Set<string>();
  if (/\b(?:avoid|skip|do not use|don't use)\b[\s\S]{0,60}\bjira\b/i.test(text)) types.add("jira");
  if (/\b(?:avoid|skip|do not use|don't use)\b[\s\S]{0,60}\blinear\b/i.test(text)) types.add("linear");
  if (/\b(?:avoid|skip|do not use|don't use)\b[\s\S]{0,60}\bgithub\b/i.test(text)) types.add("github");
  if (/\b(?:avoid|skip|do not use|don't use)\b[\s\S]{0,60}\bgitlab\b/i.test(text)) types.add("gitlab");
  if (/\b(?:avoid|skip|do not use|don't use)\b[\s\S]{0,60}\burl\b/i.test(text)) types.add("url");
  const pathFragments = [...text.matchAll(/\b(?:avoid|skip|exclude)\s+([A-Za-z0-9._/-]+)/gi)]
    .map((match) => match[1]!)
    .filter((value) => value.includes("/") || value.startsWith("."));
  return { types, pathFragments };
}

export function buildDiscoverySourceContinuation(opts: {
  projectDir: string;
  initialized: boolean;
  answers: DiscoveryAnswers;
  inventory: DiscoveryInventoryEntry[];
  sourceRegistry: SourceRegistryConfig;
  lifecycle: Record<string, unknown>;
  history: Record<string, unknown>;
  sourceAccess: "none" | "local-only" | "all";
  sourceCaptures: DiscoverySourceCapture[];
  priorOutput: string;
  round: number;
  finalRound: boolean;
}): string {
  return `Source request round ${opts.round} completed.

Project directory: ${opts.projectDir}
Rafi initialized: ${opts.initialized}
Online access policy from the user and host: ${opts.sourceAccess === "all" ? "user-directed online sources may be requested" : opts.sourceAccess === "local-only" ? "do not request online refreshes; local sources and saved snapshots only" : "do not request any online refreshes; inspect only local files and already-captured snapshots"}

Original user answers, preserved verbatim:
${JSON.stringify(opts.answers, null, 2)}

Original local inventory:
${JSON.stringify(opts.inventory, null, 2)}

Current source registry summary:
${JSON.stringify(sourceRegistrySummary(opts.sourceRegistry), null, 2)}

Lifecycle/status summary:
${JSON.stringify(opts.lifecycle, null, 2)}

Workflow/ticket/run history summary:
${JSON.stringify(opts.history, null, 2)}

Accumulated source captures:
${JSON.stringify(opts.sourceCaptures, null, 2)}

Prior discovery agent output:
${opts.priorOutput}

Continue discovery with the full context above. ${opts.finalRound
    ? `This was the final allowed source-request round. Do not emit ${SOURCE_REQUEST_START}/${SOURCE_REQUEST_END}. Summarize any still-missing sources in excluded_or_avoided_resources and produce the final discovery report and envelope now.`
    : `If essential sources are still missing, you may request another round using ${SOURCE_REQUEST_START}/${SOURCE_REQUEST_END}. Otherwise produce the final discovery report and envelope.`}

Final output requirements:
- Report latest known project state with evidence.
- Identify the most recent relevant completed/current/abandoned plan and whether it is stale or current.
- Recommend the next plan or command.
- Include confidence and gaps.
- Print exactly one JSON object between ${DISCOVERY_ENVELOPE_START} and ${DISCOVERY_ENVELOPE_END}.
- End with exactly one final marker line:
STEP_STATUS: plan_complete | summary="discovery_complete"`;
}

function tryExtractDiscoveryEnvelope(output: string): DiscoveryEnvelope | undefined {
  try {
    return extractDiscoveryEnvelope(output);
  } catch {
    return undefined;
  }
}

function hasUnresolvedSourceRequest(
  output: string,
  extract: (output: string) => StructuredSourceRequest[],
): boolean {
  try {
    return extract(output).length > 0;
  } catch {
    return output.includes(SOURCE_REQUEST_START) && output.includes(SOURCE_REQUEST_END);
  }
}

function buildDiscoveryFallbackReport(opts: {
  projectDir: string;
  initialized: boolean;
  answers: DiscoveryAnswers;
  inventory: DiscoveryInventoryEntry[];
  sourceRegistry: SourceRegistryConfig;
  lifecycle: Record<string, unknown>;
  history: Record<string, unknown>;
  sourceCaptures: DiscoverySourceCapture[];
  priorOutput: string;
}): string {
  const unresolved = opts.priorOutput.includes(SOURCE_REQUEST_START) && opts.priorOutput.includes(SOURCE_REQUEST_END);
  const envelope: DiscoveryEnvelope = {
    version: 1,
    discovered_artifacts: opts.inventory,
    likely_current_state: {
      projectDir: opts.projectDir,
      initialized: opts.initialized,
      lifecycle: opts.lifecycle,
      history: opts.history,
      source_registry: sourceRegistrySummary(opts.sourceRegistry),
      evidence: "Host fallback generated from local inventory, lifecycle summary, history summary, and captured source registry state because the discovery agent did not return a usable final envelope.",
    },
    relevant_prior_plans_docs_tickets: opts.inventory.filter((item) => /(?:plan|ticket|progress|archive|roadmap|backlog|todo|requirements?|prd)/i.test(item.path)),
    rafi_history_confidence: {
      answer: opts.answers.rafiHistory ?? "",
      confidence: "low",
      basis: "The model did not complete the required final discovery envelope; use listed artifacts and captured sources as leads.",
    },
    recommended_next_command: opts.initialized
      ? opts.inventory.some((item) => item.path === ".tickets/tickets.yaml") ? "rafi tickets plan" : "rafi tickets populate"
      : "rafi create",
    source_candidates: opts.sourceCaptures.flatMap((capture) => capture.entries),
    excluded_or_avoided_resources: [
      ...opts.sourceCaptures.flatMap((capture) => capture.pending.map((description) => ({ round: capture.round, description, reason: "source remained pending" }))),
      ...(unresolved ? [{ reason: "discovery agent requested more sources after the final allowed round" }] : []),
    ],
    handoff_brief: "Discovery ended with a host-generated fallback envelope. Review the listed artifacts and source captures before making irreversible planning decisions.",
  };
  return `Discovery report

The discovery agent did not return a usable final envelope after the allowed source-request rounds, so Rafi produced this fallback from host-collected evidence. Treat unresolved or missing source requests as exclusions, not as completed research.

${DISCOVERY_ENVELOPE_START}
${JSON.stringify(envelope, null, 2)}
${DISCOVERY_ENVELOPE_END}
STEP_STATUS: plan_complete | summary="discovery_complete"`;
}

async function shouldSaveSources(opts: DiscoveryOptions, interactive: boolean, entryCount: number, snapshotCount: number): Promise<boolean> {
  if (entryCount === 0 && snapshotCount === 0) return false;
  if (opts.yes) return true;
  if (!interactive) return false;
  const prompts = opts.prompt ?? await import("@clack/prompts");
  const answer = await prompts.confirm({
    message: `Save ${entryCount} source registry entr${entryCount === 1 ? "y" : "ies"} and ${snapshotCount} snapshot(s) for future planning?`,
    initialValue: true,
  });
  if (prompts.isCancel(answer)) return false;
  return Boolean(answer);
}

function printDiscoveryNext(projectDir: string, initialized: boolean, envelope: DiscoveryEnvelope | undefined, inventory: DiscoveryInventoryEntry[]): void {
  const recommended = envelope?.recommended_next_command;
  if (recommended && recommended !== "none") {
    console.log(`\nrafi discover: recommended next command — ${recommended}`);
    return;
  }
  if (!initialized) {
    console.log(`\nrafi discover: next — rafi create ${shellQuote(projectDir)}`);
    return;
  }
  const hasTickets = inventory.some((item) => item.path === ".tickets/tickets.yaml");
  console.log(`\nrafi discover: next — ${hasTickets ? `rafi tickets plan --project ${shellQuote(projectDir)}` : `rafi tickets populate --project ${shellQuote(projectDir)}`}`);
}

function safeReadDir(dir: string): Dirent[] {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function shouldSkip(rel: string, name: string): boolean {
  const parts = rel.split(sep);
  if (["node_modules", ".git", "dist", "build", "coverage", ".next", ".turbo", ".cache", "vendor"].includes(name)) return true;
  return parts.some((part) => part === "node_modules" || part === ".git");
}

function isInterestingName(name: string): boolean {
  return /(?:roadmap|spec|design|plan|todo|backlog|milestone|issue|ticket|progress|archive|requirements?|prd|foreman|rafi)/i.test(name);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
