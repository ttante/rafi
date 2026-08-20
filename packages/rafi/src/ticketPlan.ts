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
import {
  dedupeTicketSources,
  loadTicketSetupConfigWithDefaults,
  saveTicketSetupConfig,
  type TicketSourceConfig,
} from "ai-foreman/tickets/setup-config.js";
import { fetchAndSnapshotUrl, snapshotExternalLocalFile } from "ai-foreman/tickets/source-fetch.js";
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
  sources: TicketSourceConfig[];
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
- If more source content is needed, emit a line \`SOURCE_REQUEST: <public-url-or-local-path>\` and then ask a needs_input question.
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
    .option("--grill-me", "start in exhaustive one-question-at-a-time mode")
    .option("--no-grill-me", "start in standard focused mode (default)")
    .option("-y, --yes", "non-interactive mode; requires --brief and approves a valid proposal")
    .action(async (opts, command: Command) => {
      const parent = command.parent as (Command & { rawArgs?: string[] }) | null;
      return runTicketPlan(opts, parent?.rawArgs ?? (command as Command & { rawArgs?: string[] }).rawArgs);
    });
}

interface TicketPlanOptions { project?: string; brief?: string; agent?: string; model?: string; effort?: string; resumeSession?: string; yes?: boolean; grillMe?: boolean; }

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

    const setup = loadTicketSetupConfigWithDefaults(projectDir);
    let sourceChoice = interactive
      ? await promptText(`Remembered sources: ${setup.sources.length ? setup.sources.map(sourceLabel).join(", ") : "none"}. Which should this session use?`, setup.sources.length ? "Use all relevant remembered sources" : "Use sources from my description and repository")
      : "Use all relevant remembered sources";
    const openFuture = context.futureWork.filter((item) => item.disposition === "triage");
    if (interactive && openFuture.length) {
      const choice = await promptText(`Future-work ideas: ${openFuture.map((item) => `${item.id}: ${item.summary}`).join("; ")}. Which should be included, left for later, or dismissed?`, "Leave them for later unless directly related")
      sourceChoice += `\nFuture-work decision: ${choice}`;
    }
    if (interactive && context.existingNext.length) {
      const choice = await promptText(`Existing next tickets: ${context.existingNext.join(", ")}. Should the proposal retain or replace them?`, "Retain them unless the new work must come first")
      sourceChoice += `\nExisting-next decision: ${choice}`;
    }
    const refreshed = await refreshRememberedSources(projectDir, setup.sources);
    const registered = await registerSourcesFromText(projectDir, brief, refreshed.sources);
    registered.snapshots.unshift(...refreshed.snapshots);
    if (registered.sources.length !== setup.sources.length) saveTicketSetupConfig(projectDir, { ...setup, sources: registered.sources });
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

    let result = await role.builder.sendTurn(buildTicketPlanInstruction({ brief, sourceChoice, sources: registered.sources, sourceSnapshots: registered.snapshots, context, grill, docsRoot }));
    while (true) {
      if (result.isError) throw new Error(`planning agent failed: ${result.text.slice(0, 300)}`);
      const marker = parseConversationMarker(result.text);
      if (marker.kind === "needs_input") {
        console.log(stripMachineTail(result.text));
        const newSources = await registerRequestedSources(projectDir, result.text, registered.sources);
        registered.sources = newSources.sources;
        registered.snapshots.push(...newSources.snapshots);
        if (newSources.snapshots.length) result = await role.builder.sendTurn(`Validated and registered these source snapshots: ${newSources.snapshots.join(", ")}. Continue without editing files.`);
        else result = await role.builder.sendTurn(await promptText(marker.question ?? "Planner question", marker.choices?.[0]));
        continue;
      }
      if (marker.kind !== "plan_complete") throw new Error("planning agent did not return proposal_ready or a valid question");
      let proposal = extractTicketPlanProposal(result.text, context.tickets);
      const issues = validateTicketPlanProposal(proposal, context.tickets);
      if (issues.length) { result = await role.builder.sendTurn(`Your proposal failed validation. Correct it without changing agreed decisions:\n${issues.join("\n")}`); continue; }
      const decision = opts.yes ? "approve" : await reviewProposal(proposal);
      if (decision === "cancel") { await role.builder.close(); console.log("rafi tickets plan: cancelled; tracker unchanged"); return; }
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

async function registerSourcesFromText(projectDir: string, text: string, existing: TicketSourceConfig[]): Promise<{ sources: TicketSourceConfig[]; snapshots: string[] }> {
  const sources = [...existing]; const snapshots: string[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"')]+/gi)) {
    const fetched = await fetchAndSnapshotUrl(projectDir, match[0]); snapshots.push(fetched.snapshotPath); sources.push({ type: "url", url: fetched.requestedUrl });
  }
  for (const token of text.match(/(?:\.{0,2}\/|\/)[^\s,;]+/g) ?? []) {
    const path = resolve(projectDir, token);
    if (existsSync(path)) { const snapshot = snapshotExternalLocalFile(projectDir, path); snapshots.push(snapshot); sources.push({ type: "local", paths: [snapshot] }); }
  }
  return { sources: dedupeTicketSources(sources), snapshots };
}

async function refreshRememberedSources(projectDir: string, existing: TicketSourceConfig[]): Promise<{ sources: TicketSourceConfig[]; snapshots: string[] }> {
  const sources: TicketSourceConfig[] = [];
  const snapshots: string[] = [];
  for (const source of existing) {
    if (source.type === "url") {
      const fetched = await fetchAndSnapshotUrl(projectDir, source.url);
      snapshots.push(fetched.snapshotPath);
      sources.push({ type: "url", url: fetched.requestedUrl });
    } else if (source.type === "local") {
      const paths: string[] = [];
      for (const path of source.paths) {
        const absolute = resolve(projectDir, path);
        if (existsSync(absolute)) {
          const snapshot = snapshotExternalLocalFile(projectDir, absolute);
          paths.push(snapshot);
          if (snapshot.startsWith(".tickets/imports/")) snapshots.push(snapshot);
        } else paths.push(path);
      }
      sources.push({ type: "local", paths });
    } else sources.push(source);
  }
  return { sources: dedupeTicketSources(sources), snapshots };
}

async function registerRequestedSources(projectDir: string, output: string, existing: TicketSourceConfig[]): Promise<{ sources: TicketSourceConfig[]; snapshots: string[] }> {
  const requests = [...output.matchAll(/^SOURCE_REQUEST:\s*(.+)$/gmi)].map((match) => match[1]!.trim());
  if (!requests.length) return { sources: existing, snapshots: [] };
  const registered = await registerSourcesFromText(projectDir, requests.join(" "), existing);
  for (const request of requests) {
    if (/^https?:\/\//i.test(request)) continue;
    const path = resolve(projectDir, request);
    if (existsSync(path) && !registered.snapshots.includes(request)) {
      const snapshot = snapshotExternalLocalFile(projectDir, path);
      registered.snapshots.push(snapshot);
      registered.sources.push({ type: "local", paths: [snapshot] });
    }
  }
  registered.sources = dedupeTicketSources(registered.sources);
  const setup = loadTicketSetupConfigWithDefaults(projectDir);
  saveTicketSetupConfig(projectDir, { ...setup, sources: registered.sources });
  return registered;
}

function parseConversationMarker(text: string): { kind: string; question?: string; choices?: string[] } {
  const line = text.trimEnd().split(/\r?\n/).at(-1) ?? "";
  const kind = /STEP_STATUS:\s*([a-z_]+)/i.exec(line)?.[1]?.toLowerCase() ?? "unknown";
  const question = /question="([^"]*)"/.exec(line)?.[1];
  const choices = /choices="([^"]*)"/.exec(line)?.[1]?.split("|").map((item) => item.trim());
  return { kind, question, choices };
}

function stripMachineTail(text: string): string { return text.replace(/^SOURCE_REQUEST:.*$/gmi, "").replace(/^STEP_STATUS:.*$/gmi, "").trim(); }
function sourceLabel(source: TicketSourceConfig): string { return source.type === "local" ? `local:${source.paths.join(",")}` : source.type === "url" ? source.url : source.type; }
function readProjectConfig(projectDir: string): Record<string, unknown> { const active = join(projectDir, RAFI_CONFIG_FILE); const path = existsSync(active) ? active : join(projectDir, "project.yaml"); return parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>; }
async function promptText(message: string, initialValue?: string): Promise<string> { const { text, isCancel } = await import("@clack/prompts"); const answer = await text({ message, initialValue, defaultValue: initialValue, validate: (value) => String(value ?? "").trim() ? undefined : "Enter a response" }); if (isCancel(answer)) throw new Error("ticket planning cancelled"); return String(answer).trim(); }
function runSelf(args: string[]): void { const extension = fileURLToPath(import.meta.url).endsWith(".ts") ? "ts" : "js"; const result = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(new URL(`./index.${extension}`, import.meta.url)), ...args], { stdio: "inherit" }); if (result.error) throw result.error; if (result.status !== 0) throw new Error(`rafi ${args[0]} exited with status ${result.status}`); }
function shellQuote(value: string): string { return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`; }
