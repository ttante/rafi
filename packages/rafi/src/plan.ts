import { Command } from "commander";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  assertEffortLevel,
  makeLogPath,
  readOnlyPermissionConfig,
  runRoleInstruction,
  type EffortLevel,
  type RoleInstructionRunOptions,
} from "ai-foreman/agent-run.js";
import { validateDocsRoot } from "./docs.js";
import { DEFAULT_DOCS_ROOT, LEGACY_PROJECT_CONFIG_FILE, RAFI_CONFIG_FILE } from "./project.js";
import { normalizePlanningSources } from "./project.js";
import { assertLifecycleForCommand } from "./lifecycle.js";
import type { PlanningMode } from "rafi-spec";
import type { StructuredPlanV1 } from "rafi-spec";
import {
  checkpointInterview,
  completeInterview,
  createInterviewRecord,
  failInterview,
  fingerprintOutputs,
  outputsChanged,
  type InterviewRecord,
} from "ai-foreman/interviews.js";
import { WorkflowDb, type ProjectLease } from "ai-foreman/workflow-db.js";
import {
  extractStructuredPlanProposal,
  materializeStructuredPlan,
  readAndValidateStructuredPlanPair,
  readNamedApprovedPlan,
  regenerateStructuredPlanMarkdown,
  renderStructuredPlanMarkdown,
  writeStructuredPlanArtifacts,
  PLAN_PROPOSAL_END,
  PLAN_PROPOSAL_START,
} from "./structuredPlan.js";

export const REQUIRED_PLAN_SECTIONS = [
  "Goal",
  "Problem Statement",
  "Repo Findings",
  "Locked Decisions",
  "Open Questions",
  "Scope",
  "Out Of Scope",
  "Risks",
  "Rollback Notes",
  "Ticket-Maker Guidance",
] as const;

const TICKET_GUIDANCE_REQUIREMENTS = [
  { label: "ticket slices", pattern: /\b(ticket\s+)?slices?\b|\bproposed tickets?\b/i },
  { label: "dependencies", pattern: /\bdependenc(?:y|ies)\b|\bdepends?(?:\s+on)?\b|\bdependency\s+graph\b|\bdepends_on\b/i },
  { label: "acceptance criteria", pattern: /\bacceptance(?:\s+criteria)?\b/i },
  { label: "required tests", pattern: /\b(?:required\s+)?tests?\b|\btests?\s+required\b/i },
  { label: "likely files", pattern: /\b(?:likely\s+)?files?\b/i },
  { label: "branch/batch strategy", pattern: /(?=[\s\S]*\bbranch\b)(?=[\s\S]*\bbatch\b)(?=[\s\S]*\bstrategy\b)[\s\S]*/i },
] as const;

export interface PlanInstructionOptions {
  brief: string;
  sources?: string[];
  docsRoot: string;
  latestPlanPath: string;
  historyDirPath: string;
  ticketSetupSummary?: string;
  planningMode?: PlanningMode;
}

export interface PlanArtifactPaths {
  docsRoot: string;
  historyRel: string;
  latestRel: string;
  historyAbs: string;
  latestAbs: string;
}

export function buildPlanInstruction(opts: PlanInstructionOptions): string {
  const sources = opts.sources?.length
    ? opts.sources.map((source) => `- ${source}`).join("\n")
    : "- No explicit sources were provided. Inspect the repository for relevant docs, tickets, code, configs, tests, and recent plans.";

  const mode = opts.planningMode ?? "standard";
  const conversation = mode === "exhaustive"
    ? `- Use the complete grill-me skill instructions in this same session. Explore material decision branches one question at a time. Each question must present a recommended choice, meaningful alternatives, a free-text path, and "Stop questions and make the plan now".\n- Zero questions are valid only if the final assessment supplies evidence that every material branch is resolved or inapplicable.`
    : "- Use a standard focused planning conversation. Do not invoke, advertise, or claim use of grill-me.";

  return `You are being run by Rafi to create a ticket-maker-ready implementation plan.

User brief:
${opts.brief.trim()}

Configured Rafi docs root:
${opts.docsRoot}

Planning source hints:
${sources}

Saved ticket setup preferences:
${opts.ticketSetupSummary ?? "- No saved ticket setup preferences found."}

Role and skill requirements:
- Use the planner role guidance for baseline planning.
${conversation}
- If a question can be answered by inspecting the repository, inspect the repository instead of asking the user.
- Use prd-to-issues only as vertical-slice planning guidance. Do not create issues/*.md or any other issue files.

Delivery planning:
- Infer delivery facts from the repository, brief, or saved setup before asking.
- When material, ask one focused question at a time with a recommended answer covering unit membership, branch mode, completion, dependencies, provider, readiness, merge method, cleanup, and exact PR targets.
- Support multiple delivery groups and straight cross-group stacks. Current-branch units cannot be stacked. Stacked units use completion=pr with GitHub or GitLab, no auto/direct merge, and at most five ordered PR nodes.

Permissions and file rules:
- This is a non-mutating planning run. Read, search, inspect, and ask questions as needed.
- Do not edit source files, docs, .tickets, generated artifacts, or configuration.
- Return a structured proposal only. Rafi assigns plan, slice, and stack identities and deterministically renders Markdown at ${opts.latestPlanPath} with immutable paired history under ${opts.historyDirPath}.

Inspect the repository enough to make the plan concrete. Prefer facts from files over assumptions. If a decision is genuinely blocked, ask one focused question with:
STEP_STATUS: needs_input | question="..." choices="recommended option|alternative"

Output contract:
- Cover the planning concepts Goal, Problem Statement, Repo Findings, Locked Decisions, Open Questions, Scope, Out Of Scope, Risks, Rollback Notes, and Ticket-Maker Guidance in the corresponding structured fields. Include a branch/batch strategy for repeated component-library work when relevant.
- Return exactly one JSON object between ${PLAN_PROPOSAL_START} and ${PLAN_PROPOSAL_END}.
- Shape: {"version":1,"summary":"...","assumptions":["..."],"implementation_changes":["..."],"acceptance_criteria":["..."],"test_plan":["..."],"slices":[{"local_ref":"S1","retains":"optional existing slice_ref only when revising","title":"...","summary":"...","acceptance":["..."],"required_tests":["..."],"likely_files":["..."],"depends_on":["local_ref"]}],"delivery_units":[{"id":"unit-name","slice_refs":["local_ref"],"branch_mode":"current|per-ticket|shared","completion":"pr|auto-merge|direct-merge|none","provider":"auto|github|gitlab|local","pr_ready":false,"merge_method":"squash|merge|rebase","cleanup":false,"depends_on":["unit-id"],"dependency_mode":"combine|wait|stack"}],"stacks":[{"local_ref":"STACK1","retains":"optional existing stack_id only when revising","name":"...","units":["root-unit","child-unit"]}]}.
- Local refs exist only inside the proposal. Never invent plan_id, slice_ref, stack_id, revision, or digest values.
- Every slice maps to exactly one delivery unit. Use independent non-stacked units when delivery grouping is not otherwise material.
- Make each slice small enough for \`rafi start --steps ...\` or branch-per-ticket execution. Do not include patches or Markdown.

End with exactly one marker line as the final non-empty line:
STEP_STATUS: plan_complete | summary="created ticket-maker-ready Rafi plan"`;
}

export function buildPlanAgentRunOptions(opts: {
  projectDir: string;
  agent?: string;
  model?: string;
  effort?: EffortLevel;
  fast?: boolean;
  yes?: boolean;
  resumeSessionId?: string;
  instruction: string;
  logPath?: string;
  planningMode?: PlanningMode;
}): RoleInstructionRunOptions {
  return {
    projectDir: opts.projectDir,
    role: "planner",
    extraSkills: opts.planningMode === "exhaustive" ? ["grill-me"] : [],
    agent: opts.agent,
    model: opts.model,
    effort: opts.effort,
    fast: opts.fast,
    yes: opts.yes,
    resumeSessionId: opts.resumeSessionId,
    label: "rafi plan",
    logPath: opts.logPath,
    instruction: opts.instruction,
    permissionConfig: readOnlyPermissionConfig(),
    sandboxMode: "read-only",
    logEvent: "rafi-plan",
  };
}

export function resolvePlanDocsRoot(projectDir: string): string {
  return validateDocsRoot(projectDir, readConfiguredDocsRoot(projectDir) ?? DEFAULT_DOCS_ROOT);
}

/** Explicit command sources win; otherwise continue the source choices from `rafi create`. */
export function resolvePlanSources(projectDir: string, explicitSources?: string[]): string[] | undefined {
  if (explicitSources && explicitSources.length > 0) return explicitSources;
  for (const file of [RAFI_CONFIG_FILE, LEGACY_PROJECT_CONFIG_FILE]) {
    const path = join(projectDir, file);
    if (!existsSync(path)) continue;
    const raw = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown> | undefined;
    const planning = raw?.planning as Record<string, unknown> | undefined;
    const sources = normalizePlanningSources(planning?.sources);
    if (sources.length > 0) return sources;
  }
  return undefined;
}

export function resolvePlanArtifactPaths(
  projectDir: string,
  docsRoot: string,
  now = new Date(),
): PlanArtifactPaths {
  const safeDocsRoot = validateDocsRoot(projectDir, docsRoot);
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const historyRel = `${safeDocsRoot}/rafi-plans/${stamp}.md`;
  const latestRel = `${safeDocsRoot}/rafi-plan.md`;
  const historyAbs = resolve(projectDir, historyRel);
  const latestAbs = resolve(projectDir, latestRel);
  assertOutputPathInsideRepo(projectDir, historyAbs, historyRel);
  assertOutputPathInsideRepo(projectDir, latestAbs, latestRel);
  return { docsRoot: safeDocsRoot, historyRel, latestRel, historyAbs, latestAbs };
}

export function writePlanArtifacts(
  projectDir: string,
  docsRoot: string,
  planMarkdown: string,
  now = new Date(),
): PlanArtifactPaths {
  const paths = resolvePlanArtifactPaths(projectDir, docsRoot, now);
  const content = normalizePlanMarkdown(planMarkdown);
  mkdirSync(dirname(paths.historyAbs), { recursive: true });
  assertOutputPathInsideRepo(projectDir, paths.historyAbs, paths.historyRel);
  assertOutputPathInsideRepo(projectDir, paths.latestAbs, paths.latestRel);
  writeFileSync(paths.historyAbs, content, "utf8");
  writeFileSync(paths.latestAbs, content, "utf8");
  return paths;
}

export function writeValidatedPlanArtifacts(
  projectDir: string,
  docsRoot: string,
  planMarkdown: string,
  now = new Date(),
  planningMode: PlanningMode = "standard",
): PlanArtifactPaths {
  const missing = validatePlanMarkdown(planMarkdown, planningMode);
  if (missing.length > 0) {
    throw new Error(formatPlanValidationFailures(missing));
  }
  return writePlanArtifacts(projectDir, docsRoot, planMarkdown, now);
}

export function isSuccessfulPlanStatus(kind: string): boolean {
  return kind === "plan_complete";
}

export function validatePlanMarkdown(planMarkdown: string, planningMode: PlanningMode = "standard"): string[] {
  const missing: string[] = [];
  const markdown = stripFinalStepStatusMarker(planMarkdown);

  for (const section of REQUIRED_PLAN_SECTIONS) {
    if (!findSection(markdown, section)) missing.push(`section: ${section}`);
  }

  const guidance = findSection(markdown, "Ticket-Maker Guidance");
  if (guidance) {
    for (const requirement of TICKET_GUIDANCE_REQUIREMENTS) {
      if (!requirement.pattern.test(guidance.content)) {
        missing.push(`Ticket-Maker Guidance: ${requirement.label}`);
      }
    }
  }

  if (planningMode === "exhaustive") {
    const assessment = findSection(markdown, "Planning Assessment");
    if (!assessment) missing.push("section: Planning Assessment");
    else {
      for (const area of ["scope", "dependencies", "failure/edge cases", "compatibility/rollout", "verification"]) {
        if (!assessment.content.toLowerCase().includes(area)) missing.push(`Planning Assessment: ${area}`);
      }
      for (const field of ["finding", "basis", "resolution", "user judgment"]) {
        if (!assessment.content.toLowerCase().includes(field)) missing.push(`Planning Assessment field: ${field}`);
      }
    }
  }

  return missing;
}

export function formatPlanValidationFailures(missing: string[]): string {
  return `planner returned an incomplete plan:\n${missing.map((item) => `- missing ${item}`).join("\n")}`;
}

export function stripFinalStepStatusMarker(text: string): string {
  const lines = text.trimEnd().split(/\r?\n/);
  if (/^STEP_STATUS:/i.test(lines[lines.length - 1] ?? "")) {
    lines.pop();
  }
  return lines.join("\n").trimEnd();
}

export function nextPopulateCommand(projectDir: string, latestRel: string): string {
  const projectArg = resolve(projectDir) === process.cwd()
    ? ""
    : ` --project ${shellQuote(projectDir)}`;
  return `rafi tickets populate${projectArg} --sources ${shellQuote(latestRel)}`;
}

export function buildPlanCommand(): Command {
  return new Command("plan")
    .description("Create a ticket-maker-ready implementation plan from a brief and repo inspection.")
    .argument("[project]", "path to the target repo", ".")
    .option("--brief <text>", "planning brief")
    .option("--brief-file <path>", "file containing the planning brief")
    .option("--sources <paths...>", "source hint files, folders, or globs to check first")
    .option("-a, --agent <agent>", "planning agent (claude | codex)")
    .option("-m, --model <model>", "override the planning agent's model")
    .option("--effort <level>", "reasoning effort level (low|medium|high|xhigh)")
    .option("--fast", "fast mode - lower latency")
    .option("--resume-session <id>", "resume a saved planner agent session")
    .option("--revise [plan-id]", "revise the latest or named approved plan lineage")
    .option("--validate", "validate the latest Markdown/structured plan pair without running an agent")
    .option("--render", "regenerate latest Markdown from validated structured data")
    .option("--grill-me", "use exhaustive one-question-at-a-time planning")
    .option("--no-grill-me", "use standard focused planning (default)")
    .option("-y, --yes", "skip confirmation prompt before running the planning agent")
    .action(async (project: string, opts, command: Command) => {
      const projectDir = resolve(project);
      assertLifecycleForCommand(projectDir, "plan");
      const parent = command.parent as (Command & { rawArgs?: string[] }) | null;
      const argv = parent?.rawArgs ?? (command as Command & { rawArgs?: string[] }).rawArgs ?? process.argv.slice(2);
      if (argv.includes("--grill-me") && argv.includes("--no-grill-me")) throw new Error("choose either --grill-me or --no-grill-me, not both");
      const interactiveInterview = !opts.yes && process.stdin.isTTY && process.stdout.isTTY;
      let planningMode: PlanningMode = opts.grillMe === true ? "exhaustive" : "standard";
      if (interactiveInterview && !argv.includes("--grill-me") && !argv.includes("--no-grill-me")) {
        const { select, isCancel } = await import("@clack/prompts");
        const selected = await select({ message: "Planning depth (exhaustive may take substantially longer):", options: [
          { value: "standard", label: "Standard (Recommended)" },
          { value: "exhaustive", label: "Exhaustive grill-me" },
        ] });
        if (isCancel(selected)) return;
        planningMode = selected as PlanningMode;
      }
      let interview: InterviewRecord | undefined = interactiveInterview
        ? createInterviewRecord({
          workflow: "plan",
          invocation: { projectDir, agent: opts.agent, model: opts.model, effort: opts.effort, fast: Boolean(opts.fast) },
          checkpoint: "planning-brief",
          outputs: ["docs/rafi-plan.md"],
          planningMode,
        })
        : undefined;
      let workflow: WorkflowDb | undefined;
      let workflowRunId: string | undefined;
      let workflowLease: ProjectLease | undefined;
      try {
        if (interview) interview = checkpointInterview(projectDir, interview, { checkpoint: "planning-brief" });
        if (!existsSync(projectDir)) fail(`project directory not found: ${projectDir}`);
        assertEffortLevel(opts.effort as string | undefined);

        const docsRoot = resolvePlanDocsRoot(projectDir);
        const previewPaths = resolvePlanArtifactPaths(projectDir, docsRoot);
        const latestMarkdown = resolve(projectDir, docsRoot, "rafi-plan.md");
        const latestData = resolve(projectDir, docsRoot, "rafi-plan.json");
        if (opts.validate) {
          const plan = readAndValidateStructuredPlanPair(latestMarkdown, latestData);
          console.log(`rafi plan: valid ${plan.plan_id} revision ${plan.revision} (${plan.content_digest})`);
          return;
        }
        if (opts.render) {
          const plan = regenerateStructuredPlanMarkdown(latestMarkdown, latestData);
          console.log(`rafi plan: regenerated Markdown for ${plan.plan_id} revision ${plan.revision}`);
          return;
        }
        let previous: StructuredPlanV1 | undefined;
        if (opts.revise !== undefined) {
          previous = typeof opts.revise === "string"
            ? readNamedApprovedPlan(projectDir, docsRoot, opts.revise)
            : readAndValidateStructuredPlanPair(latestMarkdown, latestData);
        }
        if (interview) interview = checkpointInterview(projectDir, interview, {
          checkpoint: "planning-brief",
          outputs: fingerprintOutputs(projectDir, [previewPaths.latestRel, `${docsRoot}/rafi-plan.json`]),
        });
        const brief = await resolveBrief(opts);
        if (interview) interview = checkpointInterview(projectDir, interview, {
          checkpoint: "confirm-agent-run",
          answers: { ...interview.answers, brief },
        });
        const instruction = buildPlanInstruction({
          brief,
          sources: resolvePlanSources(projectDir, opts.sources as string[] | undefined),
          docsRoot,
          latestPlanPath: previewPaths.latestRel,
          historyDirPath: `${docsRoot}/rafi-plans`,
          ticketSetupSummary: readTicketSetupSummary(projectDir),
          planningMode,
        });

        if (!opts.yes) {
          const { select, isCancel } = await import("@clack/prompts");
          const action = await select({
            message: "Run a read-only planning agent and write Rafi plan docs?",
            options: [
              { value: "proceed", label: "Proceed - read-only agent run, then write plan docs" },
              { value: "cancel", label: "Cancel" },
            ],
          });
          if (isCancel(action) || action === "cancel") {
            console.log("rafi plan: cancelled");
            process.exit(0);
          }
        }

        const logPath = makeLogPath(projectDir, "rafi-plan");
        workflow = new WorkflowDb(projectDir);
        const workflowRun = workflow.createRun({ kind: "plan", checkpoint: "planner-session-before", originalWork: { brief, planningMode, revise: previous?.plan_id }, remainingWork: { approval: true }, state: {} });
        workflowRunId = workflowRun.runId; workflowLease = workflow.acquireLease(workflowRunId);
        if (interview) interview = checkpointInterview(projectDir, interview, { checkpoint: "agent-run" });
        console.log("rafi plan: running read-only planner");
        console.log(`rafi plan: project ${projectDir}`);
        console.log(`rafi plan: role planner; mode ${planningMode}`);
        console.log(`rafi plan: log ${logPath}\n`);

        let nextInstruction = instruction;
        let resumeSessionId = opts.resumeSession as string | undefined;
        let run: Awaited<ReturnType<typeof runRoleInstruction>>;
        let plan: StructuredPlanV1;
        while (true) {
          run = await runRoleInstruction(buildPlanAgentRunOptions({
            projectDir, agent: opts.agent as string | undefined, model: opts.model as string | undefined,
            effort: opts.effort as EffortLevel | undefined, fast: opts.fast as boolean | undefined,
            yes: Boolean(opts.yes), resumeSessionId, instruction: nextInstruction, logPath, planningMode,
          }));
          workflow.transition(workflowRunId, { checkpoint: "planner-session-after", state: { sessionId: run.sessionId, runtime: run.runtime, model: run.model }, event: "planner_session" });
          const turn = run.turn;
          if (turn.result.isError) fail(`planner turn errored: ${turn.result.text.slice(0, 200)}`);
          if (turn.status.kind === "blocked") { console.error(`rafi plan: blocked - ${turn.status.reason ?? "planner reported blocked"}`); process.exit(2); }
          if (!isSuccessfulPlanStatus(turn.status.kind)) { console.error(`rafi plan: needs human - ${turn.status.error ?? "planner did not emit plan_complete"}`); process.exit(2); }
          plan = materializeStructuredPlan(extractStructuredPlanProposal(turn.result.text), previous);
          if (opts.yes) break;
          console.log(`\n${renderStructuredPlanMarkdown(plan)}`);
          const { select, text, isCancel } = await import("@clack/prompts");
          const decision = await select({ message: "Approve this structured plan?", options: [
            { value: "approve", label: "Approve and publish (Recommended)" },
            { value: "discuss", label: "Discuss and revise" },
            { value: "cancel", label: "Cancel without changes" },
          ] });
          if (isCancel(decision) || decision === "cancel") { workflow.transition(workflowRunId, { status: "cancelled", checkpoint: "approval-cancelled", remainingWork: {} }); if (workflowLease) workflow.releaseLease(workflowLease); workflow.close(); workflow = undefined; console.log("rafi plan: cancelled; no plan or settings were changed"); return; }
          if (decision === "approve") break;
          const feedback = await text({ message: "What should the Planner revise?" });
          if (isCancel(feedback)) { workflow.transition(workflowRunId, { status: "cancelled", checkpoint: "approval-cancelled", remainingWork: {} }); if (workflowLease) workflow.releaseLease(workflowLease); workflow.close(); workflow = undefined; console.log("rafi plan: cancelled; no plan or settings were changed"); return; }
          resumeSessionId = run.sessionId;
          nextInstruction = `Revise the proposal using this user feedback: ${String(feedback)}\nReturn the complete replacement proposal using the exact ${PLAN_PROPOSAL_START}/${PLAN_PROPOSAL_END} and STEP_STATUS contract. This is the same planning work session.`;
        }
        if (interview) {
          const drifted = outputsChanged(projectDir, interview.outputs);
          if (drifted.length > 0) {
            interview = checkpointInterview(projectDir, interview, { status: "needs_review", checkpoint: "review-output-drift" });
            throw new Error(`planned output changed during this interview: ${drifted.join(", ")}; review it and retry instead of overwriting`);
          }
        }
        const written = writeStructuredPlanArtifacts(projectDir, docsRoot, plan);
        workflow.transition(workflowRunId, { status: "completed", checkpoint: "plan-pair-published", remainingWork: {}, state: { planId: plan.plan_id, revision: plan.revision, digest: plan.content_digest } });
        if (workflowLease) workflow.releaseLease(workflowLease); workflow.close(); workflow = undefined;
        if (interview) {
          interview = checkpointInterview(projectDir, interview, {
            checkpoint: "write-plan-artifacts",
            runtime: {
              runtime: run.runtime,
              model: run.model,
              sessionId: run.sessionId,
            },
          });
          completeInterview(projectDir, interview);
        }

        console.log(`\nrafi plan: wrote ${relative(projectDir, written.historyMarkdown)} and ${relative(projectDir, written.historyData)}`);
        console.log(`rafi plan: refreshed ${relative(projectDir, written.latestMarkdown)} and ${relative(projectDir, written.latestData)}`);
        console.log("rafi plan: next:");
        console.log(`  ${nextPopulateCommand(projectDir, relative(projectDir, written.latestData))}`);
      } catch (err) {
        if (workflow && workflowRunId) {
          try { workflow.transition(workflowRunId, { status: "failed", checkpoint: "plan-failed", remainingWork: {}, state: { error: err instanceof Error ? err.message.slice(0, 1000) : String(err).slice(0, 1000) } }); if (workflowLease) workflow.releaseLease(workflowLease); } finally { workflow.close(); workflow = undefined; }
        }
        if (interview) failInterview(projectDir, interview, interview.checkpoint, err);
        fail(err instanceof Error ? err.message : String(err));
      }
    });
}

function normalizePlanMarkdown(planMarkdown: string): string {
  return `${stripFinalStepStatusMarker(planMarkdown).trimEnd()}\n`;
}

export async function resolveBrief(opts: { brief?: string; briefFile?: string }): Promise<string> {
  if (opts.brief !== undefined && opts.briefFile !== undefined) {
    throw new Error("choose either --brief or --brief-file, not both");
  }
  if (opts.brief !== undefined) {
    const brief = opts.brief.trim();
    if (!brief) throw new Error("--brief must not be empty");
    return brief;
  }
  if (opts.briefFile !== undefined) {
    const path = resolve(opts.briefFile);
    if (!existsSync(path)) throw new Error(`brief file not found: ${path}`);
    const brief = readFileSync(path, "utf8").trim();
    if (!brief) throw new Error(`brief file is empty: ${path}`);
    return brief;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("provide --brief <text> or --brief-file <path>");
  }
  const { text, isCancel } = await import("@clack/prompts");
  const answer = await text({
    message: "Planning brief:",
    validate: (value) => (String(value ?? "").trim() ? undefined : "Please enter a brief"),
  });
  if (isCancel(answer)) process.exit(0);
  return String(answer).trim();
}

function readConfiguredDocsRoot(projectDir: string): string | undefined {
  for (const file of [RAFI_CONFIG_FILE, LEGACY_PROJECT_CONFIG_FILE]) {
    const path = join(projectDir, file);
    if (!existsSync(path)) continue;
    const raw = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown> | undefined;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${file}: expected a YAML object`);
    }
    const docs = raw.docs as Record<string, unknown> | undefined;
    if (typeof docs?.root === "string") return docs.root;
  }
  return undefined;
}

function readTicketSetupSummary(projectDir: string): string | undefined {
  const path = join(projectDir, RAFI_CONFIG_FILE);
  if (!existsSync(path)) return undefined;
  const raw = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.tickets === undefined) return undefined;
  const tickets = raw.tickets as Record<string, unknown>;
  const lines: string[] = [];
  if (Array.isArray(tickets.sources)) {
    lines.push("- Sources:");
    for (const source of tickets.sources) {
      if (!source || typeof source !== "object" || Array.isArray(source)) continue;
      const src = source as Record<string, unknown>;
      if (src.type === "local" && Array.isArray(src.paths)) {
        lines.push(`  - local: ${src.paths.join(", ")}`);
      } else if (src.type === "linear") {
        lines.push(`  - linear: env=${String(src.api_key_env ?? "LINEAR_API_KEY")}${src.team_key ? ` team=${src.team_key}` : ""}${src.filter ? ` filter=${src.filter}` : ""}`);
      } else if (src.type === "jira") {
        lines.push(`  - jira: site=${String(src.site ?? "")} jql=${String(src.jql ?? "")} email_env=${String(src.email_env ?? "JIRA_EMAIL")} token_env=${String(src.token_env ?? "JIRA_API_TOKEN")}`);
      }
    }
  }
  const populate = tickets.populate as Record<string, unknown> | undefined;
  if (populate && typeof populate === "object") {
    lines.push(`- Populate: agent=${String(populate.agent_preference ?? "configured")} cap=${String(populate.import_cap ?? 500)} comments=${String(populate.comment_limit ?? 10)} enrichment=${String(populate.enrichment ?? "recommendations")}`);
  }
  const build = tickets.build as Record<string, unknown> | undefined;
  if (build && typeof build === "object") {
    lines.push(`- Build: branch_strategy=${String(build.branch_strategy ?? "branch-per-ticket")} completion=${String(build.completion ?? "none")} provider=${String(build.provider ?? "auto")} merge=${String(build.merge_method ?? "squash")}`);
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function assertOutputPathInsideRepo(projectDir: string, outputPath: string, label: string): void {
  const repoRoot = resolve(projectDir);
  const outputAbs = resolve(outputPath);
  const rel = relative(repoRoot, outputAbs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`plan output must stay inside the repository: ${label}`);
  }

  const repoReal = realOrResolved(repoRoot);
  const existing = nearestExistingPath(outputAbs);
  if (!existing) return;
  const real = realpathSync(existing);
  const realRel = relative(repoReal, real);
  if (!realRel && existing !== repoRoot) return;
  if (realRel.startsWith("..") || isAbsolute(realRel)) {
    throw new Error(`plan output must stay inside the repository: ${label}`);
  }
  const stat = statSync(existing);
  if (existing !== outputAbs && !stat.isDirectory()) {
    throw new Error(`plan output parent is not a directory: ${label}`);
  }
}

function nearestExistingPath(path: string): string | undefined {
  let current = pathExistsOrSymlink(path) ? path : dirname(path);
  while (!pathExistsOrSymlink(current)) {
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return current;
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

function findSection(markdown: string, section: string): { content: string } | undefined {
  const lines = markdown.split(/\r?\n/);
  const escaped = escapeRegExp(section);
  const heading = new RegExp(`^(#{1,6})\\s+(?:\\d+\\.\\s*)?${escaped}\\s*:?(?:\\s+#+)?\\s*$`, "i");

  for (let index = 0; index < lines.length; index++) {
    const match = heading.exec(lines[index] ?? "");
    if (!match) continue;

    const level = match[1].length;
    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      const next = /^(#{1,6})\s+/.exec(lines[cursor] ?? "");
      if (next && next[1].length <= level) {
        end = cursor;
        break;
      }
    }
    return { content: lines.slice(index + 1, end).join("\n").trim() };
  }

  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shellQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function fail(message: string): never {
  console.error(`rafi plan: ${message}`);
  process.exit(1);
}
