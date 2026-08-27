import { Command } from "commander";
import {
  appendFileSync,
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
  createRoleBuilder,
  makeLogPath,
  readOnlyPermissionConfig,
  type EffortLevel,
  type RoleBuilder,
  type RoleInstructionRunOptions,
  type RoleInstructionRunResult,
} from "ai-foreman/agent-run.js";
import { validateDocsRoot } from "./docs.js";
import { DEFAULT_DOCS_ROOT, LEGACY_PROJECT_CONFIG_FILE, RAFI_CONFIG_FILE } from "./project.js";
import { normalizePlanningSources } from "./project.js";
import { assertLifecycleForCommand } from "./lifecycle.js";
import type { PlanningMode } from "rafi-spec";
import type { SourceRegistryConfig } from "rafi-spec";
import type { StructuredPlanV1 } from "rafi-spec";
import {
  checkpointInterview,
  completeInterview,
  createInterviewRecord,
  failInterview,
  findInterviewRecord,
  fingerprintOutputs,
  outputsChanged,
  readInterviewRecords,
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
import {
  loadSourceRegistry,
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
import type { AnsweredProviderQuestion } from "ai-foreman/provider-questions.js";
import {
  buildAuditAnswersContinuation,
  collectGrillAuditAnswers,
  decisionsWithGrillState,
  defaultGrillVerificationState,
  needsIndependentGrillAudit,
  readGrillVerificationState,
  recordNativeGrillAnswer,
  recordTextGrillAnswer,
  runIndependentGrillAudit,
  type AuditQuestionPrompt,
  type GrillVerificationState,
} from "./grillAudit.js";

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
    ? `- Use the complete grill-me skill instructions in this same session. Explore material decision branches one question at a time. There is no arbitrary minimum question count.\n- Every grill-me question must use a machine-recognizable shape: exactly one single-select question; the first choice ends with \`(Recommended)\`; at least one meaningful alternative follows; and the exact final choice is \`Stop questions and make the plan now\`. Custom answers remain available.\n- If your runtime provides a native AskUserQuestion-style question tool, use a header beginning with \`Grill-me\`. If no native question tool is available, end the turn with \`STEP_STATUS: needs_input | question="..." choices="recommended option (Recommended)|meaningful alternative|Stop questions and make the plan now"\`.\n- If no useful user-judgment question exists, return the candidate normally. Rafi will independently verify it before approval.`
    : "- Use a standard focused planning conversation. Do not invoke, advertise, or claim use of grill-me.";

  return `You are being run by Rafi to create a ticket-maker-ready implementation plan.

User brief:
${opts.brief.trim()}

Configured Rafi docs root:
${opts.docsRoot}

Planning source hints:
${sources}

Source intake protocol:
- Preserve every user source answer verbatim. Do not split it on spaces, commas, or plus signs.
- You may interpret remembered pending descriptions and request a supported source by returning one JSON object (or an array) between these markers:
${SOURCE_REQUEST_START}
{ "type": "local|url|github|gitlab|linear|jira", "description": "exact pending description when resolving one", "label": "human label", "locator": { "...": "normalized non-secret locator fields" } }
${SOURCE_REQUEST_END}
- For Linear and Jira, request only team/filter/site/query and environment-variable names. Never request or emit a secret.
- Rafi retrieves requested content outside this read-only agent and resumes this same session.

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

Inspect the repository enough to make the plan concrete. Prefer facts from files over assumptions.${mode === "standard" ? ` If a decision is genuinely blocked, ask one focused question with:
STEP_STATUS: needs_input | question="..." choices="recommended option|alternative"` : " In exhaustive mode, use only the machine-recognizable grill-me question shape above."}

Output contract:
- Cover the planning concepts Goal, Problem Statement, Repo Findings, Locked Decisions, Open Questions, Scope, Out Of Scope, Risks, Rollback Notes, and Ticket-Maker Guidance in the corresponding structured fields. Include a branch/batch strategy for repeated component-library work when relevant.
- Return exactly one JSON object between ${PLAN_PROPOSAL_START} and ${PLAN_PROPOSAL_END}.
- Shape: {"version":1,"summary":"...","assumptions":["..."],"implementation_changes":["..."],"acceptance_criteria":["..."],"test_plan":["..."],"slices":[{"local_ref":"S1","retains":"optional existing slice_ref only when revising","title":"...","summary":"...","acceptance":["..."],"required_tests":["..."],"likely_files":["..."],"depends_on":["local_ref"],"source_refs":[{"source_id":"src_...","fingerprint":"64 hex characters","item":"optional item"}]}],"delivery_units":[{"id":"unit-name","slice_refs":["local_ref"],"branch_mode":"current|per-ticket|shared","completion":"pr|auto-merge|direct-merge|none","provider":"auto|github|gitlab|local","pr_ready":false,"merge_method":"squash|merge|rebase","cleanup":false,"depends_on":["unit-id"],"dependency_mode":"combine|wait|stack"}],"stacks":[{"local_ref":"STACK1","retains":"optional existing stack_id only when revising","name":"...","units":["root-unit","child-unit"]}]}.
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
  onAnsweredQuestion?: (event: AnsweredProviderQuestion) => void;
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
    onAnsweredQuestion: opts.onAnsweredQuestion,
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

export type WorkflowOutcomeStatus = "completed" | "cancelled" | "paused" | "blocked" | "failed";

export interface WorkflowOutcome<T> {
  status: WorkflowOutcomeStatus;
  result?: T;
  diagnostic?: string;
  resumeCommand?: string;
}

export interface PlanResult {
  planId: string;
  revision: number;
  latestMarkdown: string;
  latestData: string;
  runtime: string;
  model?: string;
  sessionId?: string;
  nextPopulateCommand: string;
}

export interface PlanWorkflowOptions {
  project: string;
  brief?: string;
  briefFile?: string;
  sources?: string[];
  sourceStorage?: string;
  agent?: string;
  model?: string;
  effort?: string;
  fast?: boolean;
  resumeSession?: string;
  revise?: string | boolean;
  validate?: boolean;
  render?: boolean;
  grillMe?: boolean;
  yes?: boolean;
  skipRunConfirmation?: boolean;
  parentInterview?: { id: string; journeyId: string };
  invocationLabel?: string;
  rawArgs?: string[];
  runInstruction?: (options: RoleInstructionRunOptions) => Promise<RoleInstructionRunResult>;
  createPlanner?: (options: Parameters<typeof createRoleBuilder>[0]) => Promise<RoleBuilder>;
  createAuditor?: (options: Parameters<typeof createRoleBuilder>[0]) => Promise<RoleBuilder>;
  handleInput?: typeof handlePlanningInput;
  promptAuditQuestion?: AuditQuestionPrompt;
  promptAuditRecovery?: () => Promise<"retry" | "cancel">;
}

class PlanCancelled extends Error {
  constructor(message = "cancelled") {
    super(message);
    this.name = "PlanCancelled";
  }
}

export function buildPlanCommand(): Command {
  return new Command("plan")
    .description("Create a ticket-maker-ready implementation plan from a brief and repo inspection.")
    .argument("[project]", "path to the target repo", ".")
    .option("--brief <text>", "planning brief")
    .option("--brief-file <path>", "file containing the planning brief")
    .option("--sources <paths...>", "source hint files, folders, or globs to check first")
    .option("--source-storage <mode>", "storage for newly captured source versions (local | tracked)")
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
    .option("--skip-run-confirmation", "skip only the duplicate run confirmation (used by interactive create)")
    .option("-y, --yes", "skip confirmation prompt before running the planning agent")
    .action(async (project: string, opts, command: Command) => {
      const parent = command.parent as (Command & { rawArgs?: string[] }) | null;
      const argv = parent?.rawArgs ?? (command as Command & { rawArgs?: string[] }).rawArgs ?? process.argv.slice(2);
      const outcome = await runPlanWorkflow({ ...(opts as PlanWorkflowOptions), project, rawArgs: argv });
      if (outcome.status === "completed" || outcome.status === "cancelled") return;
      if (outcome.diagnostic) console.error(`rafi plan: ${outcome.diagnostic}`);
      if (outcome.resumeCommand) console.error(`rafi plan: resume with: ${outcome.resumeCommand}`);
      process.exit(outcome.status === "blocked" ? 2 : 1);
    });
}

export async function runPlanWorkflow(opts: PlanWorkflowOptions): Promise<WorkflowOutcome<PlanResult>> {
  const projectDir = resolve(opts.project);
  let interview: InterviewRecord | undefined;
  let workflow: WorkflowDb | undefined;
  let workflowRunId: string | undefined;
  let workflowLease: ProjectLease | undefined;
  let lastSessionId = opts.resumeSession;
  let brief = "";
  let currentPlanningMode: PlanningMode = "standard";
  let directPlanner: RoleBuilder | undefined;
  let grillState = defaultGrillVerificationState(false);
  try {
    assertLifecycleForCommand(projectDir, "plan");
    const argv = opts.rawArgs ?? [];
    if (argv.includes("--grill-me") && argv.includes("--no-grill-me")) throw new Error("choose either --grill-me or --no-grill-me, not both");
    const interactiveInterview = !opts.yes && process.stdin.isTTY && process.stdout.isTTY;
    const resumedInterview = opts.resumeSession
      ? readInterviewRecords(projectDir).records.find((record) => record.workflow === "plan" && record.status !== "completed" && (record.runtime.sessionId === opts.resumeSession || Object.values(record.sessionIds).includes(opts.resumeSession!)))
      : undefined;
    if (resumedInterview) {
      opts.brief ??= typeof resumedInterview.answers.brief === "string" ? resumedInterview.answers.brief : undefined;
      opts.agent ??= resumedInterview.runtime.runtime;
      opts.model ??= resumedInterview.runtime.model;
      const savedEffort = resumedInterview.invocation.effort;
      opts.effort ??= typeof savedEffort === "string" ? savedEffort : undefined;
    } else if (opts.resumeSession) {
      console.warn("rafi plan: no durable interview record matched this session; continuing without creating a duplicate resume record");
    }
    let planningMode: PlanningMode = resumedInterview?.planningMode ?? (opts.grillMe === true ? "exhaustive" : "standard");
    if (!resumedInterview && interactiveInterview && !argv.includes("--grill-me") && !argv.includes("--no-grill-me")) {
      const { select, isCancel } = await import("@clack/prompts");
      const selected = await select({ message: "Planning depth (exhaustive may take substantially longer):", options: [
        { value: "standard", label: "Standard (Recommended)" },
        { value: "exhaustive", label: "Exhaustive grill-me" },
      ] });
      if (isCancel(selected)) return { status: "cancelled", diagnostic: "planning depth selection cancelled" };
      planningMode = selected as PlanningMode;
    }
    currentPlanningMode = planningMode;
    if (resumedInterview) {
      interview = resumedInterview;
    } else if (!opts.resumeSession && (interactiveInterview || planningMode === "exhaustive")) {
      interview = createInterviewRecord({
        workflow: "plan",
        invocation: { projectDir, agent: opts.agent, model: opts.model, effort: opts.effort, fast: Boolean(opts.fast), label: opts.invocationLabel },
        checkpoint: "planning-brief",
        outputs: ["docs/rafi-plan.md"],
        planningMode,
        parentId: opts.parentInterview?.id,
        journeyId: opts.parentInterview?.journeyId,
      });
      if (opts.parentInterview) {
        const parent = findInterviewRecord(projectDir, opts.parentInterview.id);
        if (parent && !parent.childIds.includes(interview.id)) {
          checkpointInterview(projectDir, parent, { childIds: [...parent.childIds, interview.id] });
        }
      }
    }
    grillState = readGrillVerificationState(interview?.decisions, planningMode === "exhaustive");
    if (interview) interview = checkpointInterview(projectDir, interview, { checkpoint: "planning-brief" });
    if (!existsSync(projectDir)) throw new Error(`project directory not found: ${projectDir}`);
    assertEffortLevel(opts.effort);

    const docsRoot = resolvePlanDocsRoot(projectDir);
    const previewPaths = resolvePlanArtifactPaths(projectDir, docsRoot);
    const latestMarkdown = resolve(projectDir, docsRoot, "rafi-plan.md");
    const latestData = resolve(projectDir, docsRoot, "rafi-plan.json");
    if (opts.validate) {
      const plan = readAndValidateStructuredPlanPair(latestMarkdown, latestData);
      console.log(`rafi plan: valid ${plan.plan_id} revision ${plan.revision} (${plan.content_digest})`);
      return { status: "completed" };
    }
    if (opts.render) {
      const plan = regenerateStructuredPlanMarkdown(latestMarkdown, latestData);
      console.log(`rafi plan: regenerated Markdown for ${plan.plan_id} revision ${plan.revision}`);
      return { status: "completed" };
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
    brief = await resolveBrief(opts);
    if (interview) interview = checkpointInterview(projectDir, interview, {
      checkpoint: "confirm-agent-run",
      answers: { ...interview.answers, brief },
    });
    const loadedSources = loadSourceRegistry(projectDir);
    let stagedSources: SourceRegistryConfig = loadedSources.registry;
    let selectedStorage = parseSourceStorage(opts.sourceStorage);
    if (selectedStorage) stagedSources = setSourceStorage(stagedSources, selectedStorage);
    const sourceAnswers = opts.sources ?? resolvePlanSources(projectDir) ?? [];
    if (!selectedStorage && interactiveInterview && !loadedSources.configured && sourceAnswers.length) selectedStorage = await promptSourceStorage();
    if (selectedStorage) stagedSources = setSourceStorage(stagedSources, selectedStorage);
    if (sourceAnswers.length) {
      const registered = await registerSourceRequests(projectDir, stagedSources, sourceAnswers.map((answer) => sourceRequestFromAnswer(answer, projectDir)), { storage: selectedStorage });
      stagedSources = registered.registry;
    }
    const sourceHints = sourceContext(stagedSources).flatMap((source) => {
      const versions = source.versions as Array<{ snapshot_path?: string }>;
      return versions.map((version) => version.snapshot_path).filter((path): path is string => Boolean(path));
    });
    sourceHints.push(...(stagedSources.pending ?? []).map((item) => `Pending source description (interpret and request if needed): ${item.description}`));
    const instruction = buildPlanInstruction({
      brief,
      sources: sourceHints,
      docsRoot,
      latestPlanPath: previewPaths.latestRel,
      historyDirPath: `${docsRoot}/rafi-plans`,
      ticketSetupSummary: readTicketSetupSummary(projectDir),
      planningMode,
    });

    if (!opts.yes && !opts.skipRunConfirmation) {
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
        return { status: "cancelled", diagnostic: "run confirmation cancelled" };
      }
    }

    const logPath = makeLogPath(projectDir, "rafi-plan");
    workflow = new WorkflowDb(projectDir);
    const workflowRun = workflow.createRun({ kind: "plan", checkpoint: "planner-session-before", originalWork: { brief, planningMode, revise: previous?.plan_id }, remainingWork: { approval: true }, state: {} });
    workflowRunId = workflowRun.runId;
    workflowLease = workflow.acquireLease(workflowRunId);
    if (interview) interview = checkpointInterview(projectDir, interview, { checkpoint: "agent-run" });
    console.log("rafi plan: running read-only planner");
    console.log(`rafi plan: project ${projectDir}`);
    console.log(`rafi plan: role planner; mode ${planningMode}`);
    console.log(`rafi plan: log ${logPath}\n`);

    const rebuildingLostContinuity = Boolean(interview?.continuityLost || interview?.runtime.continuityLost);
    if (rebuildingLostContinuity) {
      console.warn("rafi plan: planner-session continuity was lost; rebuilding from the saved brief and grill-me decisions without repeating completed verification");
    }
    let nextInstruction = rebuildingLostContinuity && grillState.answers.length
      ? `${instruction}\n\n${buildAuditAnswersContinuation(grillState)}`
      : instruction;
    let resumeSessionId = rebuildingLostContinuity ? undefined : opts.resumeSession;
    let run: RoleInstructionRunResult;
    let plan: StructuredPlanV1;
    let repairAttempts = 0;
    const runInstruction = opts.runInstruction;
    const createPlanner = opts.createPlanner ?? createRoleBuilder;
    const inputHandler = opts.handleInput ?? handlePlanningInput;
    const rememberPlannerAnswer = (question: string | undefined, answer: string | undefined, source: "native" | "text"): void => {
      if (!interview || !question?.trim() || !answer?.trim()) return;
      const prior = Array.isArray(interview.answers.plannerQuestionAnswers)
        ? interview.answers.plannerQuestionAnswers
        : [];
      interview = checkpointInterview(projectDir, interview, {
        answers: {
          ...interview.answers,
          plannerQuestionAnswers: [...prior, { question: question.trim(), answer: answer.trim(), source }],
        },
      });
    };
    const persistGrillState = (next: GrillVerificationState, event: string, questionId?: string): void => {
      grillState = next;
      if (interview) interview = checkpointInterview(projectDir, interview, {
        decisions: decisionsWithGrillState(interview.decisions, next),
        planningMode,
      });
      workflow?.transition(workflowRunId!, {
        checkpoint: `grill-${next.auditStatus}`,
        state: { grillVerification: next },
        event,
      });
      plannerLog(logPath).write(event as never, {
        mode: planningMode,
        validAnsweredQuestionCount: next.validAnsweredQuestionCount,
        auditStatus: next.auditStatus,
        runtime: run?.runtime,
        questionId,
      });
    };
    const observeNativeQuestion = (event: Parameters<typeof recordNativeGrillAnswer>[1]): void => {
      rememberPlannerAnswer(event.question.question, event.answer, "native");
      const observed = recordNativeGrillAnswer(grillState, event);
      persistGrillState(observed.state, observed.qualified ? "grill_answer_collected" : "provider_question_nonqualifying");
    };
    while (true) {
      if (runInstruction) {
        run = await runInstruction(buildPlanAgentRunOptions({
          projectDir, agent: opts.agent, model: opts.model,
          effort: opts.effort as EffortLevel | undefined, fast: opts.fast,
          yes: Boolean(opts.yes), resumeSessionId, instruction: nextInstruction, logPath, planningMode,
          onAnsweredQuestion: observeNativeQuestion,
        }));
      } else {
        if (!directPlanner) {
          const builderOptions = buildPlanAgentRunOptions({
            projectDir, agent: opts.agent, model: opts.model,
            effort: opts.effort as EffortLevel | undefined, fast: opts.fast,
            yes: Boolean(opts.yes), resumeSessionId, instruction: nextInstruction, logPath, planningMode,
            onAnsweredQuestion: observeNativeQuestion,
          });
          directPlanner = await createPlanner({
            ...builderOptions,
            log: plannerLog(logPath),
          });
        }
        const turn = await runPlannerTurn(directPlanner, nextInstruction);
        run = {
          turn,
          runtime: directPlanner.builder.agent,
          model: directPlanner.builder.agent === directPlanner.runtime ? directPlanner.model : undefined,
          effort: directPlanner.effort,
          sessionId: directPlanner.builder.sessionId(),
          logPath,
          roleBundle: directPlanner.roleBundle,
          skills: directPlanner.skills,
        };
        directPlanner.log.write("rafi-plan", {
          role: "planner",
          runtime: run.runtime,
          model: run.model,
          effort: run.effort,
          sessionId: run.sessionId,
          statusKind: turn.status.kind,
          summary: turn.status.summary,
          reason: turn.status.reason,
          costUsd: turn.result.costUsd,
          isError: turn.result.isError,
        });
      }
      lastSessionId = run.sessionId;
      workflow.transition(workflowRunId, { checkpoint: "planner-session-after", state: { sessionId: run.sessionId, runtime: run.runtime, model: run.model }, event: "planner_session" });
      const turn = run.turn;
      if (turn.result.isError) return failPlanOutcome(projectDir, workflow, workflowRunId, workflowLease, interview, "planner turn errored", run.sessionId, brief, planningMode);
      if (turn.status.kind === "blocked") {
        const diagnostic = `blocked - ${turn.status.reason ?? "planner reported blocked"}`;
        console.error(`rafi plan: ${diagnostic}`);
        finishPlanWorkflow(workflow, workflowRunId, workflowLease, "blocked", "planner-blocked", { error: diagnostic.slice(0, 1000) });
        workflow = undefined;
        return { status: "blocked", diagnostic, resumeCommand: planResumeCommand(projectDir, brief, run.sessionId, planningMode) };
      }
      if (turn.status.kind === "needs_input") {
        if (!turn.status.question?.trim()) {
          resumeSessionId = run.sessionId;
          nextInstruction = planningMode === "exhaustive"
            ? `Your needs_input marker omitted its question. Return the same single user-judgment question again using exactly: STEP_STATUS: needs_input | question="..." choices="recommended option (Recommended)|meaningful alternative|Stop questions and make the plan now". Do not inspect the repository again and do not return a proposal yet.`
            : `Your needs_input marker omitted its question. Return the same focused question again using exactly: STEP_STATUS: needs_input | question="..." choices="recommended option|alternative". Do not inspect the repository again.`;
          continue;
        }
        const input = await inputHandler({ projectDir, output: turn.result.text, question: turn.status.question, choices: turn.status.choices, registry: stagedSources, storage: selectedStorage, interactive: !opts.yes && Boolean(process.stdin.isTTY && process.stdout.isTTY) });
        stagedSources = input.registry;
        if (input.cancelled) {
          await chooseStagedSourceDisposition(projectDir, loadedSources.registry, stagedSources);
          finishPlanWorkflow(workflow, workflowRunId, workflowLease, "cancelled", "input-cancelled");
          workflow = undefined;
          console.log("rafi plan: cancelled; no plan changes were written");
          return { status: "cancelled", diagnostic: "planner input cancelled", resumeCommand: planResumeCommand(projectDir, brief, run.sessionId, planningMode) };
        }
        const observed = recordTextGrillAnswer(grillState, {
          question: turn.status.question,
          choices: turn.status.choices,
          answer: input.answer,
        });
        rememberPlannerAnswer(turn.status.question, input.answer, "text");
        persistGrillState(observed.state, observed.qualified ? "grill_answer_collected" : "provider_question_nonqualifying");
        resumeSessionId = run.sessionId;
        nextInstruction = input.continuation!;
        continue;
      }
      if (!isSuccessfulPlanStatus(turn.status.kind)) {
        const diagnostic = `needs human - ${turn.status.error ?? "planner did not emit plan_complete"}`;
        console.error(`rafi plan: ${diagnostic}`);
        finishPlanWorkflow(workflow, workflowRunId, workflowLease, "blocked", "planner-needs-human", { error: diagnostic.slice(0, 1000) });
        workflow = undefined;
        return { status: "blocked", diagnostic, resumeCommand: planResumeCommand(projectDir, brief, run.sessionId, planningMode) };
      }
      const candidate = parseRepairablePlan(turn.result.text, previous, stagedSources, projectDir);
      if (!candidate.plan) {
        if (repairAttempts >= 3) {
          const diagnostic = `planner returned invalid structured proposal after ${repairAttempts} repair attempts:\n${candidate.diagnostic}`;
          return failPlanOutcome(projectDir, workflow, workflowRunId, workflowLease, interview, diagnostic, run.sessionId, brief, planningMode);
        }
        repairAttempts += 1;
        resumeSessionId = run.sessionId;
        nextInstruction = buildPlanRepairInstruction(candidate.diagnostic, repairAttempts);
        continue;
      }
      plan = candidate.plan;
      let retryInterruptedAudit = false;
      if (grillState.auditStatus === "interrupted") {
        if (grillState.recoveryRetryUsed) {
          const diagnostic = `grill-me verification was interrupted after its one allowed recovery retry: ${grillState.failure ?? "no diagnostic"}; no plan was published`;
          return failPlanOutcome(projectDir, workflow, workflowRunId, workflowLease, interview, diagnostic, run.sessionId, brief, planningMode);
        }
        if (opts.yes || !interactiveInterview) {
          const diagnostic = "the prior grill-me verification was interrupted; resume interactively to choose whether to retry the one-time check or cancel";
          finishPlanWorkflow(workflow, workflowRunId, workflowLease, "paused", "grill-audit-interrupted", { grillVerification: grillState });
          workflow = undefined;
          return { status: "blocked", diagnostic, resumeCommand: planResumeCommand(projectDir, brief, run.sessionId, planningMode) };
        }
        const recovery = await (opts.promptAuditRecovery ?? promptGrillAuditRecovery)();
        if (recovery === "cancel") {
          finishPlanWorkflow(workflow, workflowRunId, workflowLease, "cancelled", "grill-audit-retry-cancelled", { grillVerification: grillState });
          workflow = undefined;
          return { status: "cancelled", diagnostic: "interrupted grill-me verification retry cancelled" };
        }
        retryInterruptedAudit = true;
      }
      if (grillState.auditStatus === "failed") {
        const diagnostic = `grill-me verification previously failed: ${grillState.failure ?? "no diagnostic"}; no plan was published`;
        return failPlanOutcome(projectDir, workflow, workflowRunId, workflowLease, interview, diagnostic, run.sessionId, brief, planningMode);
      }
      if (needsIndependentGrillAudit(grillState) || retryInterruptedAudit) {
        console.log("rafi plan: no valid grill-me answer was collected; running the one-time independent read-only verification");
        const audited = await runIndependentGrillAudit({
          projectDir,
          originalRequest: brief,
          knownDecisions: interview?.answers ?? {},
          repositoryContext: { sources: sourceHints, ticketSetup: readTicketSetupSummary(projectDir) },
          candidate: plan,
          runtime: run.runtime,
          model: run.model,
          effort: run.effort,
          createAuditor: opts.createAuditor,
          initialState: grillState,
          allowRecoveryRetry: retryInterruptedAudit,
          onState: persistGrillState,
        });
        grillState = audited.state;
        if (grillState.auditStatus === "failed" || grillState.auditStatus === "interrupted") {
          const diagnostic = `grill-me verification ${grillState.auditStatus}: ${grillState.failure ?? "no diagnostic"}; no plan was published`;
          return failPlanOutcome(projectDir, workflow, workflowRunId, workflowLease, interview, diagnostic, run.sessionId, brief, planningMode);
        }
        if (audited.verdict?.status === "complete") {
          console.log("rafi plan: independent verification found no missing user decisions");
        } else if (grillState.auditStatus === "needs_user_input") {
          console.log(`rafi plan: independent verification found ${grillState.pendingQuestions.length} missing user decision(s)`);
        }
      }
      if (grillState.auditStatus === "needs_user_input") {
        if (opts.yes || !interactiveInterview) {
          const diagnostic = "grill-me verification found missing user decisions; resume this plan interactively to answer them (recommendations will not be selected automatically)";
          finishPlanWorkflow(workflow, workflowRunId, workflowLease, "paused", "grill-needs-user-input", { grillVerification: grillState });
          workflow = undefined;
          return { status: "blocked", diagnostic, resumeCommand: planResumeCommand(projectDir, brief, run.sessionId, planningMode) };
        }
        grillState = await collectGrillAuditAnswers(
          grillState,
          opts.promptAuditQuestion ?? promptGrillAuditQuestion,
          persistGrillState,
        );
        if (grillState.auditStatus === "interrupted") {
          const diagnostic = "grill-me verification questions were interrupted; no plan was published";
          return failPlanOutcome(projectDir, workflow, workflowRunId, workflowLease, interview, diagnostic, run.sessionId, brief, planningMode);
        }
        resumeSessionId = run.sessionId;
        nextInstruction = buildAuditAnswersContinuation(grillState);
        continue;
      }
      if (opts.yes) break;
      console.log(`\n${renderStructuredPlanMarkdown(plan)}`);
      const { select, text, isCancel } = await import("@clack/prompts");
      const decision = await select({ message: "Approve this structured plan?", options: [
        { value: "approve", label: "Approve and publish (Recommended)" },
        { value: "discuss", label: "Discuss and revise" },
        { value: "cancel", label: "Cancel without changes" },
      ] });
      if (isCancel(decision) || decision === "cancel") {
        workflow.transition(workflowRunId, { status: "cancelled", checkpoint: "approval-cancelled", remainingWork: {} });
        if (workflowLease) workflow.releaseLease(workflowLease);
        workflow.close();
        workflow = undefined;
        await chooseStagedSourceDisposition(projectDir, loadedSources.registry, stagedSources);
        console.log("rafi plan: cancelled; no plan changes were written");
        return { status: "cancelled", diagnostic: "plan approval cancelled", resumeCommand: planResumeCommand(projectDir, brief, run.sessionId, planningMode) };
      }
      if (decision === "approve") break;
      const feedback = await text({ message: "What should the Planner revise?" });
      if (isCancel(feedback)) {
        workflow.transition(workflowRunId, { status: "cancelled", checkpoint: "approval-cancelled", remainingWork: {} });
        if (workflowLease) workflow.releaseLease(workflowLease);
        workflow.close();
        workflow = undefined;
        console.log("rafi plan: cancelled; no plan or settings were changed");
        return { status: "cancelled", diagnostic: "revision feedback cancelled", resumeCommand: planResumeCommand(projectDir, brief, run.sessionId, planningMode) };
      }
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
    saveSourceRegistry(projectDir, stagedSources);
    workflow.transition(workflowRunId, { status: "completed", checkpoint: "plan-pair-published", remainingWork: {}, state: { planId: plan.plan_id, revision: plan.revision, digest: plan.content_digest } });
    if (workflowLease) workflow.releaseLease(workflowLease);
    workflow.close();
    workflow = undefined;
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
    if (directPlanner) {
      await directPlanner.builder.close();
      directPlanner = undefined;
    }

    console.log(`\nrafi plan: wrote ${relative(projectDir, written.historyMarkdown)} and ${relative(projectDir, written.historyData)}`);
    console.log(`rafi plan: refreshed ${relative(projectDir, written.latestMarkdown)} and ${relative(projectDir, written.latestData)}`);
    const populate = nextPopulateCommand(projectDir, relative(projectDir, written.latestData));
    console.log("rafi plan: next:");
    console.log(`  ${populate}`);
    return {
      status: "completed",
      result: {
        planId: plan.plan_id,
        revision: plan.revision,
        latestMarkdown: written.latestMarkdown,
        latestData: written.latestData,
        runtime: run.runtime,
        model: run.model,
        sessionId: run.sessionId,
        nextPopulateCommand: populate,
      },
    };
  } catch (err) {
    if (err instanceof PlanCancelled) {
      return { status: "cancelled", diagnostic: err.message, resumeCommand: planResumeCommand(projectDir, brief, lastSessionId, currentPlanningMode) };
    }
    return failPlanOutcome(projectDir, workflow, workflowRunId, workflowLease, interview, err instanceof Error ? err.message : String(err), lastSessionId, brief, currentPlanningMode);
  } finally {
    if (directPlanner) await directPlanner.builder.close().catch(() => {});
  }
}

async function runPlannerTurn(
  role: RoleBuilder,
  instruction: string,
): Promise<RoleInstructionRunResult["turn"]> {
  let result = await role.builder.sendTurn(instruction);
  let status = parsePlannerStepStatus(result.text);
  if (status.kind === "unknown") {
    if (!status.error && plannerOutputLooksLikeQuestion(result.text)) {
      status = { kind: "needs_input", question: lastNonEmptyLine(result.text), choices: ["Continue", "Cancel"] };
    } else {
      result = await role.builder.sendTurn("Protocol correction only: based on the planning work already completed, return exactly one final STEP_STATUS: plan_complete, blocked, or needs_input marker. Do not repeat tools, repository inspection, or source intake.");
      status = parsePlannerStepStatus(result.text);
      if (status.kind === "unknown") status = { ...status, error: `protocol correction exhausted: ${status.error ?? "missing final marker"}` };
    }
  }
  return { result, status };
}

function plannerLog(path: string): RoleBuilder["log"] {
  return {
    write(event: string, fields: Record<string, unknown>): void {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + "\n", "utf8");
    },
  } as never;
}

function parsePlannerStepStatus(text: string): RoleInstructionRunResult["turn"]["status"] {
  const markerCount = (text.match(/STEP_STATUS:/g) ?? []).length;
  if (markerCount > 1) return { kind: "unknown", error: "planner emitted multiple STEP_STATUS markers" };
  const lines = text.trimEnd().split(/\r?\n/).filter((line) => line.trim().length > 0);
  const last = lines[lines.length - 1] ?? "";
  if (!last.includes("STEP_STATUS:")) {
    if (markerCount === 1) return { kind: "unknown", error: "STEP_STATUS marker was not the final non-empty line" };
    return { kind: "unknown" };
  }
  const match = last.match(/^STEP_STATUS:\s*(plan_complete|blocked|needs_input)\b\s*(?:\|\s*(.*))?$/i);
  if (!match) return { kind: "unknown", error: "malformed STEP_STATUS marker" };
  const fields = parsePlannerMarkerFields(match[2] ?? "");
  if (fields instanceof Error) return { kind: "unknown", error: fields.message };
  return {
    kind: match[1].toLowerCase() as "plan_complete" | "blocked" | "needs_input",
    summary: fields.summary,
    reason: fields.reason,
    question: fields.question,
    choices: fields.choices ? fields.choices.split("|").map((choice) => choice.trim()).filter(Boolean) : undefined,
  };
}

function parsePlannerMarkerFields(input: string): Record<string, string> | Error {
  const fields: Record<string, string> = {};
  let rest = input.trim();
  while (rest.length > 0) {
    const key = rest.match(/^(\w+)="/);
    if (!key) return new Error(`malformed STEP_STATUS field near: ${rest.slice(0, 40)}`);
    const name = key[1]!;
    let i = key[0].length;
    let value = "";
    let closed = false;
    while (i < rest.length) {
      const ch = rest[i];
      if (ch === "\\") {
        const next = rest[i + 1];
        if (next === undefined) return new Error(`unterminated escape in STEP_STATUS field: ${name}`);
        value += next;
        i += 2;
        continue;
      }
      if (ch === "\"") {
        closed = true;
        i++;
        break;
      }
      value += ch;
      i++;
    }
    if (!closed) return new Error(`unterminated STEP_STATUS field: ${name}`);
    if (fields[name] !== undefined) return new Error(`duplicate STEP_STATUS field: ${name}`);
    fields[name] = value;
    rest = rest.slice(i).trim();
  }
  return fields;
}

function plannerOutputLooksLikeQuestion(text: string): boolean {
  const tail = text.trim().toLowerCase().slice(-400);
  if (tail.endsWith("?")) return true;
  return ["should i", "would you like", "do you want", "let me know", "please confirm", "could you clarify", "which option"]
    .some((hint) => tail.includes(hint));
}

function lastNonEmptyLine(text: string): string {
  return text.trimEnd().split(/\r?\n/).filter((line) => line.trim().length > 0).at(-1) ?? "Planner needs input";
}

function parseRepairablePlan(
  output: string,
  previous: StructuredPlanV1 | undefined,
  stagedSources: SourceRegistryConfig,
  projectDir: string,
): { plan?: StructuredPlanV1; diagnostic: string } {
  try {
    const plan = materializeStructuredPlan(extractStructuredPlanProposal(output), previous);
    const invalidRefs = plan.slices.flatMap((slice) => (slice.source_refs ?? [])
      .map((ref) => validateSourceVersionRef(stagedSources, ref, projectDir))
      .filter((issue): issue is string => Boolean(issue)));
    if (invalidRefs.length) return { diagnostic: `invalid source provenance:\n${invalidRefs.join("\n")}` };
    return { plan, diagnostic: "" };
  } catch (err) {
    return { diagnostic: err instanceof Error ? err.message : String(err) };
  }
}

function buildPlanRepairInstruction(diagnostic: string, attempt: number): string {
  return `Your previous final proposal was rejected by Rafi validation (repair attempt ${attempt} of 3).

Validation errors:
${diagnostic}

Return a complete replacement proposal only. Use the exact ${PLAN_PROPOSAL_START}/${PLAN_PROPOSAL_END} JSON envelope, preserve the required shape, and end with exactly:
STEP_STATUS: plan_complete | summary="created ticket-maker-ready Rafi plan"`;
}

function failPlanOutcome<T>(
  projectDir: string,
  workflow: WorkflowDb | undefined,
  workflowRunId: string | undefined,
  workflowLease: ProjectLease | undefined,
  interview: InterviewRecord | undefined,
  diagnostic: string,
  sessionId: string | undefined,
  brief: string,
  planningMode: PlanningMode,
): WorkflowOutcome<T> {
  if (workflow && workflowRunId) {
    try {
      workflow.transition(workflowRunId, {
        status: "failed",
        checkpoint: "plan-failed",
        remainingWork: {},
        state: { error: diagnostic.slice(0, 1000) },
      });
      if (workflowLease) workflow.releaseLease(workflowLease);
    } finally {
      workflow.close();
    }
  }
  if (interview) failInterview(projectDir, interview, interview.checkpoint, new Error(diagnostic));
  return { status: "failed", diagnostic, resumeCommand: planResumeCommand(projectDir, brief, sessionId, planningMode) };
}

function finishPlanWorkflow(
  workflow: WorkflowDb | undefined,
  workflowRunId: string | undefined,
  workflowLease: ProjectLease | undefined,
  status: "blocked" | "cancelled" | "paused",
  checkpoint: string,
  state: Record<string, unknown> = {},
): void {
  if (!workflow || !workflowRunId) return;
  try {
    workflow.transition(workflowRunId, { status, checkpoint, remainingWork: {}, state });
    if (workflowLease) workflow.releaseLease(workflowLease);
  } finally {
    workflow.close();
  }
}

function planResumeCommand(projectDir: string, brief: string, sessionId: string | undefined, planningMode: PlanningMode): string | undefined {
  if (!sessionId) return undefined;
  const modeFlag = planningMode === "exhaustive" ? "--grill-me" : "--no-grill-me";
  const briefArg = brief ? ` --brief ${shellQuote(brief)}` : "";
  return `rafi plan ${shellQuote(projectDir)}${briefArg} --resume-session ${shellQuote(sessionId)} ${modeFlag}`;
}

async function promptGrillAuditQuestion(question: Parameters<AuditQuestionPrompt>[0], choices: string[]): Promise<string | undefined> {
  const { select, text, isCancel, log } = await import("@clack/prompts");
  log.info(question.rationale);
  const custom = "__rafi_grill_audit_custom__";
  const selected = await select<string>({
    message: question.question,
    options: [
      ...choices.map((choice) => ({ value: choice, label: choice })),
      { value: custom, label: "Custom response" },
    ],
  });
  if (isCancel(selected)) return undefined;
  if (selected !== custom) return String(selected);
  const answer = await text({ message: "Custom response:" });
  if (isCancel(answer)) return undefined;
  return String(answer);
}

async function promptGrillAuditRecovery(): Promise<"retry" | "cancel"> {
  const { select, isCancel } = await import("@clack/prompts");
  const answer = await select<"retry" | "cancel">({
    message: "The independent grill-me verification was interrupted. What should Rafi do?",
    options: [
      { value: "retry", label: "Retry the check once (Recommended)" },
      { value: "cancel", label: "Cancel without publishing" },
    ],
  });
  return isCancel(answer) ? "cancel" : answer;
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
  if (isCancel(answer)) throw new PlanCancelled("planning brief cancelled");
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
