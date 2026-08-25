import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { StructuredPlanV1 } from "rafi-spec";
import { select, text, confirm, isCancel } from "@clack/prompts";
import { loadConfig } from "../config.js";
import { Log } from "../log.js";
import { Foreman } from "../foreman.js";
import type { EffortLevel } from "../adapters/types.js";
import { printEvents } from "./events.js";
import {
  cmdInit,
  cmdUpdate,
  cmdComplete,
  cmdBlock,
  cmdUnblock,
  cmdCancel,
  cmdDiscover,
  cmdAcceptFutureWork,
  cmdReorder,
  cmdRender,
  cmdValidate,
  cmdQueue,
  cmdStackQueue,
  cmdArchive,
  cmdReview,
} from "../tickets/commands.js";
import { loadDeliveryConfig } from "../tickets/delivery.js";
import { DEFAULT_TICKETS_CONFIG, isTicketsInitialized, loadTicketsConfig } from "../tickets/config.js";
import { validateDocsRoot } from "../tickets/config.js";
import { importExternalSources, importFromMarkdown, validateExternalSourceAccess } from "../tickets/importer.js";
import { formatValidationIssues } from "../tickets/validate.js";
import {
  assertEffortLevel,
  createRoleBuilder,
  makeLogPath,
  readOnlyPermissionConfig,
  type RoleBuilderOptions,
} from "../agentRun.js";
import type { TicketsConfig } from "../tickets/config.js";
import {
  DEFAULT_TICKET_SETUP,
  configuredPlanningSources,
  defaultAppName,
  detectPackageName,
  ensureRafiConfigForTicketSetup,
  externalSources,
  hasTicketSetupConfig,
  loadTicketSetupConfig,
  loadTicketSetupConfigWithDefaults,
  localSourcePaths,
  mergeTicketSetup,
  recommendedBuildDefaults,
  saveTicketSetupConfig,
  urlSources,
  type HarnessTarget,
  type TicketBuildCompletionMode,
  type TicketSourceConfig,
  type TicketsSetupConfig,
} from "../tickets/setupConfig.js";
import { fetchAndSnapshotUrl, snapshotExternalLocalFile } from "../tickets/sourceFetch.js";
import {
  checkpointInterview,
  completeInterview,
  createInterviewRecord,
  failInterview,
  type InterviewRecord,
} from "../interviews.js";
import { applyTicketPopulation, authorizeTicketRetirements, extractTicketPopulationProposal, materializeTicketPopulation, TICKET_POPULATION_PROPOSAL_END, TICKET_POPULATION_PROPOSAL_START } from "../ticketPopulation.js";
import { loadTickets } from "../tickets/ticketLoader.js";
import { resolveTicketPaths } from "../tickets/config.js";

function fail(msg: string): never {
  console.error(`foreman tickets: ${msg}`);
  process.exit(1);
}

function cwd(opts: { project?: string }): string {
  return resolve(opts.project ?? ".");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function optionWasProvided(command: Command, name: string): boolean {
  const source = command.getOptionValueSource(name);
  return source !== undefined && source !== "default";
}

const TICKET_POPULATE_ROLE = "ticket-maker";
const RAFI_CONFIG_FILES = ["rafi-config.yaml", "project.yaml"] as const;

function validateEffort(effort: string | undefined): asserts effort is EffortLevel | undefined {
  try {
    assertEffortLevel(effort);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

export function buildPopulateInstruction(sourceHints?: string[], progressDoc = "docs/ticket-progress.md"): string {
  const sources = sourceHints ?? [];
  const sourceHintBlock = sources.length > 0
    ? `
User-provided planning source hints:
${sources.map((source) => `- ${source}`).join("\n")}

Treat these as files, folders, or globs to check first. Any reasonable project-planning format is acceptable because you are responsible for interpreting it. If a hinted source does not exist or is ambiguous, continue scanning the repository before asking for help.
`
    : `
No specific planning sources were provided. Scan the repository for relevant planning and ticketing documents.
`;

  return `You are being run by Foreman to populate this repository's Foreman ticket tracker.

Goal:
- Convert every existing project ticket, task, backlog item, roadmap item, or implementation step into Foreman's structured ticket system.
- Do not implement product/code changes. Only update ticket-tracker files.
${sourceHintBlock}

Before proposing, read these tracker control files:
- .tickets/config.yaml
- .tickets/tickets.yaml
- .tickets/tracker-rules.md
- ${progressDoc} if it exists

Then inspect the repository for existing planning sources, beginning with the approved structured Rafi plan. You are proposal-only: do not edit any file, run tracker mutation commands, allocate final ticket IDs, or write delivery configuration. Rafi validates and performs all writes after approval.

Return ticket content using Foreman's schema:
- slice_ref: the exact approved plan slice reference. Do not allocate ticket IDs.
- order: unique numeric implementation order. Use gaps like 1000, 2000, 3000.
- title, area, priority, size, risk, depends_on, summary, acceptance, required_tests, likely_files, rollback, notes.
- Keep dependencies, acceptance criteria, testing expectations, file hints, risk notes, and implementation notes from the source material.
- Do not store mutable status/progress fields in .tickets/tickets.yaml.
- Dependencies must reference slice_ref values. Include the exact IDs of existing populated tickets whose removed slices should become obsolete.

If source content does not cleanly map to the new schema, ask for guidance instead of guessing. Use:
STEP_STATUS: needs_input | question="..." choices="..."

Output one JSON object between ${TICKET_POPULATION_PROPOSAL_START} and ${TICKET_POPULATION_PROPOSAL_END} with shape:
{"version":1,"plan_id":"approved plan ID","revision":1,"tickets":[{"slice_ref":"slc_...","title":"...","area":"...","priority":"P1","size":"S","risk":"Low","summary":"...","acceptance":["..."],"required_tests":["..."],"likely_files":["..."],"depends_on":["slice_ref"],"rollback":null,"notes":null}],"retirements":["exact existing ticket ID"]}
Triple-check that every approved slice appears exactly once.

End with exactly one marker line as the final non-empty line:
STEP_STATUS: done | summary="populated Foreman tickets from existing project ticket sources"
or
STEP_STATUS: blocked | reason="why ticket population cannot proceed"`;
}

export function resolvePopulateSources(
  projectDir: string,
  explicitSources: string[] | undefined,
  ticketsConfig: TicketsConfig,
): string[] | undefined {
  if (explicitSources && explicitSources.length > 0) return explicitSources;
  const setup = loadTicketSetupConfig(projectDir);
  const savedLocalSources = localSourcePaths(setup);
  if (savedLocalSources.length > 0) return savedLocalSources;
  const rafiPlan = resolveConfiguredRafiPlanSource(projectDir, "rafi-config.yaml");
  if (rafiPlan) return [rafiPlan];
  const legacyPlan = resolveConfiguredRafiPlanSource(projectDir, "project.yaml");
  if (legacyPlan) return [legacyPlan];
  const candidates = unique([
    join(dirname(ticketsConfig.paths.progressDoc), "rafi-plan.md"),
    "docs/rafi-plan.md",
  ]);
  const plan = candidates.find((candidate) => existsSync(join(projectDir, candidate)));
  return plan ? [plan] : undefined;
}

function resolveConfiguredRafiPlanSource(
  projectDir: string,
  file: typeof RAFI_CONFIG_FILES[number],
): string | undefined {
  const configPath = join(projectDir, file);
  if (!existsSync(configPath)) return undefined;
  const raw = parseYaml(readFileSync(configPath, "utf8")) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${file}: expected a YAML object`);
  }
  const docs = raw.docs as Record<string, unknown> | undefined;
  if (typeof docs?.root !== "string") return undefined;
  const candidate = `${validateDocsRoot(projectDir, docs.root)}/rafi-plan.md`;
  return existsSync(join(projectDir, candidate)) ? candidate : undefined;
}

export function buildPopulateAgentRunOptions(opts: {
  projectDir: string;
  agent?: string;
  model?: string;
  effort?: EffortLevel;
  fast?: boolean;
  yes?: boolean;
  log: Log;
}): RoleBuilderOptions {
  return {
    projectDir: opts.projectDir,
    role: TICKET_POPULATE_ROLE,
    agent: opts.agent,
    model: opts.model,
    effort: opts.effort,
    fast: opts.fast,
    yes: opts.yes,
    label: "tickets populate",
    log: opts.log,
    permissionConfig: readOnlyPermissionConfig(),
    sandboxMode: "read-only",
  };
}

interface SetupCommandOptions {
  project?: string;
  defaults?: boolean;
  yes?: boolean;
  appName?: string;
  docsRoot?: string;
  runtime?: string;
  localSource?: string[];
  linear?: boolean;
  linearTeamKey?: string;
  linearFilter?: string;
  jiraSite?: string;
  jiraJql?: string;
  urlSource?: string[];
  branchStrategy?: string;
  completion?: string;
  provider?: string;
  autoMergeWait?: boolean;
  autoMergeTimeoutMinutes?: string;
  agentPreference?: string;
  skipAccessCheck?: boolean;
}

interface PopulateCommandOptions {
  project?: string;
  agent?: string;
  model?: string;
  effort?: string;
  sources?: string[];
  fast?: boolean;
  yes?: boolean;
  authorizeRetire?: string[];
}

async function cmdSetupInitCli(opts: SetupCommandOptions): Promise<void> {
  const dir = cwd(opts);
  if (!existsSync(dir)) fail(`project directory not found: ${dir}`);
  let interview = beginTicketSetupInterview(dir, "tickets-setup-init", opts);
  if (hasTicketSetupConfig(dir)) {
    console.log("foreman tickets setup: existing setup found; opening setup:update");
    await cmdSetupUpdateCli(opts);
    if (interview) completeInterview(dir, interview);
    return;
  }
  try {
    const answers = await collectTicketSetup(dir, opts, undefined);
    if (interview) interview = checkpointInterview(dir, interview, { checkpoint: "save-setup", answers: { setup: answers } });
    await validateConfiguredSourcesIfRequested(dir, answers, Boolean(opts.skipAccessCheck));
    ensureRafiConfigForTicketSetup(dir, {
      appName: opts.appName ?? defaultAppName(dir),
      docsRoot: opts.docsRoot,
      targets: parseRuntimeTargets(opts.runtime),
    });
    saveTicketSetupConfig(dir, answers, {
      appName: opts.appName ?? defaultAppName(dir),
      docsRoot: opts.docsRoot,
      targets: parseRuntimeTargets(opts.runtime),
    });
    console.log(`foreman tickets setup: saved ticket setup in ${join(dir, "rafi-config.yaml")}`);

    if (!isTicketsInitialized(dir)) {
      if (interview) interview = checkpointInterview(dir, interview, { checkpoint: "initialize-tracker" });
      cmdInit(dir, {
        appName: opts.appName ?? defaultAppName(dir),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        docsRoot: opts.docsRoot,
      });
      console.log("foreman tickets setup: initialized .tickets/");
    }

    if (shouldPrompt(opts)) {
      if (interview) interview = checkpointInterview(dir, interview, { checkpoint: "populate-confirmation" });
      const populate = await confirm({
        message: "Run ticket population now?",
        initialValue: answers.sources.length > 0,
      });
      if (isCancel(populate)) return;
      if (populate) {
        await cmdPopulateCli({ project: dir, yes: true });
      }
    } else {
      console.log(`foreman tickets setup: next — run \`foreman tickets populate --project ${shellQuote(dir)}\``);
    }
    if (interview) completeInterview(dir, interview);
  } catch (error) {
    if (interview) failInterview(dir, interview, interview.checkpoint, error);
    throw error;
  }
}

async function cmdSetupUpdateCli(opts: SetupCommandOptions): Promise<void> {
  const dir = cwd(opts);
  if (!existsSync(dir)) fail(`project directory not found: ${dir}`);
  let interview = beginTicketSetupInterview(dir, "tickets-setup-update", opts);
  try {
    const current = loadTicketSetupConfigWithDefaults(dir);
    const patch = await collectTicketSetupPatch(dir, opts, current);
    const next = mergeTicketSetup(current, patch);
    if (interview) interview = checkpointInterview(dir, interview, { checkpoint: "save-setup", answers: { setup: next } });
    await validateConfiguredSourcesIfRequested(dir, next, Boolean(opts.skipAccessCheck));
    ensureRafiConfigForTicketSetup(dir, {
      appName: opts.appName ?? defaultAppName(dir),
      docsRoot: opts.docsRoot,
      targets: parseRuntimeTargets(opts.runtime),
    });
    saveTicketSetupConfig(dir, next, {
      appName: opts.appName ?? defaultAppName(dir),
      docsRoot: opts.docsRoot,
      targets: parseRuntimeTargets(opts.runtime),
    });
    console.log(`foreman tickets setup: updated ticket setup in ${join(dir, "rafi-config.yaml")}`);

    if (isTicketsInitialized(dir)) {
      const rows = cmdQueue(dir, 1);
      if (rows.length === 0) {
        console.log(`foreman tickets setup: queue is empty; run \`foreman tickets populate --project ${shellQuote(dir)}\` to import or refresh tickets.`);
      }
    }
    if (interview) completeInterview(dir, interview);
  } catch (error) {
    if (interview) failInterview(dir, interview, interview.checkpoint, error);
    throw error;
  }
}

function beginTicketSetupInterview(
  projectDir: string,
  workflow: "tickets-setup-init" | "tickets-setup-update",
  opts: SetupCommandOptions,
): InterviewRecord | undefined {
  if (!shouldPrompt(opts)) return undefined;
  const record = createInterviewRecord({
    workflow,
    invocation: { projectDir, ...opts },
    checkpoint: "setup-section",
    outputs: ["rafi-config.yaml", ".tickets/config.yaml"],
  });
  return checkpointInterview(projectDir, record, { checkpoint: "setup-section" });
}

async function collectTicketSetup(
  dir: string,
  opts: SetupCommandOptions,
  current: TicketsSetupConfig | undefined,
): Promise<TicketsSetupConfig> {
  const patch = await collectTicketSetupPatch(dir, opts, current ?? DEFAULT_TICKET_SETUP);
  const build = patch.build ?? {};
  return mergeTicketSetup(current, {
    ...patch,
    build: Object.keys(build).length > 0 ? build : recommendedBuildDefaults(dir),
  });
}

async function collectTicketSetupPatch(
  dir: string,
  opts: SetupCommandOptions,
  current: TicketsSetupConfig,
): Promise<Partial<{ sources: TicketSourceConfig[]; populate: Partial<TicketsSetupConfig["populate"]>; build: Partial<TicketsSetupConfig["build"]> }>> {
  const nonInteractiveSources = sourcesFromSetupOptions(opts);
  const populatePatch: Partial<TicketsSetupConfig["populate"]> = {};
  const buildPatch: Partial<TicketsSetupConfig["build"]> = {};

  if (opts.agentPreference) populatePatch.agent_preference = parseAgentPreference(opts.agentPreference);
  if (opts.branchStrategy) buildPatch.branch_strategy = parseBranchStrategy(opts.branchStrategy);
  if (opts.completion) buildPatch.completion = parseCompletionMode(opts.completion);
  if (opts.provider) buildPatch.provider = parseProvider(opts.provider);
  if (opts.autoMergeWait !== undefined) buildPatch.auto_merge_wait = Boolean(opts.autoMergeWait);
  if (opts.autoMergeTimeoutMinutes !== undefined) {
    buildPatch.auto_merge_timeout_minutes = parseOptionalPositiveInteger(opts.autoMergeTimeoutMinutes, "--auto-merge-timeout-minutes");
  }
  if (buildPatch.branch_strategy === "current") {
    if (buildPatch.completion && buildPatch.completion !== "none") fail("--branch-strategy current requires --completion none");
    buildPatch.completion = "none";
    buildPatch.provider = buildPatch.provider ?? "local";
    buildPatch.pr_ready = false;
    buildPatch.auto_merge_wait = false;
    buildPatch.auto_merge_timeout_minutes = null;
  }

  if (!shouldPrompt(opts)) {
    const prefill = current.sources.length === 0
      ? configuredPlanningSources(dir).map((path) => ({ type: "local" as const, paths: [path] }))
      : current.sources;
    return {
      sources: nonInteractiveSources.length > 0 ? nonInteractiveSources : prefill,
      populate: populatePatch,
      build: Object.keys(buildPatch).length > 0 ? buildPatch : {},
    };
  }

  const section = await select({
    message: "Which ticket setup section should be configured?",
    options: [
      { value: "sources", label: "Ticket sources" },
      { value: "populate", label: "Populate defaults" },
      { value: "build", label: "Build defaults" },
      { value: "all", label: "All sections" },
    ],
  });
  if (isCancel(section)) process.exit(0);

  // Do not silently persist planning hints over a completed ticket setup. They
  // are only the initial local-source suggestion for a fresh setup.
  const planningPrefill = current.sources.length === 0
    ? configuredPlanningSources(dir).map((path) => ({ type: "local" as const, paths: [path] }))
    : current.sources;
  let sources = nonInteractiveSources.length > 0 ? nonInteractiveSources : planningPrefill;
  if (section === "sources" || section === "all") {
    sources = await promptTicketSources(dir, current.sources);
  }
  if (section === "populate" || section === "all") {
    const agent = await select({
      message: "When both runtimes are configured, which should populate use?",
      initialValue: current.populate.agent_preference,
      options: [
        { value: "configured", label: "Configured project default" },
        { value: "claude", label: "Claude" },
        { value: "codex", label: "Codex" },
      ],
    });
    if (isCancel(agent)) process.exit(0);
    populatePatch.agent_preference = agent as TicketsSetupConfig["populate"]["agent_preference"];
  }
  if (section === "build" || section === "all") {
    const recommended = recommendedBuildDefaults(dir);
    const strategy = await select({
      message: "Default ticket work mode:",
      initialValue: current.build.branch_strategy,
      options: [
        { value: "current", label: "One branch - work the queue on the current branch" },
        { value: "batch", label: "Batch branch - use shared branches for explicit delivery batches" },
        { value: "branch-per-ticket", label: "Branch per ticket - isolate each ticket on its own branch" },
      ],
    });
    if (isCancel(strategy)) process.exit(0);
    buildPatch.branch_strategy = strategy as TicketsSetupConfig["build"]["branch_strategy"];
    if (strategy === "current") {
      buildPatch.completion = "none";
      buildPatch.provider = "local";
      buildPatch.pr_ready = false;
      buildPatch.merge_method = "squash";
      buildPatch.cleanup = true;
      buildPatch.auto_merge_wait = false;
      buildPatch.auto_merge_timeout_minutes = null;
      return {
        sources,
        populate: populatePatch,
        build: buildPatch,
      };
    }
    const completion = await select({
      message: "Default completion behavior for branch ticket runs:",
      initialValue: current.build.completion === "none" ? recommended.completion : current.build.completion,
      options: [
        { value: "auto-merge", label: "PR/MR auto-merge, squash when checks pass" },
        { value: "pr", label: "Create PR/MR only" },
        { value: "direct-merge", label: "Direct local squash merge" },
        { value: "none", label: "No branch completion action" },
      ],
    });
    if (isCancel(completion)) process.exit(0);
    buildPatch.completion = completion as TicketBuildCompletionMode;
    buildPatch.provider = recommended.provider;
    buildPatch.pr_ready = completion === "auto-merge";
    buildPatch.merge_method = "squash";
    buildPatch.cleanup = true;
    if (completion === "auto-merge") {
      const wait = await confirm({
        message: "Wait for dependency PR/MRs to merge before starting dependent tickets?",
        initialValue: current.build.auto_merge_wait,
      });
      if (isCancel(wait)) process.exit(0);
      buildPatch.auto_merge_wait = Boolean(wait);
      if (wait) {
        const timeout = await text({
          message: "Auto-merge dependency wait timeout in minutes (blank for no timeout):",
          initialValue: current.build.auto_merge_timeout_minutes === null ? "" : String(current.build.auto_merge_timeout_minutes),
          defaultValue: "",
          validate: (value) => {
            const textValue = String(value ?? "").trim();
            if (!textValue) return undefined;
            const parsed = Number.parseInt(textValue, 10);
            return Number.isInteger(parsed) && parsed > 0 ? undefined : "Enter a positive integer or leave blank";
          },
        });
        if (isCancel(timeout)) process.exit(0);
        buildPatch.auto_merge_timeout_minutes = String(timeout).trim()
          ? Number.parseInt(String(timeout).trim(), 10)
          : null;
      } else {
        buildPatch.auto_merge_timeout_minutes = null;
      }
    } else {
      buildPatch.auto_merge_wait = false;
      buildPatch.auto_merge_timeout_minutes = null;
    }
  }

  return {
    sources,
    populate: populatePatch,
    build: buildPatch,
  };
}

async function promptTicketSources(dir: string, current: TicketSourceConfig[]): Promise<TicketSourceConfig[]> {
  const kind = await select({
    message: "Primary ticket source:",
    options: [
      { value: "local", label: "Local docs, files, folders, or globs" },
      { value: "linear", label: "Linear" },
      { value: "jira", label: "Jira Cloud" },
      { value: "url", label: "Public URL (HTML, text, Markdown, or PDF)" },
      { value: "none", label: "No saved source" },
    ],
  });
  if (isCancel(kind)) process.exit(0);
  if (kind === "none") return [];
  if (kind === "local") {
    const existing = current.find((source) => source.type === "local") as Extract<TicketSourceConfig, { type: "local" }> | undefined;
    const answer = await text({
      message: "Local source paths or globs, comma-separated:",
      initialValue: existing?.paths.join(", ") || `${configuredDocsPlanPath(dir)}`,
      defaultValue: existing?.paths.join(", ") || `${configuredDocsPlanPath(dir)}`,
    });
    if (isCancel(answer)) process.exit(0);
    return [{ type: "local", paths: splitCommaList(String(answer)) }];
  }
  if (kind === "linear") {
    const team = await text({ message: "Linear team key (optional):" });
    if (isCancel(team)) process.exit(0);
    const filter = await text({ message: "Linear IssueFilter JSON or title search text (optional):" });
    if (isCancel(filter)) process.exit(0);
    return [{
      type: "linear",
      api_key_env: "LINEAR_API_KEY",
      team_key: String(team).trim() || null,
      filter: String(filter).trim() || null,
    }];
  }
  if (kind === "url") {
    const existing = current.find((source) => source.type === "url") as Extract<TicketSourceConfig, { type: "url" }> | undefined;
    const answer = await text({
      message: "Public HTTP(S) URL:",
      initialValue: existing?.url,
      validate: (value) => /^https?:\/\//i.test(String(value ?? "")) ? undefined : "Enter an HTTP(S) URL",
    });
    if (isCancel(answer)) process.exit(0);
    return [{ type: "url", url: String(answer).trim() }];
  }
  const site = await text({
    message: "Jira Cloud site URL:",
    placeholder: "https://your-domain.atlassian.net",
    validate: (value) => String(value ?? "").trim() ? undefined : "Enter a Jira Cloud site URL",
  });
  if (isCancel(site)) process.exit(0);
  const jql = await text({
    message: "Jira JQL:",
    initialValue: "resolution = Unresolved ORDER BY priority DESC, updated DESC",
    defaultValue: "resolution = Unresolved ORDER BY priority DESC, updated DESC",
  });
  if (isCancel(jql)) process.exit(0);
  return [{
    type: "jira",
    site: String(site).trim(),
    email_env: "JIRA_EMAIL",
    token_env: "JIRA_API_TOKEN",
    jql: String(jql).trim(),
  }];
}

function sourcesFromSetupOptions(opts: SetupCommandOptions): TicketSourceConfig[] {
  const sources: TicketSourceConfig[] = [];
  if (opts.localSource?.length) sources.push({ type: "local", paths: opts.localSource });
  if (opts.linear || opts.linearTeamKey || opts.linearFilter) {
    sources.push({
      type: "linear",
      api_key_env: "LINEAR_API_KEY",
      team_key: opts.linearTeamKey ?? null,
      filter: opts.linearFilter ?? null,
    });
  }
  if (opts.jiraSite || opts.jiraJql) {
    if (!opts.jiraSite || !opts.jiraJql) fail("--jira-site and --jira-jql must be passed together");
    sources.push({
      type: "jira",
      site: opts.jiraSite,
      email_env: "JIRA_EMAIL",
      token_env: "JIRA_API_TOKEN",
      jql: opts.jiraJql,
    });
  }
  for (const url of opts.urlSource ?? []) sources.push({ type: "url", url });
  return sources;
}

async function validateConfiguredSourcesIfRequested(projectDir: string, setup: TicketsSetupConfig, skip: boolean): Promise<void> {
  if (skip) return;
  for (const source of externalSources(setup)) {
    try {
      await validateExternalSourceAccess(source);
      console.log(`foreman tickets setup: validated ${source.type} access`);
    } catch (err) {
      console.log(`foreman tickets setup: ${source.type} access check skipped/failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const source of urlSources(setup)) {
    const fetched = await fetchAndSnapshotUrl(projectDir, source.url).catch((err) => {
      throw new Error(`URL access validation failed for ${source.url}: ${err instanceof Error ? err.message : String(err)}`);
    });
    console.log(`foreman tickets setup: validated URL access (${fetched.contentType}, ${fetched.bytes} bytes)`);
  }
}

function shouldPrompt(opts: { defaults?: boolean; yes?: boolean }): boolean {
  return !opts.defaults && !opts.yes && process.stdin.isTTY && process.stdout.isTTY;
}

function parseRuntimeTargets(value: string | undefined): HarnessTarget[] | undefined {
  if (!value) return undefined;
  if (value === "both") return ["claude", "codex"];
  if (value === "claude" || value === "codex") return [value];
  fail("--runtime must be one of: both, claude, codex");
}

function parseCompletionMode(value: string): TicketBuildCompletionMode {
  if (["pr", "auto-merge", "direct-merge", "none"].includes(value)) return value as TicketBuildCompletionMode;
  fail("--completion must be one of: pr, auto-merge, direct-merge, none");
}

function parseBranchStrategy(value: string): TicketsSetupConfig["build"]["branch_strategy"] {
  if (["current", "batch", "branch-per-ticket"].includes(value)) return value as TicketsSetupConfig["build"]["branch_strategy"];
  fail("--branch-strategy must be one of: current, batch, branch-per-ticket");
}

function parseProvider(value: string): TicketsSetupConfig["build"]["provider"] {
  if (["auto", "github", "gitlab", "local"].includes(value)) return value as TicketsSetupConfig["build"]["provider"];
  fail("--provider must be one of: auto, github, gitlab, local");
}

function parseAgentPreference(value: string): TicketsSetupConfig["populate"]["agent_preference"] {
  if (["configured", "claude", "codex"].includes(value)) return value as TicketsSetupConfig["populate"]["agent_preference"];
  fail("--agent-preference must be one of: configured, claude, codex");
}

function parseOptionalPositiveInteger(value: string, label: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number.parseInt(value, 10);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  fail(`${label} must be a positive integer or blank`);
}

function splitCommaList(value: string): string[] {
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function configuredDocsPlanPath(dir: string): string {
  const raw = loadTicketSetupConfig(dir);
  const local = localSourcePaths(raw)[0];
  if (local) return local;
  const configPath = join(dir, "rafi-config.yaml");
  if (existsSync(configPath)) {
    const parsed = parseYaml(readFileSync(configPath, "utf8")) as Record<string, unknown> | undefined;
    const docs = parsed?.docs as Record<string, unknown> | undefined;
    if (typeof docs?.root === "string") return `${docs.root}/rafi-plan.md`;
  }
  return "docs/rafi-plan.md";
}

async function resolveInitAppName(dir: string, yes: boolean): Promise<string | undefined> {
  const configured = defaultAppName(dir);
  if (configured !== "My App") return configured;
  if (yes || !process.stdin.isTTY || !process.stdout.isTTY) return configured;
  const answer = await text({
    message: "App name:",
    initialValue: configured,
    defaultValue: configured,
  });
  if (isCancel(answer)) process.exit(0);
  return String(answer).trim() || configured;
}

async function resolvePopulateSourceSelection(
  dir: string,
  explicitSources: string[] | undefined,
  ticketsConfig: TicketsConfig,
  yes: boolean,
): Promise<string[] | undefined> {
  if (explicitSources?.length) return explicitSources;
  const setup = loadTicketSetupConfig(dir);
  const saved = localSourcePaths(setup);
  if (saved.length > 0) return saved;

  const defaultPlan = resolvePopulateSources(dir, undefined, ticketsConfig);
  if (defaultPlan?.length) {
    if (yes || !process.stdin.isTTY || !process.stdout.isTTY) return defaultPlan;
    const usePlan = await confirm({
      message: `Use ${defaultPlan.join(", ")} as the ticket population source?`,
      initialValue: true,
    });
    if (isCancel(usePlan)) process.exit(0);
    return usePlan ? defaultPlan : undefined;
  }

  if (yes || !process.stdin.isTTY || !process.stdout.isTTY) {
    console.log("foreman tickets: no ticket sources were found.");
    console.log("foreman tickets: options:");
    console.log("  rafi plan .");
    console.log("  rafi tickets setup:init");
    console.log("  rafi tickets populate --sources <files-or-globs>");
    console.log("  edit .tickets/tickets.yaml manually");
    process.exit(2);
  }

  const action = await select({
    message: "No ticket sources were found. What should happen next?",
    options: [
      { value: "plan", label: "Run planner first - rafi plan ." },
      { value: "setup", label: "Configure ticket setup" },
      { value: "manual", label: "Enter source paths now" },
      { value: "none", label: "Do nothing" },
    ],
  });
  if (isCancel(action) || action === "none") {
    console.log("foreman tickets: cancelled");
    process.exit(0);
  }
  if (action === "setup") {
    await cmdSetupInitCli({ project: dir });
    process.exit(0);
  }
  if (action === "plan") {
    console.log(`foreman tickets: run \`rafi plan ${shellQuote(dir)}\`, then \`rafi tickets populate --project ${shellQuote(dir)}\`.`);
    process.exit(0);
  }

  const entered = await text({
    message: "Source paths or globs, comma-separated:",
    validate: (value) => String(value ?? "").trim() ? undefined : "Enter at least one source path or glob",
  });
  if (isCancel(entered)) process.exit(0);
  return splitCommaList(String(entered));
}

function reviewActionFromOptions(opts: {
  id?: string;
  accept?: boolean;
  dismiss?: boolean;
  defer?: boolean;
  acceptAll?: boolean;
  dismissAll?: boolean;
  deferAll?: boolean;
}): { action: "accept" | "dismiss" | "defer"; all: boolean; id?: number } | undefined {
  const selected = [
    opts.accept ? "accept" : null,
    opts.dismiss ? "dismiss" : null,
    opts.defer ? "defer" : null,
    opts.acceptAll ? "acceptAll" : null,
    opts.dismissAll ? "dismissAll" : null,
    opts.deferAll ? "deferAll" : null,
  ].filter(Boolean) as string[];
  if (selected.length === 0) return undefined;
  if (selected.length > 1) fail("choose only one review action");
  const raw = selected[0]!;
  const all = raw.endsWith("All");
  const action = raw.replace(/All$/, "") as "accept" | "dismiss" | "defer";
  if (!all && opts.id === undefined) fail("--id <n> is required unless using an all action");
  const id = opts.id !== undefined ? Number(opts.id) : undefined;
  if (id !== undefined && (!Number.isInteger(id) || id < 1)) fail("--id must be a positive integer");
  return { action, all, id };
}

export async function cmdPopulateCli(opts: PopulateCommandOptions): Promise<void> {
  const dir = cwd(opts);
  validateEffort(opts.effort);

  if (!existsSync(dir)) fail(`project directory not found: ${dir}`);

  if (!isTicketsInitialized(dir)) {
    fail(`ticket tracker is not initialized in ${dir}; run \`foreman tickets init --project ${dir}\` first`);
  }

  const ticketsConfig = loadTicketsConfig(dir);
  const setup = loadTicketSetupConfig(dir);
  const explicitSources = opts.sources ? await prepareDocumentSources(dir, opts.sources) : undefined;
  const configuredExternalSources = explicitSources?.length ? [] : externalSources(setup);
  const configuredUrlSources = explicitSources?.length ? [] : urlSources(setup);
  const savedLocalSources = explicitSources?.length ? [] : localSourcePaths(setup);
  const selectedLocalHints = configuredExternalSources.length > 0 && savedLocalSources.length === 0 && configuredUrlSources.length === 0
    ? undefined
    : await resolvePopulateSourceSelection(dir, explicitSources, ticketsConfig, Boolean(opts.yes));
  const localHints = selectedLocalHints ? await prepareDocumentSources(dir, selectedLocalHints) : undefined;
  const urlHints: string[] = [];
  for (const source of configuredUrlSources) {
    const fetched = await fetchAndSnapshotUrl(dir, source.url);
    urlHints.push(fetched.snapshotPath);
    console.log(`foreman tickets: fetched ${source.url} -> ${fetched.snapshotPath}`);
  }
  const sourceHints = unique([...(localHints ?? []), ...urlHints]);
  const populateAgent = opts.agent
    ?? (setup?.populate.agent_preference && setup.populate.agent_preference !== "configured"
      ? setup.populate.agent_preference
      : undefined);

  if (configuredExternalSources.length > 0) {
    if (!opts.yes) {
      const action = await select({
        message: `Import ${configuredExternalSources.length} configured external ticket source(s)?`,
        options: [
          { value: "proceed", label: "Proceed - fetch external tickets and update .tickets" },
          { value: "cancel", label: "Cancel" },
        ],
      });
      if (isCancel(action) || action === "cancel") {
        console.log("foreman tickets: cancelled");
        process.exit(0);
      }
    }
    const results = await importExternalSources(dir, configuredExternalSources, {
      importCap: setup?.populate.import_cap ?? DEFAULT_TICKET_SETUP.populate.import_cap,
      commentLimit: setup?.populate.comment_limit ?? DEFAULT_TICKET_SETUP.populate.comment_limit,
      recommendSplitForXl: setup?.populate.recommend_split_for_xl ?? DEFAULT_TICKET_SETUP.populate.recommend_split_for_xl,
    });
    for (const result of results) {
      console.log(`foreman tickets: imported ${result.fetched} ${result.provider} item(s) from ${result.sourceLabel} (${result.created} created, ${result.updated} updated)`);
      console.log(`foreman tickets: snapshot ${result.snapshotPath}`);
    }
    cmdRender(dir);
    const validation = cmdValidate(dir);
    if (validation.issues.length > 0) {
      console.log(`foreman tickets: ${validation.issues.length} validation issue(s) found:`);
      console.log(formatValidationIssues(validation.issues));
      if (!validation.clean) process.exit(1);
    }
    if (!sourceHints.length) {
      console.log(`foreman tickets: imported external tickets and rendered ${ticketsConfig.paths.progressDoc}`);
      return;
    }
  }

  const structuredPlan = loadPopulationPlan(dir, sourceHints);

  if (!opts.yes) {
    const action = await select({
      message: "Ask the read-only Ticket Maker for a structured population proposal?",
      options: [
        { value: "proceed", label: "Proceed - generate proposal only" },
        { value: "cancel", label: "Cancel" },
      ],
    });
    if (isCancel(action) || action === "cancel") {
      console.log("foreman tickets: cancelled");
      process.exit(0);
    }
  }

  const logPath = makeLogPath(dir, "tickets-populate");
  const log = new Log(logPath);
  const config = loadConfig(join(dir, "foreman.yaml"));
  let builder: Awaited<ReturnType<typeof createRoleBuilder>>["builder"] | undefined;
  let viewer: Promise<void> | undefined;

  try {
    const roleBuilder = await createRoleBuilder(buildPopulateAgentRunOptions({
      projectDir: dir,
      agent: populateAgent,
      model: opts.model,
      effort: opts.effort as EffortLevel | undefined,
      fast: opts.fast,
      yes: Boolean(opts.yes),
      log,
    }));
    builder = roleBuilder.builder;
    viewer = printEvents(builder.events());
    const foreman = new Foreman(builder, log, config.notifications.enabled, false, 3, dir);

    console.log(`foreman tickets: populating tickets with ${roleBuilder.runtime}`);
    console.log(`foreman tickets: project ${dir}`);
    console.log(`foreman tickets: role ${TICKET_POPULATE_ROLE}`);
    console.log(`foreman tickets: log ${logPath}\n`);

    if (sourceHints.length) {
      console.log(`foreman tickets: source hints ${sourceHints.join(" ")}`);
    }
    const turn = await foreman.runInstruction(buildPopulateInstruction(sourceHints, ticketsConfig.paths.progressDoc));
    await builder.close();
    await viewer;

    log.write("ticket-populate", {
      statusKind: turn.status.kind,
      summary: turn.status.summary,
      reason: turn.status.reason,
      costUsd: turn.result.costUsd,
      isError: turn.result.isError,
    });

    if (turn.result.isError) {
      fail(`builder turn errored: ${turn.result.text.slice(0, 200)}`);
    }
    if (turn.status.kind === "blocked") {
      console.error(`foreman tickets: blocked — ${turn.status.reason ?? "builder reported blocked"}`);
      process.exit(2);
    }
    if (turn.status.kind !== "done" && turn.status.kind !== "plan_complete") {
      console.error(`foreman tickets: needs human — ${turn.status.error ?? "builder did not emit done"}`);
      process.exit(2);
    }

    const existing = loadTickets(resolveTicketPaths(ticketsConfig, dir).tickets);
    const proposal = extractTicketPopulationProposal(turn.result.text);
    const materialized = materializeTicketPopulation(proposal, structuredPlan, existing);
    let retirementsConfirmed = false;
    if (!opts.yes) {
      console.log(`foreman tickets: proposal maps ${materialized.sliceToTicket.size} slice(s) and retires ${materialized.retirements.join(", ") || "none"}`);
      const approved = await confirm({ message: "Apply this exact ticket and delivery proposal?", initialValue: false });
      if (isCancel(approved) || !approved) { console.log("foreman tickets: cancelled; no files or tracker state changed"); return; }
      if (materialized.retirements.length) {
        const retirement = await confirm({ message: `Mark these removed-slice tickets obsolete: ${materialized.retirements.join(", ")}?`, initialValue: false });
        if (isCancel(retirement) || !retirement) { console.log("foreman tickets: cancelled; no files or tracker state changed"); return; }
        retirementsConfirmed = true;
      }
    }
    authorizeTicketRetirements(materialized.retirements, { interactiveConfirmed: retirementsConfirmed, authorizedIds: opts.authorizeRetire, computerRun: Boolean(opts.yes) });
    const applied = applyTicketPopulation(dir, materialized);
    console.log(`foreman tickets: populated atomically (run ${applied.runId}, transaction ${applied.transactionId})`);
  } catch (err) {
    await builder?.close().catch(() => {});
    await viewer?.catch(() => {});
    fail(String(err instanceof Error ? err.message : err));
  }
}

async function prepareDocumentSources(projectDir: string, sources: string[]): Promise<string[]> {
  const prepared: string[] = [];
  for (const source of sources) {
    if (/^https?:\/\//i.test(source)) {
      prepared.push((await fetchAndSnapshotUrl(projectDir, source)).snapshotPath);
      continue;
    }
    const absolute = resolve(source);
    if (isAbsolute(source) && existsSync(absolute)) prepared.push(snapshotExternalLocalFile(projectDir, absolute));
    else prepared.push(source);
  }
  return unique(prepared);
}

function loadPopulationPlan(projectDir: string, sources: string[]): StructuredPlanV1 {
  for (const source of sources) {
    const candidate = source.endsWith(".json") ? resolve(projectDir, source) : source.endsWith(".md") ? resolve(projectDir, source.replace(/\.md$/, ".json")) : undefined;
    if (!candidate || !existsSync(candidate)) continue;
    const plan = JSON.parse(readFileSync(candidate, "utf8")) as StructuredPlanV1;
    if (plan.version === 1 && plan.plan_id && Number.isInteger(plan.revision) && plan.content_digest) return plan;
  }
  throw new Error("ticket population requires the approved paired structured plan (normally docs/rafi-plan.json); run `rafi plan --validate` first");
}

export function buildTicketsCommand(): Command {
  const tickets = new Command("tickets").description(
    "Manage the structured ticket tracker for a project.",
  );

  // ── setup:init / setup:update ─────────────────────────────────────────────

  tickets
    .command("setup:init")
    .description("Configure ticket sources, populate defaults, and build defaults in rafi-config.yaml.")
    .option("-p, --project <dir>", "project directory (default: cwd)")
    .option("--defaults", "skip prompts and use recommended ticket setup defaults")
    .option("-y, --yes", "skip prompts where possible")
    .option("--app-name <name>", "application name for a new minimal rafi-config.yaml")
    .option("--docs-root <dir>", "repo-relative docs root for a new minimal rafi-config.yaml and ticket docs")
    .option("--runtime <runtime>", "runtime targets for a new minimal rafi-config.yaml (both | claude | codex)")
    .option("--local-source <paths...>", "saved local ticket source files, folders, or globs")
    .option("--linear", "add a Linear source using LINEAR_API_KEY")
    .option("--linear-team-key <key>", "Linear team key filter")
    .option("--linear-filter <filter>", "Linear IssueFilter JSON or title search text")
    .option("--jira-site <url>", "Jira Cloud site URL")
    .option("--jira-jql <jql>", "Jira JQL query")
    .option("--url-source <urls...>", "add public HTTP(S) source URLs")
    .option("--agent-preference <agent>", "populate runtime preference (configured | claude | codex)")
    .option("--branch-strategy <strategy>", "build branch strategy default (current | batch | branch-per-ticket)")
    .option("--completion <mode>", "build completion default (pr | auto-merge | direct-merge | none)")
    .option("--provider <provider>", "PR/MR provider default (auto | github | gitlab | local)")
    .option("--auto-merge-wait", "wait for dependency PR/MRs to merge before starting dependent tickets")
    .option("--auto-merge-timeout-minutes <n>", "auto-merge dependency wait timeout in minutes (blank means no timeout)")
    .option("--skip-access-check", "do not validate configured source access during setup")
    .action(async (opts) => {
      try {
        await cmdSetupInitCli(opts);
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  tickets
    .command("setup:update")
    .description("Update selected ticket setup sections in rafi-config.yaml.")
    .option("-p, --project <dir>", "project directory (default: cwd)")
    .option("--defaults", "skip prompts and keep existing values unless explicit options are provided")
    .option("-y, --yes", "skip prompts where possible")
    .option("--app-name <name>", "application name for a new minimal rafi-config.yaml")
    .option("--docs-root <dir>", "repo-relative docs root for a new minimal rafi-config.yaml and ticket docs")
    .option("--runtime <runtime>", "runtime targets for a new minimal rafi-config.yaml (both | claude | codex)")
    .option("--local-source <paths...>", "replace saved local ticket source files, folders, or globs")
    .option("--linear", "replace saved sources with a Linear source using LINEAR_API_KEY")
    .option("--linear-team-key <key>", "Linear team key filter")
    .option("--linear-filter <filter>", "Linear IssueFilter JSON or title search text")
    .option("--jira-site <url>", "Jira Cloud site URL")
    .option("--jira-jql <jql>", "Jira JQL query")
    .option("--url-source <urls...>", "replace saved sources with public HTTP(S) URLs")
    .option("--agent-preference <agent>", "populate runtime preference (configured | claude | codex)")
    .option("--branch-strategy <strategy>", "build branch strategy default (current | batch | branch-per-ticket)")
    .option("--completion <mode>", "build completion default (pr | auto-merge | direct-merge | none)")
    .option("--provider <provider>", "PR/MR provider default (auto | github | gitlab | local)")
    .option("--auto-merge-wait", "wait for dependency PR/MRs to merge before starting dependent tickets")
    .option("--auto-merge-timeout-minutes <n>", "auto-merge dependency wait timeout in minutes (blank means no timeout)")
    .option("--skip-access-check", "do not validate configured source access during setup")
    .action(async (opts) => {
      try {
        await cmdSetupUpdateCli(opts);
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  // ── init ────────────────────────────────────────────────────────────────────

  tickets
    .command("init")
    .description("Initialize .tickets/ structure in a project directory.")
    .option("-p, --project <dir>", "project directory (default: cwd)")
    .option("--app-name <name>", "application name")
    .option("--timezone <tz>", "IANA timezone (e.g. America/Chicago)", "UTC")
    .option("--implementation-limit <n>", "implementation queue window size", String(DEFAULT_TICKETS_CONFIG.implementationLimit))
    .option("--view-limit <n>", "ticket queue display limit", String(DEFAULT_TICKETS_CONFIG.viewLimit))
    .option("--queue-limit <n>", "deprecated alias for --implementation-limit")
    .option("--docs-root <dir>", "repo-relative directory for generated ticket docs")
    .option("-y, --yes", "skip app-name prompt when no config/package default exists")
    .action(async (opts, command: Command) => {
      const dir = cwd(opts);
      try {
        const hasImplementationLimit = optionWasProvided(command, "implementationLimit");
        const hasLegacyQueueLimit = optionWasProvided(command, "queueLimit");
        if (hasImplementationLimit && hasLegacyQueueLimit) {
          fail("--implementation-limit and deprecated --queue-limit cannot both be passed");
        }
        const appName = opts.appName as string | undefined ?? await resolveInitAppName(dir, Boolean(opts.yes));
        cmdInit(dir, {
          appName,
          timezone: opts.timezone as string,
          implementationLimit: hasImplementationLimit ? Number(opts.implementationLimit) : undefined,
          viewLimit: optionWasProvided(command, "viewLimit") ? Number(opts.viewLimit) : undefined,
          queueLimit: hasLegacyQueueLimit ? Number(opts.queueLimit) : undefined,
          docsRoot: opts.docsRoot as string | undefined,
        });
        console.log(`foreman tickets: initialized .tickets/ in ${dir}`);
        console.log(`foreman tickets: next — add tickets to .tickets/tickets.yaml and run \`foreman tickets render\``);
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  // ── populate ────────────────────────────────────────────────────────────────

  tickets
    .command("populate")
    .description("Ask the ticket-maker role to populate .tickets/tickets.yaml from existing project ticket/backlog docs.")
    .option("-p, --project <dir>", "project directory (default: cwd)")
    .option("-a, --agent <agent>", "builder agent (claude | codex)")
    .option("-m, --model <model>", "override the builder's model")
    .option("--effort <level>", "reasoning effort level (low|medium|high|xhigh)")
    .option("--sources <paths...>", "source hint files, folders, or globs to check first")
    .option("--fast", "fast mode - lower latency")
    .option("--authorize-retire <ids...>", "exact ticket IDs authorized to become obsolete in computer-run mode")
    .option("-y, --yes", "computer-run approval; retirements still require --authorize-retire exact IDs")
    .action(async (opts) => {
      try {
        await cmdPopulateCli(opts);
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  // ── update ──────────────────────────────────────────────────────────────────

  tickets
    .command("update <ticketId>")
    .description("Update ticket status or progress fields.")
    .option("-p, --project <dir>", "project directory (default: cwd)")
    .option("--status <status>", "new status (planned|next|in_progress|blocked|done|canceled)")
    .option("--actor <actor>", "who is making this update")
    .option("--summary <text>", "short description of the update")
    .option("--next-action <text>", "what comes next for this ticket")
    .option("--current-step <text>", "current implementation step")
    .option("--owner <name>", "ticket owner")
    .option("--validation-result <result>", "passed|failed|not_run|not_applicable")
    .option("--validation-commands <cmds>", "commands used to validate")
    .option("--evidence <text>", "evidence of correctness")
    .option("--last-error <text>", "last error message if tests failed")
    .action((ticketId: string, opts) => {
      try {
        cmdUpdate(cwd(opts), ticketId, {
          status: opts.status as string | undefined,
          actor: opts.actor as string | undefined,
          summary: opts.summary as string | undefined,
          nextAction: opts.nextAction as string | undefined,
          currentStep: opts.currentStep as string | undefined,
          owner: opts.owner as string | undefined,
          validationResult: opts.validationResult as "passed" | "failed" | "not_run" | "not_applicable" | undefined,
          validationCommands: opts.validationCommands as string | undefined,
          evidence: opts.evidence as string | undefined,
          lastError: opts.lastError as string | undefined,
        });
        console.log(`foreman tickets: updated ${ticketId}`);
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  // ── complete ────────────────────────────────────────────────────────────────

  tickets
    .command("complete <ticketId>")
    .description("Mark a ticket done with validation evidence.")
    .option("-p, --project <dir>", "project directory (default: cwd)")
    .option("--actor <actor>", "who completed this ticket")
    .option("--summary <text>", "completion summary")
    .option("--validation-result <result>", "passed|failed|not_run|not_applicable", "passed")
    .option("--validation-commands <cmds>", "commands used to validate")
    .option("--evidence <text>", "evidence of correctness (required unless not_applicable)")
    .option("--validation-notes <text>", "extra notes about validation")
    .action((ticketId: string, opts) => {
      try {
        cmdComplete(cwd(opts), ticketId, {
          actor: opts.actor as string | undefined,
          summary: opts.summary as string | undefined,
          validationResult: opts.validationResult as "passed" | "failed" | "not_run" | "not_applicable",
          validationCommands: opts.validationCommands as string | undefined,
          evidence: opts.evidence as string | undefined,
          validationNotes: opts.validationNotes as string | undefined,
        });
        console.log(`foreman tickets: completed ${ticketId}`);
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  // ── block ────────────────────────────────────────────────────────────────────

  tickets
    .command("block <ticketId>")
    .description("Mark a ticket as blocked.")
    .option("-p, --project <dir>", "project directory (default: cwd)")
    .option("--blocked-by <ids...>", "ticket IDs or labels that are blocking")
    .option("--type <type>", "blocker type (dependency|external|decision|...)")
    .option("--summary <text>", "description of the blocker")
    .option("--unblock-criteria <text>", "what needs to happen to unblock")
    .option("--actor <actor>", "who is recording this blocker")
    .action((ticketId: string, opts) => {
      try {
        cmdBlock(cwd(opts), ticketId, {
          blockedBy: opts.blockedBy as string[] | undefined,
          blockerType: opts.type as string | undefined,
          summary: opts.summary as string | undefined,
          actor: opts.actor as string | undefined,
          unblockCriteria: opts.unblockCriteria as string | undefined,
        });
        console.log(`foreman tickets: blocked ${ticketId}`);
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  // ── unblock ──────────────────────────────────────────────────────────────────

  tickets
    .command("unblock <ticketId>")
    .description("Remove explicit blockers from a ticket.")
    .option("-p, --project <dir>", "project directory (default: cwd)")
    .option("--summary <text>", "description of how it was unblocked")
    .option("--actor <actor>", "who resolved the blocker")
    .action((ticketId: string, opts) => {
      try {
        cmdUnblock(cwd(opts), ticketId, {
          summary: opts.summary as string | undefined,
          actor: opts.actor as string | undefined,
        });
        console.log(`foreman tickets: unblocked ${ticketId}`);
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  // ── cancel ───────────────────────────────────────────────────────────────────

  tickets
    .command("cancel <ticketId>")
    .description("Cancel a ticket.")
    .option("-p, --project <dir>", "project directory (default: cwd)")
    .requiredOption("--summary <text>", "reason for cancellation")
    .option("--actor <actor>", "who canceled this ticket")
    .action((ticketId: string, opts) => {
      try {
        cmdCancel(cwd(opts), ticketId, {
          summary: opts.summary as string,
          actor: opts.actor as string | undefined,
        });
        console.log(`foreman tickets: canceled ${ticketId}`);
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  // ── discover ─────────────────────────────────────────────────────────────────

  tickets
    .command("discover")
    .description("Add newly discovered future work to the inbox.")
    .option("-p, --project <dir>", "project directory (default: cwd)")
    .requiredOption("--summary <text>", "short description of the discovered work")
    .option("--source-ticket <id>", "ticket that led to this discovery")
    .option("--proposed-ticket <id>", "proposed ticket ID")
    .option("--priority-guess <p>", "P0|P1|P2|P3")
    .option("--area <area>", "product/code area")
    .option("--rationale <text>", "why this work is needed")
    .option("--needs-decision-from <who>", "who needs to decide")
    .option("--actor <actor>", "who discovered this")
    .action((opts) => {
      try {
        const id = cmdDiscover(cwd(opts), {
          summary: opts.summary as string,
          sourceTicket: opts.sourceTicket as string | undefined,
          proposedTicket: opts.proposedTicket as string | undefined,
          priorityGuess: opts.priorityGuess as string | undefined,
          area: opts.area as string | undefined,
          rationale: opts.rationale as string | undefined,
          needsDecisionFrom: opts.needsDecisionFrom as string | undefined,
          actor: opts.actor as string | undefined,
        });
        console.log(`foreman tickets: logged future work item #${id}`);
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  // ── accept-future-work ────────────────────────────────────────────────────────

  tickets
    .command("accept-future-work <futureWorkId>")
    .description("Promote a future-work item into tickets.yaml as a new ticket.")
    .option("-p, --project <dir>", "project directory (default: cwd)")
    .requiredOption("--ticket-id <id>", "new ticket ID (e.g. T051)")
    .requiredOption("--order <n>", "canonical implementation order (e.g. 51000)")
    .option("--actor <actor>", "who accepted this item")
    .action((futureWorkId: string, opts) => {
      try {
        cmdAcceptFutureWork(cwd(opts), Number(futureWorkId), {
          ticketId: opts.ticketId as string,
          order: Number(opts.order),
          actor: opts.actor as string | undefined,
        });
        console.log(`foreman tickets: accepted future work #${futureWorkId} as ${opts.ticketId}`);
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  // ── reorder ──────────────────────────────────────────────────────────────────

  tickets
    .command("reorder <ticketId>")
    .description("Change the canonical implementation order of a ticket.")
    .option("-p, --project <dir>", "project directory (default: cwd)")
    .option("--after <ticketId>", "place this ticket immediately after another")
    .option("--order <n>", "set explicit order value")
    .option("--actor <actor>", "who reordered this")
    .action((ticketId: string, opts) => {
      try {
        cmdReorder(cwd(opts), ticketId, {
          afterTicketId: opts.after as string | undefined,
          order: opts.order ? Number(opts.order) : undefined,
          actor: opts.actor as string | undefined,
        });
        console.log(`foreman tickets: reordered ${ticketId}`);
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  // ── review recommendations ────────────────────────────────────────────────

  tickets
    .command("review")
    .description("Review pending split/combine/duplicate ticket recommendations.")
    .option("-p, --project <dir>", "project directory (default: cwd)")
    .option("--id <n>", "recommendation id to review")
    .option("--accept", "accept the selected recommendation")
    .option("--dismiss", "dismiss the selected recommendation")
    .option("--defer", "defer the selected recommendation")
    .option("--accept-all", "accept every pending recommendation")
    .option("--dismiss-all", "dismiss every pending recommendation")
    .option("--defer-all", "defer every pending recommendation")
    .action(async (opts) => {
      try {
        const dir = cwd(opts);
        const action = reviewActionFromOptions(opts);
        if (action) {
          const result = cmdReview(dir, {
            action: action.action,
            all: action.all,
            ids: action.id !== undefined ? [action.id] : undefined,
          });
          console.log(`foreman tickets: ${action.action}ed ${result.changed} recommendation(s)`);
          if (result.pending.length > 0) console.log(`foreman tickets: ${result.pending.length} pending recommendation(s) remain`);
          return;
        }

        const pending = cmdReview(dir).pending;
        if (pending.length === 0) {
          console.log("foreman tickets: no pending review recommendations");
          return;
        }
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          for (const rec of pending) {
            console.log(`#${rec.id} [${rec.kind}] ${rec.summary}`);
          }
          console.log("foreman tickets: use --accept-all, --dismiss-all, --defer-all, or --id <n> --accept|--dismiss|--defer");
          return;
        }

        const picked = await select({
          message: "Pending recommendation:",
          options: pending.map((rec) => ({
            value: String(rec.id),
            label: `#${rec.id} [${rec.kind}] ${rec.summary}`,
          })),
        });
        if (isCancel(picked)) process.exit(0);
        const disposition = await select({
          message: "Apply recommendation?",
          options: [
            { value: "accept", label: "Accept and apply patch" },
            { value: "defer", label: "Defer" },
            { value: "dismiss", label: "Dismiss" },
          ],
        });
        if (isCancel(disposition)) process.exit(0);
        const result = cmdReview(dir, {
          action: disposition as "accept" | "defer" | "dismiss",
          ids: [Number(picked)],
        });
        console.log(`foreman tickets: ${disposition}ed ${result.changed} recommendation(s)`);
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  // ── render ───────────────────────────────────────────────────────────────────

  tickets
    .command("render")
    .description("Regenerate the configured ticket progress doc from current structured sources.")
    .option("-p, --project <dir>", "project directory (default: cwd)")
    .action((opts) => {
      try {
        const ticketsConfig = loadTicketsConfig(cwd(opts));
        cmdRender(cwd(opts));
        console.log(`foreman tickets: rendered ${ticketsConfig.paths.progressDoc}`);
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  // ── validate ─────────────────────────────────────────────────────────────────

  tickets
    .command("validate")
    .description("Run all 4 validation passes. Exits 1 on error.")
    .option("-p, --project <dir>", "project directory (default: cwd)")
    .action((opts) => {
      try {
        const result = cmdValidate(cwd(opts));
        if (result.issues.length === 0) {
          console.log("foreman tickets: validation passed — all 4 passes clean");
        } else {
          console.log(`foreman tickets: ${result.issues.length} issue(s) found:`);
          console.log(formatValidationIssues(result.issues));
          if (!result.clean) process.exit(1);
        }
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  // ── queue ─────────────────────────────────────────────────────────────────────

  tickets
    .command("queue")
    .description("Print the ticket queue to stdout.")
    .option("-p, --project <dir>", "project directory (default: cwd)")
    .option("--limit <n>", "override view limit")
    .option("--refresh", "query GitHub/GitLab and refresh cached batch review state")
    .action((opts) => {
      try {
        const dir = cwd(opts);
        const delivery = loadDeliveryConfig(dir);
        if (delivery?.stacks?.length) {
          const lines = cmdStackQueue(dir, Boolean(opts.refresh));
          if (!lines.length) console.log("No remaining tickets."); else for (const line of lines) console.log(line);
          return;
        }
        console.log("Batches: none configured. Queue is flat.");
        const rows = cmdQueue(dir, opts.limit !== undefined ? Number(opts.limit) : undefined);
        if (rows.length === 0) {
          console.log("No remaining tickets.");
        } else {
          for (const r of rows) {
            console.log(`  ${r.rank}. [${r.status}] ${r.ticket}: ${r.title} (${r.priority}, blocked: ${r.blockedBy})`);
          }
        }
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  // ── archive ───────────────────────────────────────────────────────────────────

  tickets
    .command("archive")
    .description("Update the configured ticket archive doc and prune old completed rows.")
    .option("-p, --project <dir>", "project directory (default: cwd)")
    .option("--older-than-days <n>", "only archive tickets completed more than N days ago")
    .action((opts) => {
      try {
        cmdArchive(cwd(opts), {
          olderThanDays: opts.olderThanDays ? Number(opts.olderThanDays) : undefined,
        });
        console.log("foreman tickets: archive pass complete");
      } catch (err) {
        fail(String(err instanceof Error ? err.message : err));
      }
    });

  // ── import ────────────────────────────────────────────────────────────────────

  tickets
    .command("import")
    .description("(stub) Migrate an existing Markdown tracker.")
    .option("-p, --project <dir>", "project directory (default: cwd)")
    .option("--progress <path>", "path to existing ticket progress Markdown")
    .action((opts) => {
      try {
        const dir = cwd(opts);
        const configuredProgress = (opts.progress as string | undefined) ?? loadTicketsConfig(dir).paths.progressDoc;
        const progress = isAbsolute(configuredProgress) ? configuredProgress : join(dir, configuredProgress);
        importFromMarkdown(progress);
      } catch (err) {
        console.error(String(err instanceof Error ? err.message : err));
        process.exit(1);
      }
    });

  return tickets;
}
