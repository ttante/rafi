import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  assertEffortLevel,
  createRoleBuilder,
  readOnlyPermissionConfig,
  type EffortLevel,
} from "ai-foreman/agent-run.js";
import {
  applyApprovedTicketPlan,
  extractTicketPlanProposal,
  planningFingerprintChanges,
  PROPOSAL_END,
  PROPOSAL_START,
  readTicketPlanningContext,
  ticketPlanningFingerprint,
  validateTicketPlanProposal,
  type TicketPlanProposal,
} from "ai-foreman/ticket-planning.js";
import type { ProjectSourceEntry, SourceRegistryConfig } from "rafi-spec";
import {
  loadSourceRegistry,
  refreshSourceRegistry,
  registerSourceRequests,
  saveSourceRegistry,
  setSourceStorage,
  sourceContext,
  sourceRequestFromAnswer,
  validateSourceVersionRef,
  SOURCE_REQUEST_END,
  SOURCE_REQUEST_START,
} from "ai-foreman/sources/source-registry.js";
import { chooseStagedSourceDisposition, handlePlanningInput, parseSourceStorage, promptSourceStorage } from "./planningDriver.js";
import {
  checkpointInterview,
  completeInterview,
  createInterviewRecord,
  discardInterview,
  failInterview,
  readInterviewRecords,
  type InterviewRecord,
} from "ai-foreman/interviews.js";
import { findNearestRafiProject, resolveExplicitRafiProject, RAFI_CONFIG_FILE } from "./project.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getAgent, loadSkill } from "special-agents";
import { assertLifecycleForCommand } from "./lifecycle.js";

export interface TicketPlanInstructionOptions {
  brief: string;
  sourceChoice: string;
  sources: ProjectSourceEntry[] | Array<Record<string, unknown>>;
  sourceSnapshots: string[];
  context: ReturnType<typeof readTicketPlanningContext>;
  grill: "standard" | "exhaustive";
  docsRoot: string;
}

export function buildTicketPlanInstruction(opts: TicketPlanInstructionOptions): string {
  return `You are Rafi's read-only guided ticket planner. Use the planner role and ticket-maker schema guidance.${opts.grill === "exhaustive" ? " Use the grill-me skill exhaustively." : " Use a standard focused interview."}

Initial description:
${opts.brief}

Remembered sources:
${JSON.stringify(opts.sources, null, 2)}
The user's natural-language source selection: ${opts.sourceChoice}
Validated session snapshots: ${opts.sourceSnapshots.join(", ") || "none"}

Current tracker context (status is authoritative and must be preserved):
${JSON.stringify(opts.context, null, 2)}

Conversation rules:
- Inspect the repository read-only. Do not edit files, configuration, YAML, SQLite, git, branches, or docs.
- Questions must be focused and include a recommended answer first plus alternatives, but the human may answer with any free text.
- Session choices may cover inspection depth, ticket size, estimates, source treatment, delivery grouping, branch mode, PRs, merge behavior, and next work.
- If more source content is needed, emit one JSON object (or an array) between ${SOURCE_REQUEST_START}/${SOURCE_REQUEST_END}, then ask a needs_input question. Preserve the human's complete answer; never split on spaces, commas, or plus signs.
- Source request types are local, url, github, gitlab, linear, and jira. For Linear/Jira request only non-secret query settings and environment-variable names, never credentials.
- Account for every discovered source item with mapped, split, combined, deferred, or excluded disposition and a reason where required.
- Existing IDs are stable. Preserve completed state/evidence. Represent replacements with reciprocal supersession links through the proposal.
- Every addition is a full ticket object with: id, order, title, area, priority (P0-P3), size (XS-XL), risk (Low/Medium/High), depends_on, summary, acceptance, required_tests, likely_files, optional rollback/notes, source_refs, and optional supersession links.
- Use source_refs entries with source and item (plus optional url/fingerprint/note) for general many-to-many provenance; retain legacy external_refs when editing imported tickets.
- When setting next work, explicitly honor whether existing next tickets are retained or replaced.
- The user may ask to upgrade to exhaustive grill-me at any time; retain the current proposal and continue.

Ask questions using a final marker:
STEP_STATUS: needs_input | question="..." choices="Recommended answer|Alternative"

When a complete proposal is ready, return readable Markdown followed by exactly this machine envelope:
${PROPOSAL_START}
{ "version": 1, "title": "...", "markdown": "complete proposed plan", "additions": [], "edits": [], "supersessions": [], "state_changes": [], "source_reconciliation": [], "delivery": null, "build_defaults": null, "future_work": [], "next": { "ticket_ids": [], "replace_existing": false } }
${PROPOSAL_END}
Then end with:
STEP_STATUS: plan_complete | summary="proposal_ready"

The JSON must contain the exact approved candidate ticket set, full ticket objects for additions, patches for edits, optional delivery units, and no commentary outside the schema after ${PROPOSAL_END}.`;
}

export function buildTicketPlanCommand(): Command {
  return new Command("plan")
    .description("Plan and approve ticket work through a guided, project-aware conversation.")
    .option("-p, --project <dir>", "exact project directory (default: discover from cwd)")
    .option("--brief <text>", "initial description (primarily for recovery and non-interactive use)")
    .option("-a, --agent <agent>", "session runtime (claude | codex)")
    .option("-m, --model <model>", "session-only model override")
    .option("--effort <level>", "session-only reasoning override (low|medium|high|xhigh)")
    .option("--resume-session <id>", "resume the planning agent session")
    .option("--source-storage <mode>", "storage for newly captured source versions (local | tracked)")
    .option("--grill-me", "start in exhaustive one-question-at-a-time mode")
    .option("--no-grill-me", "start in standard focused mode (default)")
    .option("-y, --yes", "non-interactive mode; requires --brief and approves a valid proposal")
    .action(async (opts, command: Command) => {
      const parent = command.parent as (Command & { rawArgs?: string[] }) | null;
      return runTicketPlan(opts, parent?.rawArgs ?? (command as Command & { rawArgs?: string[] }).rawArgs);
    });
}

interface TicketPlanOptions { project?: string; brief?: string; agent?: string; model?: string; effort?: string; resumeSession?: string; sourceStorage?: string; yes?: boolean; grillMe?: boolean; }

async function runTicketPlan(opts: TicketPlanOptions, rawArgv = process.argv.slice(2)): Promise<void> {
  assertEffortLevel(opts.effort);
  const interactive = !opts.yes && process.stdin.isTTY && process.stdout.isTTY;
  const argv = rawArgv;
  if (argv.includes("--grill-me") && argv.includes("--no-grill-me")) throw new Error("choose either --grill-me or --no-grill-me, not both");
  let discovered = opts.project ? resolveExplicitRafiProject(opts.project) : findNearestRafiProject(process.cwd());
  if (!discovered) {
    const target = resolve(opts.project ?? process.cwd());
    throw new Error(`no ${RAFI_CONFIG_FILE} found in ${target}; run \`rafi create ${shellQuote(target)}\` first`);
  }
  const projectDir = discovered.root;
  assertLifecycleForCommand(projectDir, "tickets-plan");
  if (discovered.legacy) {
    if (!interactive) throw new Error("legacy project.yaml must be migrated with `rafi compile <project>` before guided ticket planning");
    const { confirm, isCancel } = await import("@clack/prompts");
    const migrate = await confirm({ message: `Legacy project.yaml found at ${projectDir}. Migrate it to rafi-config.yaml before planning?`, initialValue: true });
    if (isCancel(migrate) || !migrate) return;
    runSelf(["compile", projectDir]);
    discovered = resolveExplicitRafiProject(projectDir)!;
  }
  if (!opts.project && projectDir !== resolve(process.cwd()) && interactive) {
    const { confirm, isCancel } = await import("@clack/prompts");
    const config = readProjectConfig(projectDir);
    const use = await confirm({ message: `Use Rafi project ${String(config.appName ?? "unnamed")} at ${projectDir}?`, initialValue: true });
    if (isCancel(use) || !use) return;
  }
  ensureTracker(projectDir, interactive);

  let interview = await chooseInterview(projectDir, interactive, opts);
  try {
    const context = readTicketPlanningContext(projectDir);
    const config = readProjectConfig(projectDir);
    const docsRoot = String((config.docs as Record<string, unknown> | undefined)?.root ?? "docs");
    const savedBrief = opts.brief ?? String(interview?.answers.brief ?? "");
    const brief = savedBrief || await promptText("What would you like to plan? You can describe work, paste requirements, request a repo audit, or name sources:");
    if (!brief.trim()) throw new Error("ticket planning needs an initial description");
    if (interview) interview = checkpointInterview(projectDir, interview, { checkpoint: "sources", answers: { ...interview.answers, brief } });

    const loadedSources = loadSourceRegistry(projectDir);
    let stagedSources: SourceRegistryConfig = loadedSources.registry;
    let selectedStorage = parseSourceStorage(opts.sourceStorage);
    let sourceChoice = interactive
      ? await promptText(`Remembered sources: ${stagedSources.entries.length ? stagedSources.entries.map(sourceLabel).join(", ") : "none"}. Which should this session use?`, stagedSources.entries.length ? "Use all relevant remembered sources" : "Use sources from my description and repository")
      : "Use all relevant remembered sources";
    if (!selectedStorage && interactive && !loadedSources.configured && (brief.trim() || sourceChoice.trim())) selectedStorage = await promptSourceStorage();
    if (selectedStorage) stagedSources = setSourceStorage(stagedSources, selectedStorage);
    const openFuture = context.futureWork.filter((item) => item.disposition === "triage");
    if (interactive && openFuture.length) {
      const choice = await promptText(`Future-work ideas: ${openFuture.map((item) => `${item.id}: ${item.summary}`).join("; ")}. Which should be included, left for later, or dismissed?`, "Leave them for later unless directly related")
      sourceChoice += `\nFuture-work decision: ${choice}`;
    }
    if (interactive && context.existingNext.length) {
      const choice = await promptText(`Existing next tickets: ${context.existingNext.join(", ")}. Should the proposal retain or replace them?`, "Retain them unless the new work must come first")
      sourceChoice += `\nExisting-next decision: ${choice}`;
    }
    const briefRequest = sourceRequestFromAnswer(brief, projectDir);
    const choiceRequest = sourceRequestFromAnswer(sourceChoice, projectDir);
    const initialRequests = [briefRequest, choiceRequest].filter((request) => request.type && request.locator);
    let registered = await registerSourceRequests(projectDir, stagedSources, initialRequests, { storage: selectedStorage });
    stagedSources = registered.registry;
    const uncaptured = stagedSources.entries.filter((entry) => entry.active && entry.versions.length === 0).map((entry) => entry.id);
    if (uncaptured.length) {
      const refreshed = await refreshSourceRegistry(projectDir, stagedSources, uncaptured);
      stagedSources = refreshed.registry; registered.snapshots.push(...refreshed.snapshots);
    }
    const grill = argv.includes("--grill-me")
      ? "exhaustive"
      : interactive && !argv.includes("--no-grill-me") ? await promptGrill() : "standard";
    const agent = opts.agent ?? await chooseRuntime(config, interactive);
    const sessionOverrides = await chooseSessionOverrides(opts, interactive);
    const fingerprint = ticketPlanningFingerprint(projectDir);
    if (interview) interview = checkpointInterview(projectDir, interview, { checkpoint: "agent-run", answers: { ...interview.answers, sourceChoice, grill }, outputs: fingerprint });

    const role = await createRoleBuilder({
      projectDir,
      role: "planner",
      extraSkills: grill === "exhaustive" ? ["grill-me"] : [],
      agent,
      model: sessionOverrides.model,
      effort: sessionOverrides.effort,
      yes: Boolean(opts.yes),
      allowSwitch: !opts.resumeSession,
      resumeSessionId: opts.resumeSession,
      label: "rafi tickets plan",
      permissionConfig: readOnlyPermissionConfig(),
      sandboxMode: "read-only",
    });
    console.log(`rafi tickets plan: project ${String(config.appName ?? "unnamed")} at ${projectDir}`);
    console.log(`rafi tickets plan: runtime=${role.runtime} model=${role.model ?? role.roleBundle.model ?? "runtime default"} effort=${role.effort ?? "runtime default"}`);
    console.log(`rafi tickets plan: interview=${grill}; agent changes are disabled\n`);
    if (interview) interview = checkpointInterview(projectDir, interview, { runtime: { runtime: role.runtime, model: role.model, sessionId: role.builder.sessionId() } });

    let result = await role.builder.sendTurn(buildTicketPlanInstruction({ brief, sourceChoice, sources: sourceContextForTickets(projectDir, stagedSources, context), sourceSnapshots: registered.snapshots, context, grill, docsRoot }));
    while (true) {
      if (result.isError) throw new Error(`planning agent failed: ${result.text.slice(0, 300)}`);
      const marker = parseConversationMarker(result.text);
      if (marker.kind === "needs_input") {
        console.log(stripMachineTail(result.text));
        const input = await handlePlanningInput({ projectDir, output: result.text, question: marker.question, choices: marker.choices, registry: stagedSources, storage: selectedStorage, interactive, context: (registry) => sourceContextForTickets(projectDir, registry, context) });
        stagedSources = input.registry; registered.snapshots.push(...input.snapshots);
        if (input.cancelled) { await role.builder.close(); await chooseStagedSourceDisposition(projectDir, loadedSources.registry, stagedSources); console.log("rafi tickets plan: cancelled; tracker unchanged"); return; }
        result = await role.builder.sendTurn(input.continuation!);
        continue;
      }
      if (marker.kind !== "plan_complete") throw new Error("planning agent did not return proposal_ready or a valid question");
      let proposal = extractTicketPlanProposal(result.text, context.tickets);
      const issues = [...validateTicketPlanProposal(proposal, context.tickets), ...validateProposalSourceRefs(proposal, stagedSources, projectDir)];
      if (issues.length) { result = await role.builder.sendTurn(`Your proposal failed validation. Correct it without changing agreed decisions:\n${issues.join("\n")}`); continue; }
      const decision = opts.yes ? "approve" : await reviewProposal(proposal);
      if (decision === "cancel") { await role.builder.close(); await chooseStagedSourceDisposition(projectDir, loadedSources.registry, stagedSources); console.log("rafi tickets plan: cancelled; tracker unchanged"); return; }
      if (decision !== "approve") {
        const upgrade = /upgrade(?:\s+to)?\s+(?:exhaustive|grill-me)|grill-me/i.test(decision) && grill === "standard";
        result = await role.builder.sendTurn(upgrade
          ? `The user explicitly upgraded this same session to exhaustive planning. Retain the current proposal and conversation. Apply these complete grill-me instructions now:\n\n${loadSkill("grill-me").body ?? ""}\n\nUser feedback:\n${decision}`
          : decision);
        continue;
      }
      const drift = planningFingerprintChanges(projectDir, fingerprint);
      if (drift.length) { result = await role.builder.sendTurn(`The tracker/config changed during review (${drift.join(", ")}). Re-read current state, refresh the exact proposal, and request approval again.`); continue; }
      await role.builder.close();
      const applied = applyApprovedTicketPlan(projectDir, proposal, { expectedFingerprint: fingerprint, docsRoot });
      saveSourceRegistry(projectDir, stagedSources);
      if (interview) completeInterview(projectDir, interview);
      console.log(`rafi tickets plan: created ${applied.added.length}, edited ${applied.edited.length}; validation passed`);
      console.log(`rafi tickets plan: wrote ${applied.artifacts.join(" and ")}`);
      if (proposal.next.ticket_ids.length) {
        console.log(`rafi tickets plan: agreed next work ${proposal.next.ticket_ids.join(", ")} — run \`rafi start ${shellQuote(projectDir)} --steps ${proposal.next.ticket_ids.length}\``);
        if (interactive) {
          const { confirm, isCancel } = await import("@clack/prompts");
          const start = await confirm({ message: "Start the agreed next ticket or delivery group now?", initialValue: false });
          if (!isCancel(start) && start) runSelf(["start", projectDir, "--steps", String(proposal.next.ticket_ids.length)]);
        }
      }
      return;
    }
  } catch (err) {
    if (interview) failInterview(projectDir, interview, interview.checkpoint, err);
    throw err;
  }
}

async function chooseSessionOverrides(opts: TicketPlanOptions, interactive: boolean): Promise<{ model?: string; effort?: EffortLevel }> {
  if (!interactive || opts.model || opts.effort) return { model: opts.model, effort: opts.effort as EffortLevel | undefined };
  const planner = getAgent("planner");
  const { text, isCancel, log } = await import("@clack/prompts");
  log.info(`Planner defaults: model=${planner.model ?? "runtime default"}, reasoning=${planner.effort ?? "runtime default"}. Overrides affect this session only.`);
  const answer = await text({ message: "Keep defaults, or enter a session override such as `model gpt-5.5, effort high`:", initialValue: "Keep defaults", defaultValue: "Keep defaults" });
  if (isCancel(answer)) return {};
  const value = String(answer);
  const model = /\bmodel\s*[=:]?\s*([^,]+?)(?=\s+(?:effort|reasoning)\b|,|$)/i.exec(value)?.[1]?.trim();
  const effortRaw = /\b(?:effort|reasoning)\s*[=:]?\s*(low|medium|high|xhigh)\b/i.exec(value)?.[1]?.toLowerCase();
  return { model, effort: effortRaw as EffortLevel | undefined };
}

async function chooseInterview(projectDir: string, interactive: boolean, opts: TicketPlanOptions): Promise<InterviewRecord | undefined> {
  if (!interactive) return undefined;
  const unfinished = readInterviewRecords(projectDir).records.filter((record) => record.workflow === "tickets-plan" && record.status !== "completed");
  if (unfinished.length) {
    const { select, isCancel } = await import("@clack/prompts");
    const record = unfinished[0]!;
    const choice = await select({ message: `Unfinished ticket plan from ${record.updatedAt}:`, options: [
      { value: "resume", label: "Resume (Recommended)" }, { value: "new", label: "Start new" }, { value: "discard", label: "Discard saved interview" },
    ] });
    if (isCancel(choice)) return undefined;
    if (choice === "resume") { opts.resumeSession ??= record.runtime.sessionId; opts.brief ??= typeof record.answers.brief === "string" ? record.answers.brief : undefined; return record; }
    if (choice === "discard") discardInterview(projectDir, record.id);
  }
  return createInterviewRecord({ workflow: "tickets-plan", invocation: { projectDir }, checkpoint: "brief", outputs: ["rafi-config.yaml", ".tickets/tickets.yaml", ".tickets/ticket-state.sqlite", ".tickets/delivery.yaml"] });
}

function ensureTracker(projectDir: string, interactive: boolean): void {
  if (existsSync(join(projectDir, ".tickets", "config.yaml"))) return;
  if (!interactive) throw new Error("ticket tracker is missing; run `rafi tickets init` first");
  runSelf(["tickets", "init", "--project", projectDir, "--yes"]);
}

async function chooseRuntime(config: Record<string, unknown>, interactive: boolean): Promise<string | undefined> {
  const targets = ((config.harness as Record<string, unknown> | undefined)?.targets as string[] | undefined) ?? [];
  if (targets.length === 1) return targets[0];
  if (!interactive) return undefined;
  const { select, isCancel } = await import("@clack/prompts");
  const answer = await select({ message: "Both runtimes are configured. Which should plan this session?", options: [
    { value: "claude", label: "Claude (Recommended)" }, { value: "codex", label: "Codex" },
  ] });
  if (isCancel(answer)) return undefined;
  return String(answer);
}

async function promptGrill(): Promise<"standard" | "exhaustive"> {
  const { select, isCancel, log } = await import("@clack/prompts");
  log.info("Standard asks focused questions; exhaustive grill-me stress-tests assumptions and edge cases. You can upgrade later without losing the proposal.");
  const answer = await select({ message: "Interview depth:", options: [
    { value: "standard", label: "Standard (Recommended)" }, { value: "exhaustive", label: "Exhaustive grill-me" },
  ] });
  if (isCancel(answer)) return "standard";
  return answer as "standard" | "exhaustive";
}

async function reviewProposal(proposal: TicketPlanProposal): Promise<string> {
  console.log(`\n${proposal.markdown.trim()}\n`);
  console.log(`Exact proposal: +${proposal.additions.length} additions, ${proposal.edits.length} edits, ${proposal.supersessions.length} supersession set(s), next=${proposal.next.ticket_ids.join(", ") || "unchanged"}`);
  const { select, isCancel } = await import("@clack/prompts");
  const action = await select({ message: "Review this exact plan and ticket set:", options: [
    { value: "approve", label: "Approve exact set" }, { value: "discuss", label: "Continue discussing" }, { value: "cancel", label: "Cancel" },
  ] });
  if (isCancel(action) || action === "cancel") return "cancel";
  if (action === "approve") return "approve";
  return promptText("What should change? You may also say 'upgrade to grill-me':");
}

function sourceContextForTickets(projectDir: string, registry: SourceRegistryConfig, context: ReturnType<typeof readTicketPlanningContext>): Array<Record<string, unknown>> {
  const state = new Map(context.states.map((item) => [item.ticket_id, item.status]));
  const byId = new Map(context.tickets.map((ticket) => [ticket.id, ticket]));
  const unfinished = new Set(context.tickets.filter((ticket) => !["done", "canceled", "obsolete"].includes(state.get(ticket.id) ?? "planned")).map((ticket) => ticket.id));
  const visit = (id: string): void => {
    const ticket = byId.get(id); if (!ticket) return;
    for (const dependency of ticket.depends_on) if (!unfinished.has(dependency)) { unfinished.add(dependency); visit(dependency); }
  };
  for (const id of [...unfinished]) visit(id);
  const pinned = new Map<string, Set<string>>();
  const referencedByUnfinished = new Set<string>();
  const referencedOnlyByCompleted = new Set<string>();
  for (const ticket of context.tickets) for (const ref of ticket.source_refs ?? []) {
    const sourceId = ref.source_id ?? uniqueLegacySourceId(registry, ref.source);
    if (!sourceId) continue;
    if (unfinished.has(ticket.id)) {
      referencedByUnfinished.add(sourceId);
      if (ref.fingerprint) { const set = pinned.get(sourceId) ?? new Set<string>(); set.add(ref.fingerprint); pinned.set(sourceId, set); }
    } else referencedOnlyByCompleted.add(sourceId);
  }
  const metadataOnly = new Set([...referencedOnlyByCompleted].filter((id) => !referencedByUnfinished.has(id)));
  for (const [sourceId, fingerprints] of pinned) for (const fingerprint of fingerprints) {
    const issue = validateSourceVersionRef(registry, { source_id: sourceId, fingerprint }, projectDir);
    if (issue) throw new Error(issue);
  }
  return sourceContext(registry, { pinned, metadataOnly });
}

function uniqueLegacySourceId(registry: SourceRegistryConfig, value: string): string | undefined {
  const matches = registry.entries.filter((entry) => entry.id === value || entry.label === value || entry.type === value);
  return matches.length === 1 ? matches[0]!.id : undefined;
}

function validateProposalSourceRefs(proposal: TicketPlanProposal, registry: SourceRegistryConfig, projectDir: string): string[] {
  const refs = [
    ...proposal.additions.flatMap((ticket) => ticket.source_refs ?? []),
    ...proposal.edits.flatMap((edit) => edit.patch.source_refs ?? []),
  ];
  return refs.flatMap((ref) => {
    if (!ref.source_id) return [];
    if (!ref.fingerprint) return [`source reference ${ref.source_id} must pin an immutable fingerprint`];
    const issue = validateSourceVersionRef(registry, { source_id: ref.source_id, fingerprint: ref.fingerprint }, projectDir);
    return issue ? [issue] : [];
  });
}


function parseConversationMarker(text: string): { kind: string; question?: string; choices?: string[] } {
  const line = text.trimEnd().split(/\r?\n/).at(-1) ?? "";
  const kind = /STEP_STATUS:\s*([a-z_]+)/i.exec(line)?.[1]?.toLowerCase() ?? "unknown";
  const question = /question="([^"]*)"/.exec(line)?.[1];
  const choices = /choices="([^"]*)"/.exec(line)?.[1]?.split("|").map((item) => item.trim());
  return { kind, question, choices };
}

function stripMachineTail(text: string): string { return text.replace(/^SOURCE_REQUEST:.*$/gmi, "").replace(/^STEP_STATUS:.*$/gmi, "").trim(); }
function sourceLabel(source: ProjectSourceEntry): string { return `${source.label} (${source.id})`; }
function readProjectConfig(projectDir: string): Record<string, unknown> { const active = join(projectDir, RAFI_CONFIG_FILE); const path = existsSync(active) ? active : join(projectDir, "project.yaml"); return parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>; }
async function promptText(message: string, initialValue?: string): Promise<string> { const { text, isCancel } = await import("@clack/prompts"); const answer = await text({ message, initialValue, defaultValue: initialValue, validate: (value) => String(value ?? "").trim() ? undefined : "Enter a response" }); if (isCancel(answer)) throw new Error("ticket planning cancelled"); return String(answer).trim(); }
function runSelf(args: string[]): void { const extension = fileURLToPath(import.meta.url).endsWith(".ts") ? "ts" : "js"; const result = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(new URL(`./index.${extension}`, import.meta.url)), ...args], { stdio: "inherit" }); if (result.error) throw result.error; if (result.status !== 0) throw new Error(`rafi ${args[0]} exited with status ${result.status}`); }
function shellQuote(value: string): string { return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`; }
