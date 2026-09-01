import { Command } from "commander";
import { resolve, join, relative } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { select, text, isCancel } from "@clack/prompts";
import { loadConfig } from "../config.js";
import { Log } from "../log.js";
import { PermissionPolicy } from "../permissions/policy.js";
import { ClaudeAdapter } from "../adapters/claude.js";
import { CodexAdapter } from "../adapters/codex.js";
import { RecoveringAdapter } from "../adapters/recovering.js";
import { Foreman, createPermissionHandler } from "../foreman.js";
import type { BuilderAdapter, EffortLevel } from "../adapters/types.js";
import { printEvents } from "./events.js";
import { loadRoleBundle } from "../roles.js";
import { ensureRuntimeReadyForCommand } from "./runtimeAuthPrompt.js";
import type { AgentRuntime } from "../runtimeAuth.js";
import { resolveAgentForProject } from "./runtimeSelection.js";
import { isTicketsInitialized, loadTicketsConfig, resolveTicketPaths } from "../tickets/config.js";
import { loadTickets } from "../tickets/ticketLoader.js";
import { StateDb } from "../tickets/stateDb.js";
import { applySharedDeliveryBranch, applySizeBranchPolicy, buildBranchAuditInstruction, buildBranchPlan, parseAuditDependencies } from "../branch/planner.js";
import { collectBaseWorktreeDirtyPaths, currentGitRef, ensureCleanBaseWorktree, generatedTrackerDirtyPaths } from "../branch/git.js";
import { formatGitHubFailure, preflightGh } from "../branch/github.js";
import { preflightGlab } from "../branch/gitlab.js";
import { readDeliveryUnitSession, runBranchPlan } from "../branch/runner.js";
import { branchPlanLogMetadata, presentBranchPlan } from "../branch/presentation.js";
import { buildRunSessionBinding, checkpointBuildRun, completeBuildRun, createBuildRun, heartbeatBuildRun, persistBuildSession, projectBuildRecovery, readBuildRuns, releaseBuildLease, resumeBuildRun } from "../buildRuns.js";
import type { BuildRunRecordV2, ProviderSessionRefV1, ResolvedAgentSettings, SessionStrategy } from "rafi-spec";
import type { AgentDefaultsV1, AgentRoleDefaultsV1 } from "rafi-spec";
import { parse as parseYaml } from "yaml";
import {
  findResumableBranchSessions,
  formatBranchContinueCommand,
  formatBranchSummaryFollowupCommands,
} from "../branch/resume.js";
import type { BranchResumeSession } from "../branch/resume.js";
import type { BranchPlan, BranchPlanNode, CompletionMode, MergeMethod, ReviewProvider } from "../branch/types.js";
import { detectGitProvider, loadTicketSetupConfig } from "../tickets/setupConfig.js";
import { loadDeliveryConfig, selectDeliveryUnitForRun, selectStacksForRun, updateStackDeliveryState, type DeliveryConfig, type DeliveryStack, type DeliveryUnitProgress } from "../tickets/delivery.js";
import { AgentStatusReporter, RoleStatusAdapter } from "../statusReporter.js";
import { currentActivity, withActivityPhase } from "../activity.js";
import { fireTerminalBell } from "../notify.js";
import { WorkflowDb, readCurrentWorkflowLease } from "../workflowDb.js";
import { makeLogPath as makeRoleLogPath, readOnlyPermissionConfig, runRoleInstruction } from "../agentRun.js";
import type { QaNonconvergenceContext, QaNonconvergenceDecision } from "../qaReview.js";
import { eligibleTickets, evaluateTicketEligibility } from "../tickets/eligibility.js";
import { BUILTIN_BRANCH_PREFIX, validateBranchPrefix } from "../branch/prefix.js";
import { captureCurrentWorkflowSessionIdentity, CurrentWorkflowChangedError, CurrentWorkflowGuardAdapter } from "../branch/currentGuard.js";
import { ContinuityAdapter, ContinuityRecoveryRequiredError, SessionUnavailableContinuityError } from "../continuity.js";
import { ContextCapabilityError, RoleSessionController, ThresholdCompactionController } from "../sessionLifecycle.js";
import { HandoffAcceptanceError, HandoffLoopError, HandoffRecoveryPausedError, HandoffService, parseBuilderHandoffRequest } from "../handoffs.js";
import { captureWorkspaceIdentity, createProviderSessionRef, resolveUniqueSessionBinding } from "../sessionIdentity.js";
import { SessionUnavailableError } from "../adapters/sessionFailure.js";
import { resolveProviderSessionAvailability } from "../sessionAvailability.js";

function fail(message: string): never {
  console.error(`foreman: ${message}`);
  process.exit(1);
}

function findLastSessionId(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const logs = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  if (logs.length === 0) return undefined;
  const lines = readFileSync(join(dir, logs[logs.length - 1]), "utf8")
    .split("\n")
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const r = JSON.parse(lines[i]) as Record<string, unknown>;
    if (r.event === "batch-end" && typeof r.sessionId === "string") {
      return r.sessionId;
    }
  }
  return undefined;
}

function collectTicket(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function legacyBranchSessionRef(session: BranchResumeSession, configRoot: string, fallbackProvider: AgentRuntime): ProviderSessionRefV1 {
  const provider = session.agent === "claude" || session.agent === "codex" ? session.agent : fallbackProvider;
  return createProviderSessionRef({
    provider, sessionId: session.sessionId, role: "builder", stream: "builder", generation: 0,
    cwd: session.worktreePath, configRoot, workspaceIdentity: captureWorkspaceIdentity(session.worktreePath),
    ticketId: session.ticket, deliveryUnitId: session.deliveryUnitId, source: "legacy-inferred", createdAt: session.ts,
  });
}

export function formatStartResumeCommand(
  executable: "ai-foreman",
  projectDir: string,
  steps: number,
  sessionId: string,
): string {
  return [
    executable,
    "start",
    shellQuote(projectDir),
    "--steps",
    String(steps),
    "--resume",
    shellQuote(sessionId),
  ].join(" ");
}

export function formatResumeGuidance(
  executable: "rafi" | "ai-foreman",
  projectDir: string,
  steps: number,
  sessionId?: string,
): string[] {
  if (executable === "rafi") {
    return [
      "foreman: resume this run with:",
      `  rafi build:resume ${shellQuote(projectDir)}`,
    ];
  }
  if (!sessionId) return [];
  return [
    "foreman: resume this builder with:",
    `  ${formatStartResumeCommand("ai-foreman", projectDir, steps, sessionId)}`,
  ];
}

function optionWasProvided(command: Command, name: string): boolean {
  const source = command.getOptionValueSource(name);
  return source !== undefined && source !== "default";
}

interface ResolvedStartBranchDefaults {
  branchMode: boolean;
  completionMode: CompletionMode;
  reviewProvider?: ReviewProvider;
  createReview: boolean;
  prReady: boolean;
  cleanupBranches: boolean;
  rootBaseBranches: boolean;
  autoMergeWait: boolean;
  autoMergeTimeoutMinutes: number | null;
  mergeMethod: MergeMethod;
}

function resolveStartBranchDefaults(
  cwd: string,
  opts: Record<string, unknown>,
  command: Command,
  delivery?: DeliveryUnitProgress,
): ResolvedStartBranchDefaults {
  const setup = loadTicketSetupConfig(cwd);
  const savedBuild = setup?.build;
  const branchFlagProvided = optionWasProvided(command, "branchPerTicket");
  const branchFlagOn = branchFlagProvided && opts.branchPerTicket !== false;
  const createPrFlagProvided = optionWasProvided(command, "createPr");
  const createPrFlagOn = createPrFlagProvided && opts.createPr !== false;
  const completionFromFlag = typeof opts.completion === "string"
    ? parseCompletionMode(opts.completion)
    : undefined;
  const deliveryCompletion = delivery?.unit.completion;
  let completionMode: CompletionMode =
    completionFromFlag
    ?? (createPrFlagOn ? "pr" : undefined)
    ?? deliveryCompletion
    ?? savedBuild?.completion
    ?? "none";

  const explicitIsolation = branchFlagOn || createPrFlagOn || optionWasProvided(command, "completion") || Boolean(opts.stacks);
  if (savedBuild?.branch_strategy === "current" && !explicitIsolation) completionMode = "none";

  if (createPrFlagProvided && opts.createPr === false) {
    completionMode = "none";
  }

  const savedBranchMode = savedBuild?.branch_strategy === "branch-per-ticket";
  let branchMode = Boolean(savedBranchMode || branchFlagOn || createPrFlagOn || completionMode !== "none");
  if (savedBuild?.branch_strategy === "current" && !explicitIsolation) branchMode = false;
  if (savedBuild?.branch_strategy !== "current" && !branchFlagProvided && !createPrFlagProvided && !optionWasProvided(command, "completion") && delivery) {
    branchMode = delivery.unit.branch_mode !== "current";
  }
  if (branchFlagProvided && opts.branchPerTicket === false) {
    branchMode = false;
    completionMode = "none";
  }
  if (completionMode !== "none") branchMode = true;

  const providerFromFlag = typeof opts.provider === "string" ? parseReviewProviderOption(opts.provider, cwd) : undefined;
  const provider = providerFromFlag ?? (createPrFlagOn ? "github" : providerFromSaved(delivery?.unit.provider ?? savedBuild?.provider, cwd));
  const autoMergeWaitProvided = optionWasProvided(command, "autoMergeWait");
  const autoMergeTimeoutMinutes = typeof opts.autoMergeTimeoutMinutes === "string"
    ? parseOptionalPositiveInteger(opts.autoMergeTimeoutMinutes, "--auto-merge-timeout-minutes")
    : savedBuild?.auto_merge_timeout_minutes ?? null;
  return {
    branchMode,
    completionMode,
    reviewProvider: provider,
    createReview: completionMode === "pr" || completionMode === "auto-merge",
    prReady: Boolean(opts.prReady || delivery?.unit.pr_ready || savedBuild?.pr_ready || completionMode === "auto-merge"),
    cleanupBranches: opts.keepWorktrees ? false : delivery?.unit.cleanup ?? savedBuild?.cleanup ?? true,
    rootBaseBranches: completionMode === "auto-merge" || completionMode === "direct-merge",
    autoMergeWait: autoMergeWaitProvided ? opts.autoMergeWait !== false : savedBuild?.auto_merge_wait ?? false,
    autoMergeTimeoutMinutes,
    mergeMethod: typeof opts.mergeMethod === "string" ? parseMergeMethod(opts.mergeMethod) : delivery?.unit.merge_method ?? savedBuild?.merge_method ?? "squash",
  };
}

function resolveStartBranchPrefix(cwd: string, opts: Record<string, unknown>, recovery?: BuildRunRecordV2): { value: string; source: "project" | "cli" | "builtin" | "resume" } {
  const resumed = recovery?.runDecisions?.branchPrefix;
  if (resumed) return { value: validateBranchPrefix(resumed), source: "resume" };
  if (typeof opts.branchPrefix === "string") return { value: validateBranchPrefix(opts.branchPrefix), source: "cli" };
  const saved = loadTicketSetupConfig(cwd)?.build.branch_prefix;
  if (saved) return { value: validateBranchPrefix(saved), source: "project" };
  return { value: BUILTIN_BRANCH_PREFIX, source: "builtin" };
}

function parseMergeMethod(value: string): MergeMethod {
  if (["squash", "merge", "rebase"].includes(value)) return value as MergeMethod;
  fail("--merge-method must be one of: squash, merge, rebase");
}

function parseCompletionMode(value: string): CompletionMode {
  if (["pr", "auto-merge", "direct-merge", "none"].includes(value)) return value as CompletionMode;
  fail("--completion must be one of: pr, auto-merge, direct-merge, none");
}

function parseReviewProviderOption(value: string, cwd: string): ReviewProvider | undefined {
  if (value === "auto") return providerFromSaved("auto", cwd);
  if (value === "github" || value === "gitlab") return value;
  fail("--provider must be one of: auto, github, gitlab");
}

function parseOptionalPositiveInteger(value: string, label: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number.parseInt(value, 10);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  fail(`${label} must be a positive integer or blank`);
}

function providerFromSaved(value: string | undefined, cwd: string): ReviewProvider | undefined {
  if (value === "github" || value === "gitlab") return value;
  if (value === "local") return undefined;
  return detectGitProvider(cwd);
}

function branchContinueTicketHelp(cwd: string, flag = "--continue"): string {
  const sessions = findResumableBranchSessions(join(cwd, ".foreman"));
  if (sessions.length === 0) {
    return [
      `branch mode ${flag} needs --ticket <id>, but no resumable branch ticket sessions were found.`,
      `Checked: ${join(cwd, ".foreman")}`,
    ].join("\n");
  }

  return [
    `branch mode ${flag} needs --ticket <id>.`,
    "Resumable branch ticket(s):",
    ...sessions.map((session) => `  ${session.ticket}  ${session.branch}  worktree=${session.worktreePath}`),
    "Run one of these commands:",
    ...sessions.map((session) => `  ${formatBranchContinueCommand(cwd, session)}`),
  ].join("\n");
}

async function ensureGitHubReadyForCreatePr(cwd: string, log: Log, yes: boolean): Promise<void> {
  while (true) {
    const result = await withActivityPhase("checking GitHub readiness", async () => {
      currentActivity()?.update("checking GitHub readiness", "remote, authentication, and repository access");
      return preflightGh(cwd);
    });
    if (result.ok) return;

    log.write("github-readiness-failed", {
      code: result.code,
      message: result.message,
      repairCommands: result.repairCommands,
      command: result.command,
      output: result.output,
    });

    const detail = formatGitHubFailure(result);
    if (yes || !process.stdin.isTTY || !process.stdout.isTTY) {
      fail(`GitHub PR setup failed before building:\n${detail}`);
    }

    console.error(`foreman: GitHub PR setup failed before building:\n${detail}\n`);
    const action = await select({
      message: "Retry GitHub readiness check?",
      options: [
        { value: "retry", label: "Retry" },
        { value: "cancel", label: "Cancel" },
      ],
    });
    if (isCancel(action) || action === "cancel") {
      console.log("ai-foreman: cancelled");
      process.exit(0);
    }
    currentActivity()?.note("rafi: retrying GitHub readiness check");
  }
}

async function ensureReviewProviderReady(cwd: string, provider: ReviewProvider, log: Log, yes: boolean): Promise<void> {
  if (provider === "github") {
    await ensureGitHubReadyForCreatePr(cwd, log, yes);
    return;
  }
  while (true) {
    const result = await withActivityPhase("checking GitLab readiness", async () => {
      currentActivity()?.update("checking GitLab readiness", "remote, authentication, and repository access");
      return preflightGlab(cwd);
    });
    if (result.ok) return;

    log.write("gitlab-readiness-failed", {
      code: result.code,
      message: result.message,
      repairCommands: result.repairCommands,
      command: result.command,
      output: result.output,
    });

    const detail = formatGitHubFailure(result);
    if (yes || !process.stdin.isTTY || !process.stdout.isTTY) {
      fail(`GitLab MR setup failed before building:\n${detail}`);
    }

    console.error(`foreman: GitLab MR setup failed before building:\n${detail}\n`);
    const action = await select({
      message: "Retry GitLab readiness check?",
      options: [
        { value: "retry", label: "Retry" },
        { value: "cancel", label: "Cancel" },
      ],
    });
    if (isCancel(action) || action === "cancel") {
      console.log("ai-foreman: cancelled");
      process.exit(0);
    }
    currentActivity()?.note("rafi: retrying GitLab readiness check");
  }
}

export function buildStartCommand(): Command {
  return new Command("start")
    .description("Enlist a builder and drive it through a batch of N steps.")
    .argument("<project>", "path to the project directory the builder works in")
    .option("-s, --steps <n>", "number of tickets to drive; may stop within a stack")
    .option("--stacks <n>", "number of complete eligible delivery stacks to build")
    .option("-a, --agent <agent>", "builder agent (claude | codex)")
    .option("-m, --model <model>", "override the builder's model")
    .option("-r, --resume <sessionId>", "resume a prior builder session")
    .option("--recover-run <id>", "continue an existing master recovery run ID")
    .option("--recovery-mode <mode>", "frozen build:resume mode (internal recovery receipt)")
    .option("--accept-handoff <generation>", "accept a pre-staged cumulative handoff generation")
    .option("--accept-handoff-role <role>", "role owning the pre-staged handoff (builder | qa)", "builder")
    .option("--continue", "resume the most recent logged session for this project")
    .option("-t, --tickets <path>", "path to ticket file (.md, .txt, .yaml, …) — passed to the builder as context")
    .option("-y, --yes", "skip pre-flight confirmation prompt")
    .option("--effort <level>", "reasoning effort level (low|medium|high|xhigh)")
    .option("--fast", "fast mode — lower latency (maps to effort=low for codex)")
    .option("--no-qa", "disable per-ticket QA review (enabled by default)")
    .option("--branch-per-ticket", "run each selected structured ticket in an isolated git worktree and branch")
    .option("--no-branch-per-ticket", "disable saved branch-per-ticket defaults for this run")
    .option("--create-pr", "push each successful ticket branch and create a GitHub PR (implies --branch-per-ticket)")
    .option("--no-create-pr", "disable saved PR/MR creation defaults for this run")
    .option("--completion <mode>", "ticket branch completion behavior (pr | auto-merge | direct-merge | none)")
    .option("--merge-method <method>", "merge method for local or remote completion (squash | merge | rebase)")
    .option("--provider <provider>", "PR/MR provider for branch completion (auto | github | gitlab)")
    .option("--auto-merge-wait", "wait for dependency PR/MRs to merge before starting dependent tickets")
    .option("--no-auto-merge-wait", "do not wait for dependency PR/MRs before dependent tickets")
    .option("--auto-merge-timeout-minutes <n>", "auto-merge dependency wait timeout in minutes (blank means no timeout)")
    .option("--base <ref>", "base ref for root ticket branches (default: current branch or HEAD)")
    .option("--branch-prefix <prefix>", "branch name prefix for ticket branches")
    .option("--show-session-cost", "show authoritative cost or trustworthy cumulative session tokens for Builder and QA")
    .option("--hide-session-cost", "hide session cost/token usage for Builder and QA")
    .option("--auto-compact-threshold <percent>", "initial Builder context compaction threshold (1-99)")
    .option("--max-branch-depth <n>", "maximum selected branch stack depth", "5")
    .option("--pr-ready", "create ready-for-review PRs instead of draft PRs")
    .option("--keep-worktrees", "keep successful ticket worktrees for inspection")
    .option("--ticket <id>", "select one new ticket, or identify recovery tickets with --resume/--continue/--recover-run", collectTicket, [])
    .option("--skip-delivery-unit <id>", "skip one unfinished delivery unit for this run", collectTicket, [])
    .action(async (project: string, opts, command: Command) => {
      const requestedTicketIds = (opts.ticket as string[] | undefined) ?? [];
      const recoveryIntent = Boolean(opts.resume || opts.continue || opts.recoverRun);
      if (!recoveryIntent && requestedTicketIds.length > 1) fail("new-ticket selection supports exactly one --ticket");
      if (!recoveryIntent && requestedTicketIds.length === 1 && opts.steps === undefined && opts.stacks === undefined) opts.steps = "1";
      if (!recoveryIntent && requestedTicketIds.length && opts.stacks !== undefined) fail("new-ticket selection cannot be combined with --stacks");
      if (opts.steps !== undefined && opts.stacks !== undefined) fail("--steps and --stacks are mutually exclusive");
      if (opts.steps === undefined && opts.stacks === undefined) {
        if (opts.yes || !process.stdin.isTTY || !process.stdout.isTTY) fail("noninteractive/--yes runs require exactly one of --steps or --stacks");
        const mode = await select({ message: "Build tickets or complete delivery stacks?", options: [
          { value: "steps", label: "Tickets (Recommended)" }, { value: "stacks", label: "Complete stacks" },
        ] });
        if (isCancel(mode)) process.exit(0);
        const count = await text({ message: mode === "steps" ? "How many tickets?" : "How many complete stacks?", validate: (value) => Number.isInteger(Number(value)) && Number(value) > 0 ? undefined : "Enter a positive integer" });
        if (isCancel(count)) process.exit(0);
        opts[mode as "steps" | "stacks"] = String(count);
      }
      let steps = Number.parseInt(opts.steps ?? "0", 10);
      const stackCount = opts.stacks === undefined ? undefined : Number.parseInt(opts.stacks, 10);
      if (stackCount !== undefined && (!Number.isInteger(stackCount) || stackCount < 1)) fail("--stacks must be a positive integer");
      if (stackCount !== undefined) steps = 0;
      if (!Number.isInteger(steps) || steps < 1) {
        if (stackCount === undefined) fail("--steps must be a positive integer");
      }
      const VALID_EFFORT = ["low", "medium", "high", "xhigh"];
      if (opts.effort && !VALID_EFFORT.includes(opts.effort)) {
        fail(`unknown effort "${opts.effort}" — choose: ${VALID_EFFORT.join(" | ")}`);
      }

      const cwd = resolve(project);
      if (!existsSync(cwd)) fail(`project directory not found: ${cwd}`);
      const recoveryRecord = opts.recoverRun ? readBuildRuns(cwd).find((run) => run.runId === opts.recoverRun) : undefined;
      if (opts.recoverRun && !recoveryRecord) fail(`recoverable build run not found: ${opts.recoverRun}`);
      const autoApprovePlanUpdates = recoveryRecord
        ? recoveryRecord.recoveryDecision?.planUpdateApproval === "auto"
        : Boolean(opts.yes);
      if (opts.recoveryMode) {
        const allowed = ["exact-session", "fresh-with-handoff", "fresh-recovery-only", "guided-recovery"];
        if (!allowed.includes(String(opts.recoveryMode))) fail(`unknown frozen recovery mode ${String(opts.recoveryMode)}`);
        if (!recoveryRecord?.recoveryDecision || recoveryRecord.recoveryDecision.mode !== opts.recoveryMode) fail("recovery mode no longer matches the persisted decision receipt; Rafi will not substitute a path");
      }
      if (opts.acceptHandoff && !recoveryRecord) fail("--accept-handoff requires --recover-run");
      let pendingHandoffGeneration = opts.acceptHandoff === undefined ? undefined : Number(opts.acceptHandoff);
      if (pendingHandoffGeneration !== undefined && (!Number.isSafeInteger(pendingHandoffGeneration) || pendingHandoffGeneration < 1)) fail("--accept-handoff must be a positive generation");
      const pendingHandoffRole = String(opts.acceptHandoffRole ?? "builder");
      if (pendingHandoffRole !== "builder" && pendingHandoffRole !== "qa") fail("--accept-handoff-role must be builder or qa");
      const roleDefaults = readAgentDefaults(cwd);
      let deliveryRun: DeliveryUnitProgress | undefined;
      let deliveryConfig: DeliveryConfig | undefined;
      let selectedStacks: DeliveryStack[] = [];
      let selectedStackTickets: string[] | undefined;
      if (isTicketsInitialized(cwd)) {
        const delivery = loadDeliveryConfig(cwd); deliveryConfig = delivery;
        if (delivery) {
          const earlyConfig = loadTicketsConfig(cwd);
          const earlyPaths = resolveTicketPaths(earlyConfig, cwd);
          const earlyDb = new StateDb(earlyPaths.stateDb);
          const earlyStates = earlyDb.getAllStates();
          earlyDb.close();
          if (stackCount !== undefined) {
            const earlyTickets = loadTickets(earlyPaths.tickets);
            const selection = selectStacksForRun(delivery, earlyTickets, earlyStates, stackCount);
            if (selection.error) fail(selection.error);
            selectedStacks = selection.stacks; selectedStackTickets = selection.tickets; steps = selection.tickets.length;
            opts.branchPerTicket = true; opts.completion = "pr";
            const providers = new Set(selection.stacks.flatMap((stack) => stack.units.map((id) => delivery.units.find((unit) => unit.id === id)?.provider)).filter((provider) => provider === "github" || provider === "gitlab"));
            if (providers.size !== 1) fail("selected stacks must use one explicit GitHub or GitLab provider per run");
            opts.provider = [...providers][0];
          } else deliveryRun = selectDeliveryUnitForRun(delivery, earlyStates, (opts.skipDeliveryUnit as string[] | undefined) ?? []);
          if (deliveryRun?.state === "resume" && !opts.yes && process.stdin.isTTY && process.stdout.isTTY) {
            const answer = await select({ message: `Resume unfinished delivery unit ${deliveryRun.unit.id} (${deliveryRun.remaining.length} remaining)?`, options: [
              { value: "resume", label: "Resume (Recommended)" }, { value: "skip", label: "Skip for this run" },
            ] });
            if (isCancel(answer)) process.exit(0);
            if (answer === "skip") deliveryRun = selectDeliveryUnitForRun(delivery, earlyStates, [deliveryRun.unit.id, ...((opts.skipDeliveryUnit as string[] | undefined) ?? [])]);
          }
        }
      }
      if (stackCount !== undefined && selectedStacks.length !== stackCount) fail("--stacks requires explicit eligible stacks in .tickets/delivery.yaml");
      const branchDefaults = resolveStartBranchDefaults(cwd, opts as Record<string, unknown>, command, deliveryRun);
      const resolvedPrefix = resolveStartBranchPrefix(cwd, opts as Record<string, unknown>, recoveryRecord);
      const branchPrefix = resolvedPrefix.value;
      if (opts.showSessionCost && opts.hideSessionCost) fail("choose either --show-session-cost or --hide-session-cost");
      const sessionCostOverride = opts.showSessionCost ? true : opts.hideSessionCost ? false : undefined;
      const thresholdOverride = opts.autoCompactThreshold === undefined ? undefined : Number(opts.autoCompactThreshold);
      if (thresholdOverride !== undefined && (!Number.isInteger(thresholdOverride) || thresholdOverride < 1 || thresholdOverride > 99)) fail("--auto-compact-threshold must be an integer from 1 to 99");
      let agent: AgentRuntime;
      try {
        agent = resolveAgentForProject(cwd, (opts.agent as string | undefined) ?? roleDefaults.builder?.make);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
      let model = (opts.model as string | undefined) ?? explicitDefaultValue(roleDefaults.builder?.model);
      let agentExecutable: string | undefined;
      const builderEffort = (opts.effort as EffortLevel | undefined) ?? explicitEffort(roleDefaults.builder?.reasoning);
      const builderFast = opts.fast as boolean | undefined ?? roleDefaults.builder?.fast;
      let qaAgent = resolveAgentForProject(cwd, roleDefaults.qa?.make);
      let qaModel = explicitDefaultValue(roleDefaults.qa?.model);
      let qaExecutable: string | undefined;
      const qaEffort = explicitEffort(roleDefaults.qa?.reasoning);
      const qaFast = roleDefaults.qa?.fast ?? false;
      const settingsRevision = roleDefaults.revision ?? 0;

      const configuredTrackerPath = isTicketsInitialized(cwd)
        ? loadTicketsConfig(cwd).paths.progressDoc
        : undefined;
      const TRACKER_SEARCH_PATHS = unique([
        configuredTrackerPath,
        "docs/ticket-progress.md",
        "ticket-progress.md",
      ].filter(Boolean) as string[]);
      let ticketsContent: string | undefined;
      let trackerRelPath: string | undefined;

      if (opts.tickets) {
        const ticketPath = resolve(opts.tickets as string);
        if (!existsSync(ticketPath)) fail(`ticket file not found: ${ticketPath}`);
        ticketsContent = readFileSync(ticketPath, "utf8");
        trackerRelPath = relative(cwd, ticketPath);
      } else {
        for (const rel of TRACKER_SEARCH_PATHS) {
          const abs = join(cwd, rel);
          if (existsSync(abs)) {
            ticketsContent = readFileSync(abs, "utf8");
            trackerRelPath = rel;
            break;
          }
        }
      }

      if (opts.resume && opts.continue) {
        fail("choose either --resume <sessionId> or --continue, not both");
      }

      const branchMode = branchDefaults.branchMode;
      const savedWorkMode = loadTicketSetupConfig(cwd)?.build.branch_strategy ?? "current";
      const workModeSource = recoveryRecord?.runDecisions ? "resume" as const : branchMode && savedWorkMode === "current" ? "cli" as const : "project" as const;
      if (!recoveryRecord && branchMode && savedWorkMode === "current") {
        console.log(`foreman: run override — project uses Current branch — Rafi works here; you manage Git; this run explicitly uses an isolated workflow`);
      }
      const continueTickets = recoveryIntent
        ? requestedTicketIds.length > 0
          ? requestedTicketIds
          : branchDefaults.branchMode && recoveryRecord
            ? [...recoveryRecord.tickets]
            : []
        : [];
      let selectedNewTicket = !recoveryIntent ? requestedTicketIds[0] : undefined;
      const maxBranchDepth = Number.parseInt(opts.maxBranchDepth, 10);
      if (!Number.isInteger(maxBranchDepth) || maxBranchDepth < 1) {
        fail("--max-branch-depth must be a positive integer");
      }
      if (!branchMode && continueTickets.length > 1) {
        fail("current-branch build recovery supports exactly one --ticket");
      }
      if (branchMode) {
        if (opts.resume && continueTickets.length > 1) {
          fail("--resume <sessionId> in branch mode supports exactly one --ticket; use --continue for multiple tickets");
        }
        if ((opts.resume || opts.continue) && continueTickets.length === 0 && !recoveryRecord) {
          fail(branchContinueTicketHelp(cwd, opts.resume ? "--resume" : "--continue"));
        }
        if (opts.tickets) fail("--tickets is not supported with an isolated branch run; initialize and use .tickets/tickets.yaml");
        if (!isTicketsInitialized(cwd)) fail("isolated branch runs require initialized .tickets/ (run ai-foreman tickets init)");
        if (branchDefaults.createReview && !branchDefaults.reviewProvider) {
          fail("PR/MR completion is enabled but no GitHub or GitLab origin remote was detected; pass --provider github|gitlab or --completion none");
        }
      }

      const resumeSessionId =
        (opts.resume as string | undefined) ??
        (!branchMode && opts.continue ? findLastSessionId(join(cwd, ".foreman")) : undefined);
      if (!branchMode && opts.continue && !resumeSessionId) {
        fail(`no previous session id found under ${join(cwd, ".foreman")}`);
      }
      let resumeSessionRef: ProviderSessionRefV1 | undefined;
      if (!branchMode && resumeSessionId) {
        if (recoveryRecord) resumeSessionRef = buildRunSessionBinding(recoveryRecord, "builder", resumeSessionId);
        if (!resumeSessionRef) {
          try {
            resumeSessionRef = resolveUniqueSessionBinding(readBuildRuns(cwd).flatMap((run) => run.sessionBindings ?? []), resumeSessionId);
          } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
        }
        if (!resumeSessionRef) fail(`session ${resumeSessionId} has no stored location-scoped binding; choose fresh recovery with a validated handoff instead of an unverifiable exact resume`);
      }
      if (selectedNewTicket) {
        if (!isTicketsInitialized(cwd)) fail("--ticket requires initialized .tickets/ (run `rafi tickets init`)");
        const eligibilityConfig = loadTicketsConfig(cwd);
        const eligibilityPaths = resolveTicketPaths(eligibilityConfig, cwd);
        const eligibilityDefs = loadTickets(eligibilityPaths.tickets);
        const eligibilityDb = new StateDb(eligibilityPaths.stateDb);
        const eligibilityStates = eligibilityDb.getAllStates();
        eligibilityDb.close();
        const activeLease = readCurrentWorkflowLease(cwd);
        let assessment = evaluateTicketEligibility({
          tickets: eligibilityDefs,
          states: eligibilityStates,
          implementationLimit: eligibilityConfig.implementationLimit,
          delivery: deliveryConfig,
          activeLease: activeLease ? { runId: activeLease.runId } : undefined,
        }, selectedNewTicket);
        if (!assessment.eligible) {
          console.error(`foreman: ${selectedNewTicket} is not eligible:`);
          for (const blocker of assessment.blockers) console.error(`  - ${blocker.detail}`);
          const dependency = assessment.eligibleDependencies[0];
          if (!dependency || opts.yes || !process.stdin.isTTY || !process.stdout.isTTY) fail(`cannot start ${selectedNewTicket}`);
          const answer = await select({ message: `Start eligible dependency ${dependency.id}: ${dependency.title} instead?`, options: [
            { value: "dependency", label: `Start ${dependency.id} (Recommended)` },
            { value: "cancel", label: "Cancel" },
          ] });
          if (isCancel(answer) || answer === "cancel") { console.log("ai-foreman: cancelled; nothing changed"); return; }
          selectedNewTicket = dependency.id;
          assessment = evaluateTicketEligibility({ tickets: eligibilityDefs, states: eligibilityStates, implementationLimit: eligibilityConfig.implementationLimit, delivery: deliveryConfig }, selectedNewTicket);
        }
        const recommended = eligibleTickets({ tickets: eligibilityDefs, states: eligibilityStates, implementationLimit: eligibilityConfig.implementationLimit, delivery: deliveryConfig })[0];
        if (assessment.eligible && recommended && recommended.id !== selectedNewTicket) {
          console.log(`foreman: recommended ${recommended.id}: ${recommended.title}`);
          console.log(`foreman: requested ${assessment.ticket!.id}: ${assessment.ticket!.title}`);
          if (!opts.yes) {
            if (!process.stdin.isTTY || !process.stdout.isTTY) fail(`starting non-recommended ${selectedNewTicket} requires --yes`);
            const answer = await select({ message: `Start ${selectedNewTicket} anyway?`, options: [
              { value: "start", label: `Start ${selectedNewTicket}` }, { value: "cancel", label: "Cancel" },
            ] });
            if (isCancel(answer) || answer === "cancel") { console.log("ai-foreman: cancelled; nothing changed"); return; }
          }
        }
      }
      const recoveryTicket = !branchMode && recoveryRecord ? continueTickets[0] : undefined;
      const preferredTicket = selectedNewTicket ?? recoveryTicket;

      const config = loadConfig(join(cwd, "foreman.yaml"));
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const logPath = join(cwd, ".foreman", `${stamp}.jsonl`);
      const log = new Log(logPath);

      const qaEnabled = opts.qa !== false && config.qa.enabled !== false;

      const createRawBuilder = async (builderCwd: string, sessionId?: string, sessionRef?: ProviderSessionRefV1): Promise<BuilderAdapter> => {
        const builderPolicy = new PermissionPolicy(config.permissions, builderCwd, { currentBranchWorkflow: !branchMode });
        const roleBundle = loadRoleBundle("builder", { projectDir: builderCwd });
        const adapterOpts = {
          cwd: builderCwd,
          runtimeExecutable: agentExecutable,
          runtimePhase: "builder" as const,
          model,
          ...(sessionRef ? { resumeSessionRef: sessionRef } : sessionId ? { resumeSessionId: sessionId } : {}),
          configRoot: cwd,
          sessionRole: "builder" as const,
          sessionStream: sessionRef?.stream ?? "builder",
          sessionGeneration: sessionRef?.generation ?? 0,
          workspaceIdentity: !branchMode ? captureCurrentWorkflowSessionIdentity(builderCwd) : captureWorkspaceIdentity(builderCwd),
          ticketId: sessionRef?.ticketId,
          deliveryUnitId: sessionRef?.deliveryUnitId,
          permission: createPermissionHandler(builderPolicy, log),
          effort: builderEffort,
          fast: builderFast,
          systemPromptAppend: roleBundle.system || undefined,
          skills: roleBundle.skills.length > 0 ? roleBundle.skills : undefined,
          autoCompactThresholdPercent: thresholdOverride ?? roleDefaults.builder?.auto_compact_threshold_percent ?? 50,
        };
        const adapter: BuilderAdapter = agent === "codex"
          ? new CodexAdapter(adapterOpts)
          : await ClaudeAdapter.create(adapterOpts);
        if (sessionRef && adapter.agent === "codex") {
          const availability = await adapter.validateSession!();
          if (availability.status !== "available") {
            await adapter.close().catch(() => {});
            throw new SessionUnavailableError({ runtime: "codex", phase: "preflight", dispatchState: "not-sent", executable: agentExecutable ?? "codex", cwd: builderCwd, diagnostics: availability.detail ?? `Codex session ${sessionRef.sessionId} is ${availability.status}`, availability });
          }
        }
        await prepareNativeAutoCompaction(adapter);
        return !branchMode ? new CurrentWorkflowGuardAdapter(adapter, builderCwd) : adapter;
      };

      let activeContinuityRunId: string | undefined;
      let liveStatusReporter: AgentStatusReporter | undefined;
      let activeBuilderForStatus: (() => BuilderAdapter) | undefined;
      const resolvedContinuitySettings = (role: "builder" | "qa"): ResolvedAgentSettings => role === "builder" ? {
        role, source: roleDefaults.builder ? "project" : "provider", make: agent, model: model ?? "default",
        reasoning: builderEffort ?? "default", fast: Boolean(builderFast), session_strategy: roleDefaults.builder?.session_strategy ?? "compact",
        settings_revision: settingsRevision, display_session_cost: sessionCostOverride ?? roleDefaults.builder?.display_session_cost ?? false,
        auto_compact_threshold_percent: thresholdOverride ?? roleDefaults.builder?.auto_compact_threshold_percent ?? 50,
        compact_maximum: roleDefaults.builder?.compact_maximum ?? 10,
      } : {
        role, source: roleDefaults.qa ? "project" : "provider", make: qaAgent, model: qaModel ?? "default",
        reasoning: qaEffort ?? "default", fast: qaFast, session_strategy: roleDefaults.qa?.session_strategy ?? "compact",
        settings_revision: settingsRevision, display_session_cost: sessionCostOverride ?? roleDefaults.qa?.display_session_cost ?? false,
        auto_compact_threshold_percent: roleDefaults.qa?.auto_compact_threshold_percent ?? 50,
        compact_maximum: roleDefaults.qa?.compact_maximum ?? 10,
      };

      const liveRoleSettings = (role: "builder" | "qa", base: ResolvedAgentSettings): ResolvedAgentSettings => {
        const live = readAgentDefaults(cwd);
        const revision = live.revision ?? 0;
        if (revision <= base.settings_revision) return base;
        const defaults = role === "builder" ? live.builder : live.qa;
        return {
          ...base,
          source: defaults ? "project" : base.source,
          make: defaults?.make ?? base.make,
          model: defaults?.model ?? base.model,
          reasoning: defaults?.reasoning ?? base.reasoning,
          fast: defaults?.fast ?? base.fast,
          session_strategy: defaults?.session_strategy ?? base.session_strategy,
          display_session_cost: defaults?.display_session_cost ?? base.display_session_cost,
          auto_compact_threshold_percent: defaults?.auto_compact_threshold_percent ?? base.auto_compact_threshold_percent,
          compact_maximum: defaults?.compact_maximum ?? base.compact_maximum,
          settings_revision: revision,
        };
      };

      const settingsForRequestedRuntime = (
        base: ResolvedAgentSettings,
        requestedRuntime?: "claude" | "codex",
      ): ResolvedAgentSettings => requestedRuntime && requestedRuntime !== base.make
        ? { ...base, make: requestedRuntime, model: "default", source: "cli" }
        : base;

      const handoffRecoveryOptions = (role: "builder" | "qa") => ({
        allowProviderSwitch: true,
        desktopNotifications: config.notifications.enabled,
        terminalBell: config.notifications.terminal_bell,
        onAccepted: (accepted: { successor: BuilderAdapter }) => {
          if (role === "builder" && accepted.successor.agent !== agent) {
            agent = accepted.successor.agent;
            model = undefined;
            agentExecutable = undefined;
          }
          if (role === "qa" && accepted.successor.agent !== qaAgent) {
            qaAgent = accepted.successor.agent;
            qaModel = undefined;
            qaExecutable = undefined;
          }
        },
      });

      const acceptedRuntimeSettings = (
        current: ResolvedAgentSettings,
        make: "claude" | "codex",
        acceptedModel: string | undefined,
      ): ResolvedAgentSettings => current.make === make && current.model === (acceptedModel ?? "default")
        ? current
        : { ...current, make, model: acceptedModel ?? "default", source: "cli" };
      const withRunLocalAcceptedRuntimes = (run: BuildRunRecordV2): BuildRunRecordV2 => ({
        ...run,
        ...(run.builder ? { builder: { ...run.builder, settings: acceptedRuntimeSettings(run.builder.settings, agent, model) } } : {}),
        ...(run.qa ? { qa: { ...run.qa, settings: acceptedRuntimeSettings(run.qa.settings, qaAgent, qaModel) } } : {}),
      });

      const createBuilderForSettings = async (builderCwd: string, settings: ResolvedAgentSettings): Promise<BuilderAdapter> => {
        const ready = await ensureRuntimeReadyForCommand(builderCwd, settings.make, {
          label: "live Builder settings",
          yes: true,
          allowSwitch: false,
          model: settings.model === "default" ? undefined : settings.model,
        });
        const policy = new PermissionPolicy(config.permissions, builderCwd, { currentBranchWorkflow: !branchMode });
        const roleBundle = loadRoleBundle("builder", { projectDir: builderCwd });
        const adapterOptions = {
          cwd: builderCwd,
          configRoot: cwd,
          sessionRole: "builder" as const,
          sessionStream: "builder",
          workspaceIdentity: !branchMode ? captureCurrentWorkflowSessionIdentity(builderCwd) : captureWorkspaceIdentity(builderCwd),
          runtimeExecutable: ready.executable,
          runtimePhase: "builder" as const,
          model: settings.model === "default" ? undefined : settings.model,
          permission: createPermissionHandler(policy, log),
          effort: explicitEffort(settings.reasoning),
          fast: settings.fast,
          systemPromptAppend: roleBundle.system || undefined,
          skills: roleBundle.skills.length > 0 ? roleBundle.skills : undefined,
          autoCompactThresholdPercent: settings.auto_compact_threshold_percent,
        };
        const created = settings.make === "codex" ? new CodexAdapter(adapterOptions) : await ClaudeAdapter.create(adapterOptions);
        await prepareNativeAutoCompaction(created);
        return !branchMode ? new CurrentWorkflowGuardAdapter(created, builderCwd) : created;
      };

      const createQaForSettings = async (qaCwd: string, settings: ResolvedAgentSettings): Promise<BuilderAdapter> => {
        const ready = await ensureRuntimeReadyForCommand(qaCwd, settings.make, {
          label: "live QA settings",
          yes: true,
          allowSwitch: false,
          model: settings.model === "default" ? undefined : settings.model,
        });
        const policy = new PermissionPolicy(config.permissions, qaCwd);
        const roleBundle = loadRoleBundle("qa", { projectDir: qaCwd });
        const adapterOptions = {
          cwd: qaCwd,
          configRoot: cwd,
          sessionRole: "qa" as const,
          sessionStream: "qa",
          runtimeExecutable: ready.executable,
          runtimePhase: "qa" as const,
          model: settings.model === "default" ? undefined : settings.model,
          permission: createPermissionHandler(policy, log),
          effort: explicitEffort(settings.reasoning),
          fast: settings.fast,
          systemPromptAppend: `${roleBundle.system}\n\nYou are an independent QA reviewer. Do not edit source, tickets, configuration, or project documentation. You may run tests and create only harmless ignored caches or coverage output.`,
          skills: roleBundle.skills.length > 0 ? roleBundle.skills : undefined,
          autoCompactThresholdPercent: settings.auto_compact_threshold_percent,
        };
        const created = settings.make === "codex" ? new CodexAdapter(adapterOptions) : await ClaudeAdapter.create(adapterOptions);
        await prepareNativeAutoCompaction(created);
        return created;
      };

      const createRecoveringBuilder = async (builderCwd: string, sessionId?: string, sessionRef?: ProviderSessionRefV1): Promise<BuilderAdapter> => {
        if (sessionId && !sessionRef) {
          const availability = {
            version: 1 as const,
            status: "unknown" as const,
            checkedAt: new Date().toISOString(),
            reason: "legacy-unscoped" as const,
            detail: "Builder recovery cannot authorize an exact provider resume from a raw session ID",
          };
          throw new SessionUnavailableError({
            runtime: agent,
            phase: "preflight",
            dispatchState: "not-sent",
            executable: agentExecutable ?? agent,
            cwd: builderCwd,
            diagnostics: availability.detail,
            availability,
          });
        }
        const initial = await createRawBuilder(builderCwd, sessionId, sessionRef);
        return new RecoveringAdapter({
          initial,
          runtime: agent,
          label: "builder turn",
          enabled: Boolean(process.stdin.isTTY && process.stdout.isTTY),
          allowSwitch: !(opts.resume || opts.continue),
          recreate: async (nextRuntime, resumeSessionId, resumeRef) => {
            const nextReady = await ensureRuntimeReadyForCommand(builderCwd, nextRuntime, {
              label: "builder recovery",
              allowSwitch: false,
              model: nextRuntime === agent ? model : undefined,
            });
            agent = nextReady.runtime;
            model = nextReady.model;
            agentExecutable = nextReady.executable;
            return createRawBuilder(builderCwd, resumeSessionId, resumeRef);
          },
        });
      };

      const continuousBuilder = (
        adapter: BuilderAdapter,
        builderCwd: string,
        runId: string,
        settings = resolvedContinuitySettings("builder"),
        replaceRecoveryLeaseAfterCheckpoint = false,
      ): ContinuityAdapter => new ContinuityAdapter({
        adapter,
        projectDir: cwd,
        runId,
        role: "builder",
        settings,
        authoritativeStateRevision: () => readAgentDefaults(cwd).revision ?? settings.settings_revision,
        createSuccessor: () => createRecoveringBuilder(builderCwd),
        replaceRecoveryLeaseAfterCheckpoint,
        recoverWithHandoff: async ({ reason, reconstruction, predecessor }) => {
          const effectiveSettings = liveRoleSettings("builder", settings);
          const context = await predecessor.contextUsage?.().catch(() => undefined);
          const nativeUsage = await predecessor.sessionUsage?.().catch(() => undefined);
          const sessionId = predecessor.sessionId();
          const recoveryDb = new WorkflowDb(cwd);
          let compactionCount = 0;
          try { compactionCount = recoveryDb.successfulCompactionCount(runId, "builder", predecessor.sessionRef?.() ?? sessionId); }
          finally { recoveryDb.close(); }
          const transfer = await new HandoffService(cwd).transfer({
            runId, role: "builder", reason, predecessorSessionId: sessionId, predecessorSessionRef: predecessor.sessionRef?.(),
            allowNonCurrentContinuity: true,
            roleState: { recovery: "double-invalid-continuity", reconstruction, ...(context ? { contextSample: context } : { occupancy: "unavailable" }) },
            ...(nativeUsage ? { sessionUsage: {
              version: 1 as const, runId, role: "builder" as const, provider: predecessor.agent,
              providerSessionId: sessionId, observedAt: nativeUsage.observedAt, source: nativeUsage.source,
              cumulativeInputTokens: nativeUsage.inputTokens, cumulativeOutputTokens: nativeUsage.outputTokens,
              cumulativeTotalTokens: nativeUsage.totalTokens, authoritativeCostUsd: nativeUsage.authoritativeCostUsd,
            } } : {}),
            compactionCount, compactMaximum: effectiveSettings.compact_maximum,
            resources: [{ label: "continuity-reconstruction", content: reconstruction, authoritative: true }],
          }, (_handoff, runtime) => createBuilderForSettings(builderCwd, settingsForRequestedRuntime(effectiveSettings, runtime)), handoffRecoveryOptions("builder"));
          log.write("handoff-transfer", {
            role: "builder", reason, recovery: "double-invalid-continuity", generation: transfer.manifest.generation,
            predecessorSessionId: transfer.manifest.predecessorSessionId, successorSessionId: transfer.successorSessionId,
            acceptanceCheckpointDigest: transfer.acceptanceCheckpointDigest,
          });
          return transfer.successor;
        },
        handleHandoffRequest: async (output, predecessor, frozenAction) => {
          const request = parseBuilderHandoffRequest(output);
          if (!request) return undefined;
          const effectiveSettings = liveRoleSettings("builder", settings);
          const context = await predecessor.contextUsage?.().catch(() => undefined);
          const nativeUsage = await predecessor.sessionUsage?.().catch(() => undefined);
          const sessionId = predecessor.sessionId();
          const countDb = new WorkflowDb(cwd);
          let compactionCount = 0;
          try {
            const revision = countDb.continuityHead(runId, "builder")?.authoritativeStateRevision ?? settings.settings_revision;
            countDb.appendContinuityEvent({ runId, role: "builder", kind: "builder_requested_handoff_delta", payload: request.delta, authoritativeStateRevision: revision });
            countDb.publishContinuityCheckpoint({ runId, role: "builder", delta: request.delta, authoritativeStateRevision: revision });
            compactionCount = countDb.successfulCompactionCount(runId, "builder", predecessor.sessionRef?.() ?? sessionId);
          }
          finally { countDb.close(); }
          const transfer = await new HandoffService(cwd).transfer({
            runId,
            role: "builder",
            reason: request.reason,
            predecessorSessionId: sessionId,
            predecessorSessionRef: predecessor.sessionRef?.(),
            requestedByBuilder: true,
            roleState: {
              ...request.roleState,
              frozenActionDigest: createHash("sha256").update(frozenAction).digest("hex"),
              ...(context ? { occupancy: context } : { occupancy: "unavailable" }),
            },
            ...(nativeUsage ? { sessionUsage: {
              version: 1 as const, runId, role: "builder" as const, provider: predecessor.agent,
              providerSessionId: sessionId, observedAt: nativeUsage.observedAt, source: nativeUsage.source,
              cumulativeInputTokens: nativeUsage.inputTokens, cumulativeOutputTokens: nativeUsage.outputTokens,
              cumulativeTotalTokens: nativeUsage.totalTokens, authoritativeCostUsd: nativeUsage.authoritativeCostUsd,
            } } : {}),
            compactionCount,
            compactMaximum: effectiveSettings.compact_maximum,
            resources: [{ label: "frozen-action", content: frozenAction, authoritative: true }],
          }, (_handoff, runtime) => createBuilderForSettings(builderCwd, settingsForRequestedRuntime(effectiveSettings, runtime)), handoffRecoveryOptions("builder"));
          log.write("handoff-transfer", {
            requestedByBuilder: true, reason: request.reason, generation: transfer.manifest.generation,
            predecessorSessionId: transfer.manifest.predecessorSessionId, successorSessionId: transfer.successorSessionId,
            acceptanceCheckpointDigest: transfer.acceptanceCheckpointDigest,
          });
          return transfer.successor;
        },
      });

      const createBuilder = async (builderCwd: string, sessionId?: string, sessionRef?: ProviderSessionRefV1): Promise<BuilderAdapter> => {
        const recoveryMode = String(opts.recoveryMode ?? "");
        const effectiveSessionId = recoveryMode && recoveryMode !== "exact-session" ? undefined : sessionId;
        let adapter = await createRecoveringBuilder(builderCwd, effectiveSessionId, effectiveSessionId ? sessionRef : undefined);
        if (pendingHandoffGeneration !== undefined && pendingHandoffRole === "builder" && activeContinuityRunId === recoveryRecord?.runId) {
          const service = new HandoffService(cwd);
          const staged = service.loadStaged(recoveryRecord!.runId, pendingHandoffGeneration);
          const accepted = await service.acceptStagedWithRecovery(
            staged,
            adapter,
            (_handoff, runtime) => createBuilderForSettings(builderCwd, settingsForRequestedRuntime(resolvedContinuitySettings("builder"), runtime)),
            handoffRecoveryOptions("builder"),
          );
          adapter = accepted.successor;
          pendingHandoffGeneration = undefined;
          log.write("recovery-handoff-accepted", { role: "builder", generation: accepted.manifest.generation, successorSessionId: accepted.successorSessionId, acceptanceCheckpointDigest: accepted.acceptanceCheckpointDigest });
        }
        return activeContinuityRunId ? continuousBuilder(
          adapter,
          builderCwd,
          activeContinuityRunId,
          undefined,
          String(opts.recoveryMode ?? "") === "fresh-recovery-only" && recoveryRecord?.recoveryDecision?.role !== "qa",
        ) : adapter;
      };

      const applyBuilderSettingsBoundary = async (
        runId: string,
        builderCwd: string,
        input: { adapter: BuilderAdapter; current: ResolvedAgentSettings; next: ResolvedAgentSettings; frozenAction: string },
      ): Promise<BuilderAdapter> => {
        const context = await input.adapter.contextUsage?.().catch(() => undefined);
        const nativeUsage = await input.adapter.sessionUsage?.().catch(() => undefined);
        const sessionId = input.adapter.sessionId();
        const countDb = new WorkflowDb(cwd);
        let compactionCount = 0;
        try { compactionCount = countDb.successfulCompactionCount(runId, "builder", input.adapter.sessionRef?.() ?? sessionId); }
        finally { countDb.close(); }
        const reason = `live settings revision ${input.next.settings_revision} changed Builder provider controls from ${input.current.make}/${input.current.model} to ${input.next.make}/${input.next.model}`;
        const transfer = await new HandoffService(cwd).transfer({
          runId, role: "builder", reason, predecessorSessionId: sessionId, predecessorSessionRef: input.adapter.sessionRef?.(),
          roleState: {
            settingsFrom: input.current, settingsTo: input.next,
            frozenActionDigest: createHash("sha256").update(input.frozenAction).digest("hex"),
            ...(context ? { contextSample: context } : { occupancy: "unavailable" }),
          },
          ...(nativeUsage ? { sessionUsage: {
            version: 1 as const, runId, role: "builder" as const, provider: input.adapter.agent,
            providerSessionId: sessionId, observedAt: nativeUsage.observedAt, source: nativeUsage.source,
            cumulativeInputTokens: nativeUsage.inputTokens, cumulativeOutputTokens: nativeUsage.outputTokens,
            cumulativeTotalTokens: nativeUsage.totalTokens, authoritativeCostUsd: nativeUsage.authoritativeCostUsd,
          } } : {}),
          compactionCount, compactMaximum: input.next.compact_maximum,
          resources: [{ label: "frozen-action", content: input.frozenAction, authoritative: true }],
        }, (_handoff, runtime) => createBuilderForSettings(builderCwd, settingsForRequestedRuntime(input.next, runtime)), handoffRecoveryOptions("builder"));
        log.write("handoff-transfer", {
          role: "builder", reason, settingsRevision: input.next.settings_revision, generation: transfer.manifest.generation,
          predecessorSessionId: transfer.manifest.predecessorSessionId, successorSessionId: transfer.successorSessionId,
          acceptanceCheckpointDigest: transfer.acceptanceCheckpointDigest,
        });
        if (input.adapter instanceof ContinuityAdapter) {
          await input.adapter.adoptValidatedSuccessor(transfer.successor);
          return input.adapter;
        }
        await input.adapter.close().catch(() => {});
        return continuousBuilder(transfer.successor, builderCwd, runId, input.next);
      };

      const createRawQa = async (qaCwd: string, sessionRef?: ProviderSessionRefV1): Promise<BuilderAdapter> => {
        // Isolated QA conversations are intentionally disposable. Resolve live
        // QA settings for each one so a threshold-only update applies to the
        // very next review instead of waiting for a nonexistent session reuse.
        const qaSettings = liveRoleSettings("qa", resolvedContinuitySettings("qa"));
        const ready = await ensureRuntimeReadyForCommand(qaCwd, qaSettings.make, {
          label: "live QA settings",
          yes: true,
          allowSwitch: false,
          model: qaSettings.model === "default" ? undefined : qaSettings.model,
        });
        const qaPolicy = new PermissionPolicy(config.permissions, qaCwd);
        const roleBundle = loadRoleBundle("qa", { projectDir: qaCwd });
        const adapterOpts = {
          cwd: qaCwd,
          configRoot: cwd,
          sessionRole: "qa" as const,
          sessionStream: "qa",
          runtimeExecutable: ready.executable,
          runtimePhase: "qa" as const,
          model: qaSettings.model === "default" ? undefined : qaSettings.model,
          ...(sessionRef ? { resumeSessionRef: sessionRef } : {}),
          sessionGeneration: sessionRef?.generation ?? 0,
          workspaceIdentity: captureWorkspaceIdentity(qaCwd),
          permission: createPermissionHandler(qaPolicy, log),
          effort: explicitEffort(qaSettings.reasoning),
          fast: qaSettings.fast,
          systemPromptAppend: `${roleBundle.system}\n\nYou are an independent QA reviewer. Do not edit source, tickets, configuration, or project documentation. You may run tests and create only harmless ignored caches or coverage output.`,
          skills: roleBundle.skills.length > 0 ? roleBundle.skills : undefined,
          autoCompactThresholdPercent: qaSettings.auto_compact_threshold_percent,
        };
        const created = qaSettings.make === "codex"
          ? new CodexAdapter(adapterOpts)
          : await ClaudeAdapter.create(adapterOpts);
        await prepareNativeAutoCompaction(created);
        return created;
      };

      const createRecoveringQa = async (qaCwd: string, sessionRef?: ProviderSessionRefV1): Promise<BuilderAdapter> => {
        const initial = await createRawQa(qaCwd, sessionRef);
        return new RecoveringAdapter({
          initial,
          runtime: qaAgent,
          label: "QA turn",
          enabled: Boolean(process.stdin.isTTY && process.stdout.isTTY),
          allowSwitch: !sessionRef,
          recreate: async (nextRuntime, resumeSessionId, resumeRef) => {
            const nextReady = await ensureRuntimeReadyForCommand(qaCwd, nextRuntime, {
              label: "QA recovery",
              allowSwitch: false,
              model: nextRuntime === qaAgent ? qaModel : undefined,
            });
            qaAgent = nextReady.runtime;
            qaModel = nextReady.model;
            qaExecutable = nextReady.executable;
            if (resumeSessionId && !resumeRef) {
              const availability = {
                version: 1 as const,
                status: "unknown" as const,
                checkedAt: new Date().toISOString(),
                reason: "legacy-unscoped" as const,
                detail: "QA retry cannot authorize an exact provider resume from a raw session ID",
              };
              throw new SessionUnavailableError({
                runtime: nextRuntime,
                phase: "preflight",
                dispatchState: "not-sent",
                executable: nextReady.executable,
                cwd: qaCwd,
                diagnostics: availability.detail,
                availability,
              });
            }
            return createRawQa(qaCwd, resumeRef);
          },
        });
      };
      const decorateQa = (adapter: BuilderAdapter, qaCwd: string, sessionId?: string, settingsOverride?: ResolvedAgentSettings): BuilderAdapter => {
        const qaSettings = settingsOverride ?? resolvedContinuitySettings("qa");
        const continuous = activeContinuityRunId ? new ContinuityAdapter({
          adapter, projectDir: cwd, runId: activeContinuityRunId, role: "qa", settings: qaSettings,
          authoritativeStateRevision: () => readAgentDefaults(cwd).revision ?? settingsRevision,
          createSuccessor: () => createRecoveringQa(qaCwd),
          replaceRecoveryLeaseAfterCheckpoint: String(opts.recoveryMode ?? "") === "fresh-recovery-only" && recoveryRecord?.recoveryDecision?.role === "qa",
          recoverWithHandoff: async ({ reason, reconstruction, predecessor }) => {
            const effectiveSettings = liveRoleSettings("qa", qaSettings);
            const context = await predecessor.contextUsage?.().catch(() => undefined);
            const nativeUsage = await predecessor.sessionUsage?.().catch(() => undefined);
            const predecessorSessionId = predecessor.sessionId();
            const recoveryDb = new WorkflowDb(cwd);
            let compactionCount = 0;
            try { compactionCount = recoveryDb.successfulCompactionCount(activeContinuityRunId!, "qa", predecessor.sessionRef?.() ?? predecessorSessionId); }
            finally { recoveryDb.close(); }
            const transfer = await new HandoffService(cwd).transfer({
              runId: activeContinuityRunId!, role: "qa", reason, predecessorSessionId, predecessorSessionRef: predecessor.sessionRef?.(),
              allowNonCurrentContinuity: true,
              roleState: { recovery: "double-invalid-continuity", reconstruction, ...(context ? { contextSample: context } : { occupancy: "unavailable" }) },
              ...(nativeUsage ? { sessionUsage: {
                version: 1 as const, runId: activeContinuityRunId!, role: "qa" as const, provider: predecessor.agent,
                providerSessionId: predecessorSessionId, observedAt: nativeUsage.observedAt, source: nativeUsage.source,
                cumulativeInputTokens: nativeUsage.inputTokens, cumulativeOutputTokens: nativeUsage.outputTokens,
                cumulativeTotalTokens: nativeUsage.totalTokens, authoritativeCostUsd: nativeUsage.authoritativeCostUsd,
              } } : {}),
              compactionCount, compactMaximum: effectiveSettings.compact_maximum,
              resources: [{ label: "continuity-reconstruction", content: reconstruction, authoritative: true }],
            }, (_handoff, runtime) => createQaForSettings(qaCwd, settingsForRequestedRuntime(effectiveSettings, runtime)), handoffRecoveryOptions("qa"));
            log.write("handoff-transfer", {
              role: "qa", reason, recovery: "double-invalid-continuity", generation: transfer.manifest.generation,
              predecessorSessionId: transfer.manifest.predecessorSessionId, successorSessionId: transfer.successorSessionId,
              acceptanceCheckpointDigest: transfer.acceptanceCheckpointDigest,
            });
            return transfer.successor;
          },
        }) : adapter;
        return new RoleStatusAdapter(continuous, (active) => liveStatusReporter?.updateState({
          role: "qa", provider: active.agent, model: qaSettings.model, reasoning: qaSettings.reasoning, fast: qaSettings.fast,
          phase: "QA review session", sessionTransition: sessionId ? "resumed QA session" : "QA session", adapter: active,
          settingsRevision: qaSettings.settings_revision, displaySessionCost: qaSettings.display_session_cost,
          compactionCount: () => { const db = new WorkflowDb(cwd); try { return activeContinuityRunId ? db.successfulCompactionCount(activeContinuityRunId, "qa", active.sessionRef?.() ?? active.sessionId()) : 0; } finally { db.close(); } },
          handoffGeneration: () => { const db = new WorkflowDb(cwd); try { return activeContinuityRunId ? db.handoffs(activeContinuityRunId).at(-1)?.generation ?? 0 : 0; } finally { db.close(); } },
        }), () => {
          const active = activeBuilderForStatus?.();
          if (active) liveStatusReporter?.updateState({
            role: "builder", provider: active.agent, model: model ?? "default", reasoning: builderEffort ?? "default", fast: Boolean(builderFast),
            phase: "builder work session", sessionTransition: "builder session", adapter: active,
            settingsRevision, displaySessionCost: sessionCostOverride ?? roleDefaults.builder?.display_session_cost ?? false,
            compactionCount: () => { const db = new WorkflowDb(cwd); try { return activeContinuityRunId ? db.successfulCompactionCount(activeContinuityRunId, "builder", active.sessionRef?.() ?? active.sessionId()) : 0; } finally { db.close(); } },
            handoffGeneration: () => { const db = new WorkflowDb(cwd); try { return activeContinuityRunId ? db.handoffs(activeContinuityRunId).at(-1)?.generation ?? 0 : 0; } finally { db.close(); } },
          });
        });
      };

      const createQa = async (qaCwd: string, sessionId?: string): Promise<BuilderAdapter> => {
        const recoveryMode = String(opts.recoveryMode ?? "");
        // A disposable QA cwd is never eligible for exact reuse, even when a
        // compatibility caller still supplies the previous raw ID.
        const effectiveSessionId = undefined;
        void sessionId;
        let adapter = await createRecoveringQa(qaCwd, effectiveSessionId);
        let explicitRecoveryAccepted = false;
        if (pendingHandoffGeneration !== undefined && pendingHandoffRole === "qa" && activeContinuityRunId === recoveryRecord?.runId) {
          const service = new HandoffService(cwd);
          const staged = service.loadStaged(recoveryRecord!.runId, pendingHandoffGeneration);
          const accepted = await service.acceptStagedWithRecovery(
            staged,
            adapter,
            (_handoff, runtime) => createQaForSettings(qaCwd, settingsForRequestedRuntime(resolvedContinuitySettings("qa"), runtime)),
            handoffRecoveryOptions("qa"),
          );
          adapter = accepted.successor;
          pendingHandoffGeneration = undefined;
          explicitRecoveryAccepted = true;
          log.write("recovery-handoff-accepted", { role: "qa", generation: accepted.manifest.generation, successorSessionId: accepted.successorSessionId, acceptanceCheckpointDigest: accepted.acceptanceCheckpointDigest });
        }
        // A new disposable QA worktree always means a new provider session.
        // Transfer cumulative QA state by accepting a durable handoff in that
        // fresh session; never attach the old session in the new /tmp cwd.
        if (!explicitRecoveryAccepted && activeContinuityRunId && recoveryMode !== "fresh-recovery-only") {
          const stateDb = new WorkflowDb(cwd);
          const priorLease = stateDb.roleMutationLease(activeContinuityRunId, "qa");
          const head = stateDb.continuityHead(activeContinuityRunId, "qa");
          const checkpoint = stateDb.latestContinuityCheckpoint(activeContinuityRunId, "qa");
          const compactionCount = priorLease
            ? stateDb.successfulCompactionCount(activeContinuityRunId, "qa", priorLease.sessionRef ?? priorLease.providerSessionId)
            : 0;
          stateDb.close();
          if (priorLease) {
            if (!head || head.state !== "current" || !checkpoint) {
              await adapter.close().catch(() => {});
              throw new ContinuityRecoveryRequiredError(activeContinuityRunId, "qa", `cannot transfer cumulative QA state from a ${head?.state ?? "missing"} checkpoint`);
            }
            const service = new HandoffService(cwd);
            const staged = service.stage({
              runId: activeContinuityRunId,
              role: "qa",
              reason: "new disposable QA snapshot requires a fresh location-scoped provider session",
              predecessorSessionId: priorLease.providerSessionId,
              predecessorSessionRef: priorLease.sessionRef,
              roleState: { predecessorGeneration: priorLease.generation, successorSnapshotCwd: qaCwd },
              compactionCount,
              compactMaximum: resolvedContinuitySettings("qa").compact_maximum,
            });
            const accepted = await service.acceptStagedWithRecovery(
              staged,
              adapter,
              (_handoff, runtime) => createQaForSettings(qaCwd, settingsForRequestedRuntime(resolvedContinuitySettings("qa"), runtime)),
              handoffRecoveryOptions("qa"),
            );
            adapter = accepted.successor;
            log.write("handoff-transfer", {
              role: "qa", reason: staged.manifest.reason, generation: accepted.manifest.generation,
              predecessorSessionId: staged.manifest.predecessorSessionId, successorSessionId: accepted.successorSessionId,
              acceptanceCheckpointDigest: accepted.acceptanceCheckpointDigest,
            });
          }
        }
        return decorateQa(adapter, qaCwd, effectiveSessionId);
      };

      const applyQaSettingsBoundary = async (
        runId: string,
        qaCwd: string,
        input: { adapter: BuilderAdapter; current: ResolvedAgentSettings; next: ResolvedAgentSettings; frozenAction: string },
      ): Promise<BuilderAdapter> => {
        const context = await input.adapter.contextUsage?.().catch(() => undefined);
        const nativeUsage = await input.adapter.sessionUsage?.().catch(() => undefined);
        const sessionId = input.adapter.sessionId();
        const countDb = new WorkflowDb(cwd);
        let compactionCount = 0;
        try { compactionCount = countDb.successfulCompactionCount(runId, "qa", input.adapter.sessionRef?.() ?? sessionId); }
        finally { countDb.close(); }
        const reason = `live settings revision ${input.next.settings_revision} changed QA provider controls from ${input.current.make}/${input.current.model} to ${input.next.make}/${input.next.model}`;
        const transfer = await new HandoffService(cwd).transfer({
          runId, role: "qa", reason, predecessorSessionId: sessionId, predecessorSessionRef: input.adapter.sessionRef?.(),
          roleState: {
            settingsFrom: input.current, settingsTo: input.next,
            frozenActionDigest: createHash("sha256").update(input.frozenAction).digest("hex"),
            ...(context ? { contextSample: context } : { occupancy: "unavailable" }),
          },
          ...(nativeUsage ? { sessionUsage: {
            version: 1 as const, runId, role: "qa" as const, provider: input.adapter.agent,
            providerSessionId: sessionId, observedAt: nativeUsage.observedAt, source: nativeUsage.source,
            cumulativeInputTokens: nativeUsage.inputTokens, cumulativeOutputTokens: nativeUsage.outputTokens,
            cumulativeTotalTokens: nativeUsage.totalTokens, authoritativeCostUsd: nativeUsage.authoritativeCostUsd,
          } } : {}),
          compactionCount, compactMaximum: input.next.compact_maximum,
          resources: [{ label: "frozen-qa-action", content: input.frozenAction, authoritative: true }],
        }, (_handoff, runtime) => createQaForSettings(qaCwd, settingsForRequestedRuntime(input.next, runtime)), handoffRecoveryOptions("qa"));
        log.write("handoff-transfer", {
          role: "qa", reason, settingsRevision: input.next.settings_revision, generation: transfer.manifest.generation,
          predecessorSessionId: transfer.manifest.predecessorSessionId, successorSessionId: transfer.successorSessionId,
          acceptanceCheckpointDigest: transfer.acceptanceCheckpointDigest,
        });
        await input.adapter.close().catch(() => {});
        return decorateQa(transfer.successor, qaCwd, undefined, input.next);
      };

      const qaSessionBoundary = async (
        adapter: BuilderAdapter,
        frozenAction: string,
        strategy: SessionStrategy,
        qaCwd: string,
      ): Promise<BuilderAdapter> => {
        if (!activeContinuityRunId) throw new Error("QA session boundary requires an active durable run");
        const qaSettings = resolvedContinuitySettings("qa");
        const controller = RoleSessionController.managed({
          projectDir: cwd,
          runId: activeContinuityRunId,
          role: "qa",
          initialSettings: qaSettings,
          historicalCountUncertain: recoveryCompactionHistoryUncertain(cwd, recoveryRecord, activeContinuityRunId, "qa"),
          readSettings: () => liveRoleSettings("qa", qaSettings),
          settingsBoundary: (input) => applyQaSettingsBoundary(activeContinuityRunId!, qaCwd, input),
          settingsAdopted: (settings, active) => liveStatusReporter?.updateState({
            role: "qa", provider: active.agent, model: settings.model, reasoning: settings.reasoning, fast: settings.fast,
            adapter: active, settingsRevision: settings.settings_revision, displaySessionCost: settings.display_session_cost,
            sessionTransition: "adopted live settings",
          }),
          report: (event) => {
            currentActivity()?.update(event.kind, event.detail, { provider: qaSettings.make, model: qaSettings.model });
            log.write("context-lifecycle", { role: "qa", ...event, sample: event.sample });
          },
          handoff: async ({ reason, adapter: predecessor, sample, settings, compactionCount }) => {
            const nativeUsage = await predecessor.sessionUsage?.().catch(() => undefined);
            const transfer = await new HandoffService(cwd).transfer({
              runId: activeContinuityRunId!, role: "qa", reason, predecessorSessionId: predecessor.sessionId(), predecessorSessionRef: predecessor.sessionRef?.(),
              roleState: { frozenActionDigest: createHash("sha256").update(frozenAction).digest("hex"), contextSample: sample },
              ...(nativeUsage ? { sessionUsage: {
                version: 1 as const, runId: activeContinuityRunId!, role: "qa" as const, provider: predecessor.agent,
                providerSessionId: predecessor.sessionId(), observedAt: nativeUsage.observedAt, source: nativeUsage.source,
                cumulativeInputTokens: nativeUsage.inputTokens, cumulativeOutputTokens: nativeUsage.outputTokens,
                cumulativeTotalTokens: nativeUsage.totalTokens, authoritativeCostUsd: nativeUsage.authoritativeCostUsd,
              } } : {}),
              compactionCount, compactMaximum: settings.compact_maximum ?? 10,
              resources: [{ label: "frozen-qa-action", content: frozenAction, authoritative: true }],
            }, (_handoff, runtime) => createQaForSettings(qaCwd, settingsForRequestedRuntime(settings, runtime)), handoffRecoveryOptions("qa"));
            log.write("handoff-transfer", { role: "qa", generation: transfer.manifest.generation, predecessorSessionId: transfer.manifest.predecessorSessionId, successorSessionId: transfer.successorSessionId, acceptanceCheckpointDigest: transfer.acceptanceCheckpointDigest });
            await predecessor.close().catch(() => {});
            return decorateQa(transfer.successor, qaCwd, undefined, settings);
          },
        });
        return (await controller.atWorkSessionBoundary(adapter, frozenAction, strategy)).adapter;
      };
      const observeQaNativeCompactions = async (adapter: BuilderAdapter): Promise<void> => {
        if (!activeContinuityRunId) return;
        const qaSettings = resolvedContinuitySettings("qa");
        const controller = new ThresholdCompactionController({
          projectDir: cwd,
          runId: activeContinuityRunId,
          role: "qa",
          initialSettings: qaSettings,
          historicalCountUncertain: recoveryCompactionHistoryUncertain(cwd, recoveryRecord, activeContinuityRunId, "qa"),
        });
        await controller.observeNativeCompactions(adapter);
      };
      const qaNonconvergence = createQaNonconvergenceHandler(cwd, !process.stdin.isTTY || !process.stdout.isTTY, roleDefaults.planner);

      if (branchMode) {
        const ticketsConfig = loadTicketsConfig(cwd);
        const allowedBaseDirtyPaths = generatedTrackerDirtyPaths(ticketsConfig.paths);
        const baseWorktreePolicy = recoveryRecord ? "skip" as const : "enforce" as const;
        if (baseWorktreePolicy === "skip") {
          const projection = recoveryRecord ? projectBuildRecovery(cwd, recoveryRecord) : undefined;
          if (projection?.expectedChanges.length) {
            console.log(`foreman: preserved expected in-progress work: ${projection.expectedChanges.join(", ")}`);
          }
          if (projection?.unexpectedChanges.length) {
            console.warn("foreman: warning: unexpected changes may conflict with recovery; recovery is still allowed:");
            for (const item of projection.unexpectedChanges) console.warn(`  ${item.path}: ${item.risk}`);
            console.warn("foreman: recommended action: preserve or move overlapping changes before continuing");
          }
        } else {
          try {
            ensureCleanBaseWorktree(cwd, { allowedDirtyPaths: allowedBaseDirtyPaths });
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err));
          }
        }
        if (branchDefaults.createReview && branchDefaults.reviewProvider) {
          await ensureReviewProviderReady(cwd, branchDefaults.reviewProvider, log, Boolean(opts.yes));
        }

        const ready = await ensureRuntimeReadyForCommand(cwd, agent, {
          label: "start",
          yes: Boolean(opts.yes),
          allowSwitch: !(opts.resume || opts.continue),
          model,
        });
        agent = ready.runtime;
        model = ready.model;
        agentExecutable = ready.executable;

        const ticketPaths = resolveTicketPaths(ticketsConfig, cwd);
        const tickets = loadTickets(ticketPaths.tickets);
        const db = new StateDb(ticketPaths.stateDb);
        const states = db.getAllStates();
        db.close();

        const ticketById = new Map(tickets.map((ticket) => [ticket.id, ticket]));
        const resumeSessionByTicket = new Map<string, { worktreePath: string; sessionId: string; sessionRef?: ProviderSessionRefV1 }>();
        let auditDependencyCount: number | undefined;
        let plan: BranchPlan;
        if (continueTickets.length > 0) {
          const sessions = findResumableBranchSessions(join(cwd, ".foreman"));
          const sessionByTicket = new Map(sessions.map((session) => [session.ticket, session]));
          const nodes: BranchPlanNode[] = [];
          for (const ticketId of continueTickets) {
            const session = sessionByTicket.get(ticketId);
            if (!session) {
              fail([
                `no resumable branch session found for ticket ${ticketId}`,
                branchContinueTicketHelp(cwd),
              ].join("\n"));
            }
            const ticket = ticketById.get(ticketId);
            if (!ticket) fail(`ticket ${ticketId} no longer exists in .tickets/tickets.yaml`);
            const sessionId = (opts.resume as string | undefined) ?? session.sessionId;
            let sessionRef = session.sessionRef;
            if (sessionRef && sessionRef.sessionId !== sessionId) sessionRef = undefined;
            if (!sessionRef && recoveryRecord) sessionRef = buildRunSessionBinding(recoveryRecord, "builder", sessionId);
            if (!sessionRef && sessionId === session.sessionId) sessionRef = legacyBranchSessionRef(session, cwd, agent);
            if (!sessionRef) fail(`session ${sessionId} for ${ticketId} has no unique location-scoped binding; use fresh-with-handoff recovery`);
            resumeSessionByTicket.set(ticketId, { worktreePath: session.worktreePath, sessionId, sessionRef });
            nodes.push({
              ticket,
              branch: session.branch,
              baseRef: session.base,
              baseBranch: session.base,
              dependencies: [],
              depth: 1,
              worktreePath: session.worktreePath,
              deliveryUnitId: session.deliveryUnitId,
              deliveryUnitFinal: session.deliveryUnitFinal,
            });
          }
          plan = {
            baseRef: nodes[0]?.baseRef ?? ((opts.base as string | undefined) ?? currentGitRef(cwd)),
            nodes,
            issues: [],
          };
        } else {
          plan = buildBranchPlan(tickets, states, {
            steps,
            baseRef: (opts.base as string | undefined) ?? loadTicketSetupConfig(cwd)?.build.base_branch ?? currentGitRef(cwd),
            branchPrefix,
            maxBranchDepth,
            rootBaseBranches: branchDefaults.rootBaseBranches,
            ticketIds: selectedNewTicket ? [selectedNewTicket] : selectedStackTickets ?? deliveryRun?.remaining.slice(0, steps) ?? recoveryRecord?.tickets,
          });

          let auditBuilder: BuilderAdapter | undefined;
          let auditViewer: Promise<void> | undefined;
          const auditRunId = `audit-${stamp}`;
          activeContinuityRunId = auditRunId;
          try {
            auditBuilder = await createBuilder(cwd);
            auditViewer = printEvents(auditBuilder.events());
            const audit = await auditBuilder.sendTurn(buildBranchAuditInstruction(plan.nodes.map((node) => node.ticket)));
            if (audit.isError) throw new Error(audit.text);
            const auditDependencies = parseAuditDependencies(audit.text);
            plan = buildBranchPlan(tickets, states, {
              steps,
              baseRef: (opts.base as string | undefined) ?? loadTicketSetupConfig(cwd)?.build.base_branch ?? currentGitRef(cwd),
              branchPrefix,
              maxBranchDepth,
              auditDependencies,
              rootBaseBranches: branchDefaults.rootBaseBranches,
              ticketIds: selectedNewTicket ? [selectedNewTicket] : selectedStackTickets ?? deliveryRun?.remaining.slice(0, steps) ?? recoveryRecord?.tickets,
            });
            auditDependencyCount = auditDependencies.length;
          } finally {
            await auditBuilder?.close().catch(() => {});
            await auditViewer?.catch(() => {});
            const auditDb = new WorkflowDb(cwd);
            try {
              if (auditDb.getRun(auditRunId)) auditDb.transition(auditRunId, { status: "completed", checkpoint: "branch-audit-complete", remainingWork: {}, event: "audit_completed" });
            } finally { auditDb.close(); }
            activeContinuityRunId = undefined;
          }
          if (deliveryRun?.unit.branch_mode === "shared") {
            plan = applySharedDeliveryBranch(plan, deliveryRun.unit.id, deliveryRun.remaining, branchPrefix);
            const saved = readDeliveryUnitSession(cwd, deliveryRun.unit.id);
            const first = plan.nodes[0];
            if (saved && first && saved.branch === first.branch && existsSync(saved.worktreePath)) {
              const sessionRef = saved.sessionRef ?? createProviderSessionRef({ provider: agent, sessionId: saved.sessionId, role: "builder", stream: "builder", generation: 0, cwd: saved.worktreePath, configRoot: cwd, workspaceIdentity: captureWorkspaceIdentity(saved.worktreePath), ticketId: saved.ticket, deliveryUnitId: saved.unitId, source: "legacy-inferred" });
              resumeSessionByTicket.set(first.ticket.id, { worktreePath: saved.worktreePath, sessionId: saved.sessionId, sessionRef });
            }
          }
          if (selectedStacks.length && deliveryConfig) {
            plan = applyExplicitStackTopology(plan, selectedStacks, deliveryConfig, branchPrefix);
          } else if (!deliveryRun) {
            const branchPolicy = loadTicketSetupConfig(cwd)?.build.branch_policy;
            if (branchPolicy) plan = applySizeBranchPolicy(plan, branchPolicy, deliveryConfig, branchPrefix);
          }
          if (recoveryRecord && opts.resume && plan.nodes[0]) {
            const prior = findResumableBranchSessions(join(cwd, ".foreman")).find((session) => session.ticket === (recoveryRecord.currentTicket ?? plan.nodes[0]!.ticket.id));
            if (prior) {
              const requested = String(opts.resume);
              const sessionRef = prior.sessionRef?.sessionId === requested ? prior.sessionRef : buildRunSessionBinding(recoveryRecord, "builder", requested) ?? (prior.sessionId === requested ? legacyBranchSessionRef(prior, cwd, agent) : undefined);
              if (!sessionRef) fail(`session ${requested} has no stored scope for ${plan.nodes[0]!.ticket.id}`);
              resumeSessionByTicket.set(plan.nodes[0]!.ticket.id, { worktreePath: prior.worktreePath, sessionId: requested, sessionRef });
            }
          }
        }

        const branchPresentation = presentBranchPlan(plan, {
          stacked: selectedStacks.length > 0,
          resumed: continueTickets.length > 0 || Boolean(recoveryRecord),
        });
        log.write("branch-plan", {
          ...branchPlanLogMetadata(plan, branchPresentation),
          ...(auditDependencyCount === undefined ? {} : { auditDependencyCount }),
          ...(continueTickets.length > 0 || recoveryRecord ? { resume: true } : {}),
        });

        console.log(branchPresentation.banner);
        console.log(`foreman: project ${cwd}`);
        console.log(`foreman: base ${plan.baseRef}`);
        console.log(`foreman: log ${logPath}\n`);
        if (deliveryRun) {
          console.log(`foreman: delivery unit ${deliveryRun.unit.id} — ${deliveryRun.completed}/${deliveryRun.unit.tickets.length} complete, ${deliveryRun.remaining.length} remaining`);
          if (deliveryRun.unit.branch_mode === "shared" && steps < deliveryRun.remaining.length) console.log(`foreman: --steps ${steps} completes ${steps} ticket(s) in this ${deliveryRun.remaining.length}-ticket remainder; branch/session is preserved and PR completion is deferred`);
          if (deliveryRun.unit.dependency_mode === "stack") console.log("foreman: stacked delivery — dependent branches must be rebased or retargeted after prerequisite merges");
        }
        for (const node of plan.nodes) {
          console.log(`  ${node.ticket.id}  ${node.branch}  base=${node.baseBranch}`);
        }
        for (const issue of plan.issues) {
          console.log(`  ! ${issue.ticket ?? "plan"}: ${issue.message}`);
        }
        console.log();

        if (!autoApprovePlanUpdates && plan.issues.every((issue) => !issue.blocking)) {
          const action = await select({
            message: branchPresentation.prompt,
            options: [
              { value: "proceed", label: "Proceed" },
              { value: "cancel", label: "Cancel" },
            ],
          });
          if (isCancel(action) || action === "cancel") {
            console.log("ai-foreman: cancelled");
            process.exit(0);
          }
        }

        for (const [ticketId, session] of resumeSessionByTicket) {
          const ref = session.sessionRef;
          if (!ref) fail(`session ${session.sessionId} for ${ticketId} has no location-scoped binding`);
          if (ref.provider !== agent) fail(`session ${ref.sessionId} belongs to ${ref.provider}, but this recovery selected ${agent}`);
          const availability = await resolveProviderSessionAvailability(ref, {
            cwd: session.worktreePath,
            configRoot: cwd,
            workspaceIdentity: captureWorkspaceIdentity(session.worktreePath),
            runtimeExecutable: agentExecutable,
          });
          if (availability.status !== "available" || !availability.sessionRef) {
            fail(`exact session ${ref.sessionId} is ${availability.status} (${availability.reason ?? "validation failed"}): ${availability.detail ?? "no provider detail"}. The preserved worktree remains recoverable; choose fresh-with-handoff recovery.`);
          }
          resumeSessionByTicket.set(ticketId, { ...session, sessionRef: availability.sessionRef });
        }

        const capturedBranchBuilder: ResolvedAgentSettings = {
          role: "builder", source: opts.agent || opts.model || opts.effort || opts.fast ? "cli" : roleDefaults.builder ? "project" : "provider",
          make: agent, model: model ?? "default", reasoning: builderEffort ?? "default", fast: Boolean(builderFast),
          session_strategy: roleDefaults.builder?.session_strategy ?? "compact", settings_revision: settingsRevision,
          display_session_cost: sessionCostOverride ?? roleDefaults.builder?.display_session_cost ?? false,
          auto_compact_threshold_percent: thresholdOverride ?? roleDefaults.builder?.auto_compact_threshold_percent ?? 50,
          compact_maximum: roleDefaults.builder?.compact_maximum ?? 10,
        };
        const capturedBranchQa: ResolvedAgentSettings = {
          role: "qa", source: roleDefaults.qa ? "project" : "provider", make: qaAgent, model: qaModel ?? "default",
          reasoning: qaEffort ?? "default", fast: qaFast, session_strategy: roleDefaults.qa?.session_strategy ?? "compact", settings_revision: settingsRevision,
          display_session_cost: sessionCostOverride ?? roleDefaults.qa?.display_session_cost ?? false,
          auto_compact_threshold_percent: roleDefaults.qa?.auto_compact_threshold_percent ?? 50,
          compact_maximum: roleDefaults.qa?.compact_maximum ?? 10,
        };
        const firstResumeRef = plan.nodes[0] ? resumeSessionByTicket.get(plan.nodes[0].ticket.id)?.sessionRef : undefined;
        let masterRun = recoveryRecord ? resumeBuildRun(cwd, recoveryRecord.runId, { builder: capturedBranchBuilder, qa: capturedBranchQa, builderSessionId: firstResumeRef?.sessionId ?? null, builderSessionRef: firstResumeRef ?? null }) : createBuildRun({
          tickets: plan.nodes.map((node) => node.ticket.id), deliveryUnit: selectedStacks.length ? selectedStacks.map((stack) => stack.id).join(",") : deliveryRun?.unit.id,
          repositoryRoot: cwd, branchMode: branchPresentation.allocationMode, baseRef: plan.baseRef, builder: capturedBranchBuilder, qa: capturedBranchQa,
          runDecisions: { workMode: "branch-per-ticket", workModeSource, branchPrefix, branchPrefixSource: resolvedPrefix.source, autoCompactThresholdPercent: capturedBranchBuilder.auto_compact_threshold_percent ?? 50, thresholdSource: thresholdOverride === undefined ? "project" : "cli" },
        });
        activeContinuityRunId = masterRun.runId;
        const branchContextControllers = new Map<string, RoleSessionController>();
        const branchContextController = (worktreePath: string): RoleSessionController => {
          const existing = branchContextControllers.get(worktreePath);
          if (existing) return existing;
          const controller = RoleSessionController.managed({
            projectDir: cwd, runId: masterRun.runId, role: "builder", initialSettings: capturedBranchBuilder,
            historicalCountUncertain: recoveryCompactionHistoryUncertain(cwd, recoveryRecord, masterRun.runId, "builder"),
            readSettings: () => liveRoleSettings("builder", capturedBranchBuilder),
            settingsBoundary: (input) => applyBuilderSettingsBoundary(masterRun.runId, worktreePath, input),
            settingsAdopted: (settings, active) => liveStatusReporter?.updateState({
              role: "builder", provider: active.agent, model: settings.model, reasoning: settings.reasoning, fast: settings.fast,
              adapter: active, settingsRevision: settings.settings_revision, displaySessionCost: settings.display_session_cost,
              sessionTransition: "adopted live settings",
            }),
            report: (event) => { currentActivity()?.update(event.kind, event.detail, { provider: capturedBranchBuilder.make, model: capturedBranchBuilder.model }); log.write("context-lifecycle", { worktreePath, ...event, sample: event.sample }); },
            handoff: async ({ reason, adapter, sample, settings, compactionCount, frozenAction }) => {
              const nativeUsage = await adapter.sessionUsage?.().catch(() => undefined);
              const transfer = await new HandoffService(cwd).transfer({
                runId: masterRun.runId, role: "builder", reason, predecessorSessionId: adapter.sessionId(), predecessorSessionRef: adapter.sessionRef?.(),
                roleState: { worktreePath, frozenActionDigest: createHash("sha256").update(frozenAction).digest("hex"), contextSample: sample },
                ...(nativeUsage ? { sessionUsage: { version: 1 as const, runId: masterRun.runId, role: "builder" as const, provider: adapter.agent, providerSessionId: adapter.sessionId(), observedAt: nativeUsage.observedAt, source: nativeUsage.source, cumulativeInputTokens: nativeUsage.inputTokens, cumulativeOutputTokens: nativeUsage.outputTokens, cumulativeTotalTokens: nativeUsage.totalTokens, authoritativeCostUsd: nativeUsage.authoritativeCostUsd } } : {}),
                compactionCount, compactMaximum: settings.compact_maximum ?? 10,
                resources: [{ label: "frozen-action", content: frozenAction, authoritative: true }],
              }, (_handoff, runtime) => createBuilderForSettings(worktreePath, settingsForRequestedRuntime(settings, runtime)), handoffRecoveryOptions("builder"));
              log.write("handoff-transfer", { worktreePath, generation: transfer.manifest.generation, predecessorSessionId: transfer.manifest.predecessorSessionId, successorSessionId: transfer.successorSessionId, acceptanceCheckpointDigest: transfer.acceptanceCheckpointDigest });
              if (adapter instanceof ContinuityAdapter) {
                await adapter.adoptValidatedSuccessor(transfer.successor);
                return adapter;
              }
              await adapter.close().catch(() => {});
              return continuousBuilder(transfer.successor, worktreePath, masterRun.runId, settings);
            },
          });
          branchContextControllers.set(worktreePath, controller);
          return controller;
        };
        const branchHeartbeat = setInterval(() => { masterRun = heartbeatBuildRun(cwd, masterRun); }, 10_000); branchHeartbeat.unref();
        let branchSessionFailure: SessionUnavailableError | SessionUnavailableContinuityError | undefined;
        let summaries;
        try {
          summaries = await runBranchPlan({
          projectDir: cwd,
          runId: masterRun.runId,
          plan,
          log,
          agent,
          model,
          effort: builderEffort,
          fast: builderFast,
          notificationsEnabled: config.notifications.enabled,
          terminalBellEnabled: config.notifications.terminal_bell,
          qaEnabled,
          createPr: branchDefaults.createReview,
          completionMode: branchDefaults.completionMode,
          reviewProvider: branchDefaults.reviewProvider,
          prReady: branchDefaults.prReady,
          keepWorktrees: Boolean(opts.keepWorktrees) || selectedStacks.length > 0,
          cleanupBranches: branchDefaults.cleanupBranches,
          autoMergeWait: branchDefaults.autoMergeWait,
          autoMergeTimeoutMinutes: branchDefaults.autoMergeTimeoutMinutes,
          mergeMethod: branchDefaults.mergeMethod,
          allowedBaseDirtyPaths,
          baseWorktreePolicy,
          trackerPaths: {
            progressDoc: ticketsConfig.paths.progressDoc,
            archiveDoc: ticketsConfig.paths.archiveDoc,
          },
          resumeSessions: resumeSessionByTicket,
          createBuilder: (builderCwd, sessionId, sessionRef) => createBuilder(builderCwd, sessionId, sessionRef),
          recordBuilderSession: (session, ticketId) => { masterRun = persistBuildSession(cwd, { ...masterRun, currentTicket: ticketId }, "builder", session); },
          recordQaSession: (session, ticketId) => { masterRun = persistBuildSession(cwd, { ...masterRun, currentTicket: ticketId }, "qa", session); },
          onSessionUnavailable: (error) => { branchSessionFailure = error; },
          createQa: (qaCwd, sessionId) => createQa(qaCwd, sessionId),
          builderSessionStrategy: roleDefaults.builder?.session_strategy ?? "compact",
          qaSessionStrategy: roleDefaults.qa?.session_strategy ?? "compact",
          observeBuilder: async (builder) => {
            liveStatusReporter?.stop();
            activeBuilderForStatus = () => builder;
            const reporter = liveStatusReporter = new AgentStatusReporter({
              runId: masterRun.runId, role: "builder", provider: builder.agent, model: capturedBranchBuilder.model,
              reasoning: capturedBranchBuilder.reasoning, fast: capturedBranchBuilder.fast, step: Math.min(plan.nodes.length, branchContextControllers.size + 1), total: plan.nodes.length,
              phase: "builder ticket session", sessionTransition: builder.sessionId() ? "resumed session" : "initial session", adapter: builder,
              settingsRevision: capturedBranchBuilder.settings_revision, displaySessionCost: capturedBranchBuilder.display_session_cost ?? false,
              compactionCount: () => { const db = new WorkflowDb(cwd); try { return db.successfulCompactionCount(masterRun.runId, "builder", builder.sessionRef?.() ?? builder.sessionId()); } finally { db.close(); } },
              handoffGeneration: () => { const db = new WorkflowDb(cwd); try { return db.handoffs(masterRun.runId).at(-1)?.generation ?? 0; } finally { db.close(); } },
            }, (line, snapshot) => {
              const activity = currentActivity();
              if (activity && process.stdout.isTTY) activity.setAgentStatus(line.replace(/^\[[^\]]+\]\s*/, "")); else console.log(line);
              log.write("agent-status", { ...snapshot });
              const db = new WorkflowDb(cwd); try { db.recordTelemetry(masterRun.runId, snapshot); db.recordContextSample(snapshot.contextSample); if (snapshot.sessionUsage) db.recordSessionUsage(snapshot.sessionUsage); } finally { db.close(); }
            });
            reporter.start();
            try { await printEvents(builder.events()); } finally { reporter.stop(); }
          },
          qaNonconvergence,
          beforeBuilderTurn: async (adapter, frozenAction, worktreePath) => (await branchContextController(worktreePath).atSafeBoundary(adapter, frozenAction)).adapter,
          observeBuilderNativeCompactions: async (adapter, worktreePath) => { await branchContextController(worktreePath).observeNativeCompactions(adapter); },
          builderSessionBoundary: async (adapter, frozenAction, strategy, worktreePath) => (await branchContextController(worktreePath).atWorkSessionBoundary(adapter, frozenAction, strategy)).adapter,
          qaSessionBoundary,
          observeQaNativeCompactions,
          });
        } catch (error) {
          if (!(error instanceof HandoffAcceptanceError) && !(error instanceof HandoffRecoveryPausedError)) throw error;
          const summary = error.message.slice(0, 1000);
          masterRun = releaseBuildLease(cwd, checkpointBuildRun(cwd, masterRun, "handoff-recovery-required", {
            status: "recoverable",
            failure: { category: "unknown", summary, at: new Date().toISOString() },
          }), "recoverable");
          clearInterval(branchHeartbeat);
          log.write("safe-boundary-paused", { runId: masterRun.runId, message: summary, handoff: true });
          console.error(`foreman: handoff paused at a recoverable checkpoint: ${summary}`);
          console.error(`foreman: resume this run with: rafi build:resume ${shellQuote(cwd)} --run ${shellQuote(masterRun.runId)}`);
          process.exit(2);
        }
        if (branchSessionFailure) {
          const failure = branchSessionFailure;
          const guided = failure instanceof SessionUnavailableContinuityError ? failure.guidedRecovery : failure.failure.dispatchState === "unknown";
          const summary = failure.message.slice(0, 1000);
          masterRun = releaseBuildLease(cwd, checkpointBuildRun(cwd, masterRun, guided ? "guided-recovery-required" : "session-unavailable-before-dispatch", {
            status: "recoverable",
            failure: { category: "session-unavailable", summary, at: new Date().toISOString() },
          }), "recoverable");
          clearInterval(branchHeartbeat);
          log.write("session-unavailable", { runId: masterRun.runId, guided, message: summary });
          console.error(`foreman: exact provider session unavailable; preserved branch work remains recoverable: ${summary}`);
          console.error(guided
            ? `foreman: continue with: rafi build:resume ${shellQuote(cwd)} --run ${shellQuote(masterRun.runId)} --guided-recovery`
            : `foreman: inspect recovery with: rafi build:resume ${shellQuote(cwd)} --run ${shellQuote(masterRun.runId)} --inspect`);
          process.exit(2);
        }
        if (pendingHandoffGeneration !== undefined) throw new Error(`recovery handoff generation ${pendingHandoffGeneration} for ${pendingHandoffRole} was not accepted; recovery mode was not substituted`);
        clearInterval(branchHeartbeat);
        if (selectedStacks.length) {
          let allComplete = true;
          for (const stack of selectedStacks) {
            const stackTickets = stack.units.flatMap((id) => deliveryConfig?.units.find((unit) => unit.id === id)?.tickets ?? []);
            const rows = summaries.filter((row) => stackTickets.includes(row.ticket));
            const complete = rows.length > 0 && rows.every((row) => row.buildStatus === "done" && (!row.pr || ["created", "existing"].includes(row.pr.status)));
            allComplete &&= complete;
            const successful = rows.filter((row) => row.buildStatus === "done");
            updateStackDeliveryState(cwd, [stack.id], complete ? "awaiting_review" : "partial", {
              review_links: [...(stack.review_links ?? []), ...successful.flatMap((row) => row.pr?.url ? [row.pr.url] : [])],
              published_branches: { ...(stack.published_branches ?? {}), ...Object.fromEntries(successful.map((row) => [row.ticket, row.branch])) },
              completed_prefix: [...(stack.completed_prefix ?? []), ...successful.map((row) => row.ticket)],
              next_ticket: complete ? undefined : stackTickets.find((ticket) => !successful.some((row) => row.ticket === ticket)),
              remote_checked_at: stack.remote_checked_at, remote_stale: true,
            });
          }
          console.log(allComplete ? "foreman: stack publication complete; delivery is awaiting_review (no merges were attempted)" : "foreman: partial stack prefix published; resume point is preserved");
        }
        masterRun = withRunLocalAcceptedRuntimes(masterRun);
        masterRun = summaries.every((row) => row.buildStatus === "done")
          ? completeBuildRun(cwd, masterRun)
          : releaseBuildLease(cwd, checkpointBuildRun(cwd, masterRun, "branch-run-interrupted", { status: "recoverable" }), "recoverable");

        console.log("foreman: branch run summary");
        console.log("ticket\tbranch\tbase\tstatus\tcommit\tpush\tcompletion");
        for (const row of summaries) {
          console.log([
            row.ticket,
            row.branch || "-",
            row.base,
            row.buildStatus,
            row.commit ?? "-",
            row.pushStatus ?? "-",
            row.pr?.url ?? row.pr?.error ?? row.detail ?? "-",
          ].join("\t"));
        }
        const followupCommands = formatBranchSummaryFollowupCommands(cwd, join(cwd, ".foreman"), summaries);
        if (followupCommands.length > 0) {
          console.log();
          console.log("foreman: continue blocked branch ticket(s) with:");
          for (const command of followupCommands) {
            console.log(`  ${command}`);
          }
        }
        if (masterRun.status === "completed") printHandoffPruneCommand(masterRun.runId);

        const failed = summaries.some((row) => row.buildStatus === "blocked" || row.buildStatus === "needs-human");
        fireTerminalBell(config.notifications.terminal_bell);
        process.exit(failed ? 2 : 0);
      }

      const ready = await ensureRuntimeReadyForCommand(cwd, agent, {
        label: "start",
        yes: Boolean(opts.yes),
        allowSwitch: !(opts.resume || opts.continue),
        model,
      });
      agent = ready.runtime;
      model = ready.model;
      agentExecutable = ready.executable;
      if (resumeSessionRef) {
        if (resumeSessionRef.provider !== agent) fail(`session ${resumeSessionRef.sessionId} belongs to ${resumeSessionRef.provider}, but this recovery selected ${agent}`);
        const availability = await resolveProviderSessionAvailability(resumeSessionRef, {
          cwd,
          configRoot: cwd,
          workspaceIdentity: captureCurrentWorkflowSessionIdentity(cwd),
          runtimeExecutable: agentExecutable,
        });
        if (availability.status !== "available" || !availability.sessionRef) {
          fail(`exact session ${resumeSessionRef.sessionId} is ${availability.status} (${availability.reason ?? "validation failed"}): ${availability.detail ?? "no provider detail"}. The current worktree and recovery checkpoints were preserved; choose fresh-with-handoff recovery.`);
        }
        resumeSessionRef = availability.sessionRef;
      }
      if (qaEnabled) {
        const qaReady = await ensureRuntimeReadyForCommand(cwd, qaAgent, { label: "independent QA", yes: Boolean(opts.yes), model: qaModel });
        qaAgent = qaReady.runtime;
        qaModel = qaReady.model;
        qaExecutable = qaReady.executable;
      }
      const capturedBuilder: ResolvedAgentSettings = {
        role: "builder", source: opts.agent || opts.model || opts.effort || opts.fast ? "cli" : roleDefaults.builder ? "project" : "provider",
        make: agent, model: model ?? "default", reasoning: builderEffort ?? "default", fast: Boolean(builderFast),
        session_strategy: roleDefaults.builder?.session_strategy ?? "compact", settings_revision: settingsRevision,
        display_session_cost: sessionCostOverride ?? roleDefaults.builder?.display_session_cost ?? false,
        auto_compact_threshold_percent: thresholdOverride ?? roleDefaults.builder?.auto_compact_threshold_percent ?? 50,
        compact_maximum: roleDefaults.builder?.compact_maximum ?? 10,
      };
      const capturedQa: ResolvedAgentSettings = { role: "qa", source: roleDefaults.qa ? "project" : "provider", make: qaAgent, model: qaModel ?? "default", reasoning: qaEffort ?? "default", fast: qaFast, session_strategy: roleDefaults.qa?.session_strategy ?? "compact", display_session_cost: sessionCostOverride ?? roleDefaults.qa?.display_session_cost ?? false, auto_compact_threshold_percent: roleDefaults.qa?.auto_compact_threshold_percent ?? 50, compact_maximum: roleDefaults.qa?.compact_maximum ?? 10, settings_revision: settingsRevision };
      let buildRun: BuildRunRecordV2 = recoveryRecord ? resumeBuildRun(cwd, recoveryRecord.runId, { builder: capturedBuilder, qa: capturedQa, builderSessionId: resumeSessionId ?? null, builderSessionRef: resumeSessionRef ?? null }) : createBuildRun({
        tickets: [], repositoryRoot: cwd, branchMode: "current", baseRef: (opts.base as string | undefined) ?? loadTicketSetupConfig(cwd)?.build.base_branch, builder: capturedBuilder, qa: capturedQa,
        runDecisions: { workMode: "current", workModeSource, branchPrefix, branchPrefixSource: resolvedPrefix.source, autoCompactThresholdPercent: capturedBuilder.auto_compact_threshold_percent ?? 50, thresholdSource: thresholdOverride === undefined ? "project" : "cli" },
      });
      activeContinuityRunId = buildRun.runId;
      const heartbeat = setInterval(() => { buildRun = heartbeatBuildRun(cwd, buildRun); }, 10_000);
      heartbeat.unref();
      const checkpointSignal = (): void => {
        try { buildRun = releaseBuildLease(cwd, buildRun, "interrupted"); } catch { /* best effort */ }
      };
      process.once("SIGINT", checkpointSignal);
      process.once("SIGTERM", checkpointSignal);
      let builder: BuilderAdapter;
      try {
        builder = await createBuilder(cwd, resumeSessionId, resumeSessionRef);
      } catch (error) {
        if (!(error instanceof SessionUnavailableError)) throw error;
        const summary = error.message.slice(0, 1000);
        buildRun = releaseBuildLease(cwd, checkpointBuildRun(cwd, buildRun, "session-unavailable-before-dispatch", {
          status: "recoverable",
          failure: { category: "session-unavailable", summary, at: new Date().toISOString() },
        }), "recoverable");
        clearInterval(heartbeat);
        log.write("session-unavailable", { runId: buildRun.runId, phase: error.failure.phase, dispatchState: error.failure.dispatchState, message: summary });
        console.error(`foreman: exact provider session unavailable before dispatch; current worktree state was preserved: ${summary}`);
        console.error(`foreman: inspect recovery with: rafi build:resume ${shellQuote(cwd)} --run ${shellQuote(buildRun.runId)} --inspect`);
        process.exit(2);
      }
      const contextController = RoleSessionController.managed({
        projectDir: cwd,
        runId: buildRun.runId,
        role: "builder",
        initialSettings: capturedBuilder,
        historicalCountUncertain: recoveryCompactionHistoryUncertain(cwd, recoveryRecord, buildRun.runId, "builder"),
        readSettings: () => liveRoleSettings("builder", capturedBuilder),
        settingsBoundary: (input) => applyBuilderSettingsBoundary(buildRun.runId, cwd, input),
        settingsAdopted: (settings, active) => liveStatusReporter?.updateState({
          role: "builder", provider: active.agent, model: settings.model, reasoning: settings.reasoning, fast: settings.fast,
          adapter: active, settingsRevision: settings.settings_revision, displaySessionCost: settings.display_session_cost,
          sessionTransition: "adopted live settings",
        }),
        report: (event) => {
          currentActivity()?.update(event.kind, event.detail, { provider: capturedBuilder.make, model: capturedBuilder.model });
          log.write("context-lifecycle", { ...event, sample: event.sample });
        },
        handoff: async ({ reason, adapter, sample, settings, compactionCount, frozenAction }) => {
          const nativeUsage = await adapter.sessionUsage?.().catch(() => undefined);
          const transfer = await new HandoffService(cwd).transfer({
            runId: buildRun.runId,
            role: "builder",
            reason,
            predecessorSessionId: adapter.sessionId(),
            predecessorSessionRef: adapter.sessionRef?.(),
            roleState: { frozenActionDigest: createHash("sha256").update(frozenAction).digest("hex"), contextSample: sample },
            ...(nativeUsage ? { sessionUsage: {
              version: 1 as const, runId: buildRun.runId, role: "builder" as const, provider: adapter.agent,
              providerSessionId: adapter.sessionId(), observedAt: nativeUsage.observedAt, source: nativeUsage.source,
              cumulativeInputTokens: nativeUsage.inputTokens, cumulativeOutputTokens: nativeUsage.outputTokens,
              cumulativeTotalTokens: nativeUsage.totalTokens, authoritativeCostUsd: nativeUsage.authoritativeCostUsd,
            } } : {}),
            compactionCount,
            compactMaximum: settings.compact_maximum ?? 10,
            resources: [{ label: "frozen-action", content: frozenAction, authoritative: true }],
          }, (_handoff, runtime) => createBuilderForSettings(cwd, settingsForRequestedRuntime(settings, runtime)), handoffRecoveryOptions("builder"));
          log.write("handoff-transfer", { generation: transfer.manifest.generation, predecessorSessionId: transfer.manifest.predecessorSessionId, successorSessionId: transfer.successorSessionId, acceptanceCheckpointDigest: transfer.acceptanceCheckpointDigest });
          if (adapter instanceof ContinuityAdapter) {
            await adapter.adoptValidatedSuccessor(transfer.successor);
            return adapter;
          }
          await adapter.close().catch(() => {});
          return continuousBuilder(transfer.successor, cwd, buildRun.runId, settings);
        },
      });
      const foreman = new Foreman(
        builder, log, { desktop: config.notifications.enabled, terminalBell: config.notifications.terminal_bell }, qaEnabled, 3, cwd, undefined,
        qaEnabled ? createQa : undefined, capturedQa.session_strategy,
        createBuilder, capturedBuilder.session_strategy,
        qaNonconvergence,
        async (adapter, frozenAction) => (await contextController.atSafeBoundary(adapter, frozenAction)).adapter,
        async (adapter, frozenAction, strategy) => (await contextController.atWorkSessionBoundary(adapter, frozenAction, strategy)).adapter,
        qaSessionBoundary,
        observeQaNativeCompactions,
        async (adapter) => { await contextController.observeNativeCompactions(adapter); },
      );
      activeBuilderForStatus = () => foreman.builderAdapter();
      const statusReporter = liveStatusReporter = new AgentStatusReporter({
        runId: buildRun.runId,
        role: "builder", provider: capturedBuilder.make, model: capturedBuilder.model,
        reasoning: capturedBuilder.reasoning, fast: capturedBuilder.fast, step: 1, total: steps,
        phase: "builder work session", sessionTransition: resumeSessionId ? "resumed exact session" : "initial session", adapter: () => foreman.builderAdapter(),
        settingsRevision: capturedBuilder.settings_revision,
        displaySessionCost: capturedBuilder.display_session_cost ?? false,
        compactionCount: () => { const db = new WorkflowDb(cwd); try { return db.successfulCompactionCount(buildRun.runId, "builder", foreman.builderAdapter().sessionRef?.() ?? foreman.builderSessionId()); } finally { db.close(); } },
        handoffGeneration: () => { const db = new WorkflowDb(cwd); try { return db.handoffs(buildRun.runId).at(-1)?.generation ?? 0; } finally { db.close(); } },
      }, (line, snapshot) => {
        const activity = currentActivity();
        if (activity && process.stdout.isTTY) activity.setAgentStatus(line.replace(/^\[[^\]]+\]\s*/, ""));
        else console.log(line);
        log.write("agent-status", { ...snapshot });
        const db = new WorkflowDb(cwd); try { db.recordTelemetry(buildRun.runId, snapshot); db.recordContextSample(snapshot.contextSample); if (snapshot.sessionUsage) db.recordSessionUsage(snapshot.sessionUsage); } finally { db.close(); }
      });
      statusReporter.start();

      const modifiers = [
        model ? `model=${model}` : null,
        builderEffort ? `effort=${builderEffort}` : null,
        builderFast ? "fast" : null,
        qaEnabled ? null : "qa=off",
      ].filter(Boolean).join(" ");
      console.log(`foreman: driving a ${agent} builder through ${steps} step(s)${modifiers ? ` [${modifiers}]` : ""}`);
      console.log(`foreman: project ${cwd}`);
      if (trackerRelPath) console.log(`foreman: tracker ${trackerRelPath}`);
      console.log(`foreman: log ${logPath}\n`);

      const viewer = printEvents(builder.events());

      try {
        console.log("ai-foreman: asking builder to plan the next tickets or steps...\n");
        buildRun = checkpointBuildRun(cwd, buildRun, "before-preflight");
        await foreman.runPreflight(steps, ticketsContent, preferredTicket);
        buildRun = withRunLocalAcceptedRuntimes(buildRun);
        if (foreman.builderSessionId()) buildRun = persistBuildSession(cwd, buildRun, "builder", foreman.builderAdapter().sessionRef?.() ?? foreman.builderSessionId()!);
        if (foreman.qaSessionId()) buildRun = persistBuildSession(cwd, buildRun, "qa", foreman.qaSessionRef() ?? foreman.qaSessionId()!);
        buildRun = checkpointBuildRun(cwd, buildRun, "preflight-complete");

        if (!autoApprovePlanUpdates) {
          while (true) {
            console.log();
            const action = await select({
              message: "How does this plan look?",
              options: [
                { value: "proceed", label: "Proceed — start implementing" },
                { value: "feedback", label: "Give feedback — revise the plan" },
                { value: "cancel", label: "Cancel" },
              ],
            });

            if (isCancel(action) || action === "cancel") {
              console.log("ai-foreman: cancelled");
              statusReporter.stop();
              await foreman.close();
              await viewer;
              process.exit(0);
            }
            if (action === "proceed") {
              console.log();
              break;
            }

            const fb = await text({
              message: "Your feedback:",
              validate: (v) => (v?.trim() ? undefined : "Please enter some feedback"),
            });
            if (isCancel(fb)) {
              console.log("ai-foreman: cancelled");
              statusReporter.stop();
              await foreman.close();
              await viewer;
              process.exit(0);
            }
            console.log();
            await foreman.sendPreflightFeedback(String(fb));
          }
        }

        const result = await foreman.runBatch(steps, trackerRelPath, (ticketId) => {
          const tickets = buildRun.tickets.includes(ticketId)
            ? buildRun.tickets
            : [...buildRun.tickets, ticketId];
          buildRun = checkpointBuildRun(cwd, buildRun, "ticket-selected", {
            tickets,
            currentTicket: ticketId,
          });
        }, preferredTicket);
        if (pendingHandoffGeneration !== undefined) throw new Error(`recovery handoff generation ${pendingHandoffGeneration} for ${pendingHandoffRole} was not accepted; recovery mode was not substituted`);
        if (foreman.builderSessionId()) buildRun = persistBuildSession(cwd, buildRun, "builder", foreman.builderAdapter().sessionRef?.() ?? foreman.builderSessionId()!);
        if (foreman.qaSessionId()) buildRun = persistBuildSession(cwd, buildRun, "qa", foreman.qaSessionRef() ?? foreman.qaSessionId()!);
        buildRun = result.outcome === "all-done" || result.outcome === "plan-complete"
          ? completeBuildRun(cwd, buildRun)
          : releaseBuildLease(cwd, checkpointBuildRun(cwd, buildRun, "builder-or-qa-interrupted", { status: "recoverable" }), "recoverable");
        clearInterval(heartbeat);
        statusReporter.stop();
        await foreman.close();
        await viewer;

        console.log(`\nforeman: ${result.completed}/${result.requested} step(s) completed`);
        console.log(`foreman: outcome — ${result.outcome}`);
        if (result.detail) console.log(`foreman: ${result.detail}`);
        if (buildRun.status === "completed") printHandoffPruneCommand(buildRun.runId);
        if (result.outcome !== "all-done" && result.outcome !== "plan-complete") {
          const executable = command.parent?.name() === "rafi" ? "rafi" : "ai-foreman";
          const remainingSteps = Math.max(1, result.requested - result.completed);
          for (const line of formatResumeGuidance(executable, cwd, remainingSteps, foreman.builderSessionId())) {
            console.log(line);
          }
        }
        fireTerminalBell(config.notifications.terminal_bell);
        process.exit(result.outcome === "needs-human" || result.outcome === "blocked" ? 2 : 0);
      } catch (err) {
        clearInterval(heartbeat);
        statusReporter.stop();
        if (err instanceof ContextCapabilityError || err instanceof CurrentWorkflowChangedError) {
          const summary = err.message.slice(0, 1000);
          buildRun = releaseBuildLease(cwd, checkpointBuildRun(cwd, buildRun, "safe-boundary-paused", {
            status: "recoverable",
            failure: { category: "unknown", summary, at: new Date().toISOString() },
          }), "recoverable");
          await foreman.close().catch(() => {});
          log.write("safe-boundary-paused", { runId: buildRun.runId, message: summary });
          console.error(`foreman: run paused safely: ${summary}`);
          console.error(`foreman: after resolving the condition, inspect recovery with: rafi build:resume ${shellQuote(cwd)} --run ${shellQuote(buildRun.runId)} --inspect`);
          process.exit(2);
        }
        if (err instanceof SessionUnavailableContinuityError || err instanceof SessionUnavailableError) {
          const guided = err instanceof SessionUnavailableContinuityError ? err.guidedRecovery : err.failure.dispatchState === "unknown";
          const summary = err.message.slice(0, 1000);
          buildRun = releaseBuildLease(cwd, checkpointBuildRun(cwd, buildRun, guided ? "guided-recovery-required" : "session-unavailable-before-dispatch", {
            status: "recoverable",
            failure: { category: "session-unavailable", summary, at: new Date().toISOString() },
          }), "recoverable");
          await foreman.close().catch(() => {});
          log.write("session-unavailable", { runId: buildRun.runId, guided, message: summary });
          console.error(`foreman: exact provider session unavailable; current worktree state was preserved: ${summary}`);
          console.error(guided
            ? `foreman: continue with: rafi build:resume ${shellQuote(cwd)} --run ${shellQuote(buildRun.runId)} --guided-recovery`
            : `foreman: inspect recovery with: rafi build:resume ${shellQuote(cwd)} --run ${shellQuote(buildRun.runId)} --inspect`);
          process.exit(2);
        }
        if (err instanceof HandoffAcceptanceError || err instanceof HandoffRecoveryPausedError) {
          const summary = err.message.slice(0, 1000);
          buildRun = releaseBuildLease(cwd, checkpointBuildRun(cwd, buildRun, "handoff-recovery-required", {
            status: "recoverable",
            failure: { category: "unknown", summary, at: new Date().toISOString() },
          }), "recoverable");
          await foreman.close().catch(() => {});
          log.write("safe-boundary-paused", { runId: buildRun.runId, message: summary, handoff: true });
          console.error(`foreman: handoff paused at a recoverable checkpoint: ${summary}`);
          console.error(`foreman: resume this run with: rafi build:resume ${shellQuote(cwd)} --run ${shellQuote(buildRun.runId)}`);
          process.exit(2);
        }
        if (err instanceof HandoffLoopError || err instanceof ContinuityRecoveryRequiredError) {
          const summary = err.message.slice(0, 1000);
          buildRun = releaseBuildLease(cwd, checkpointBuildRun(cwd, buildRun, "guided-recovery-required", {
            status: "recoverable",
            failure: { category: "unknown", summary, at: new Date().toISOString() },
          }), "recoverable");
          await foreman.close().catch(() => {});
          log.write("guided-recovery-required", { runId: buildRun.runId, message: summary });
          console.error(`foreman: run paused at a recoverable continuity checkpoint: ${summary}`);
          console.error(`foreman: continue with: rafi build:resume ${shellQuote(cwd)} --run ${shellQuote(buildRun.runId)} --guided-recovery`);
          process.exit(2);
        }
        buildRun = releaseBuildLease(cwd, checkpointBuildRun(cwd, buildRun, "failed", { status: "failed", failure: { category: "unknown", summary: err instanceof Error ? err.message.slice(0, 1000) : String(err).slice(0, 1000), at: new Date().toISOString() } }), "failed");
        await foreman.close().catch(() => {});
        log.write("error", { message: String(err) });
        fail(`run failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
}

async function prepareNativeAutoCompaction(adapter: BuilderAdapter): Promise<void> {
  if (!adapter.prepareAutoCompaction) {
    await adapter.close().catch(() => {});
    throw new Error(`${adapter.agent} does not support provider-native automatic compaction`);
  }
  try {
    const policy = await adapter.prepareAutoCompaction();
    if (policy && policy.effectiveThresholdPercent !== policy.requestedThresholdPercent) {
      console.log(
        `foreman: ${adapter.agent} applied automatic compaction at ${policy.effectiveThresholdPercent}% `
        + `(configured ${policy.requestedThresholdPercent}%; provider minimum or clamp). `
        + "Use `rafi agents .` to update the Builder or QA saved threshold interactively.",
      );
    }
  } catch (error) {
    await adapter.close().catch(() => {});
    throw error;
  }
}

function createQaNonconvergenceHandler(projectDir: string, noninteractive: boolean, planner?: AgentRoleDefaultsV1): (context: QaNonconvergenceContext) => Promise<QaNonconvergenceDecision> {
  return async (context) => {
    if (noninteractive || !process.stdin.isTTY || !process.stdout.isTTY) return { action: "pause" };
    while (true) {
      const choice = await select({ message: `QA did not converge for ${context.ticket.id}. What next?`, options: [
        { value: "retry", label: "Retry another Builder fix" },
        { value: "pause", label: "Pause at this checkpoint" },
        { value: "waive", label: "Explicitly waive QA" },
        { value: "planner", label: "Discuss with read-only Planner" },
      ] });
      if (isCancel(choice) || choice === "pause") return { action: "pause" };
      if (choice === "retry") return { action: "retry" };
      if (choice === "waive") {
        const approved = await select({ message: "Waive QA and record validation_result=failed with all unresolved issues?", options: [
          { value: "no", label: "No (Recommended)" }, { value: "yes", label: "Yes, waive and continue" },
        ] });
        if (approved === "yes") {
          const db = new WorkflowDb(projectDir);
          try {
            const lease = db.currentLease();
            if (lease) {
              const detail = JSON.stringify({ decision: "waive", ticket: context.ticket.id, unresolved: context.history, at: new Date().toISOString() });
              db.putEvidence("test", detail);
              db.recordIssue(lease.runId, { code: "qa_nonconvergence", role: "qa", phase: "qa-waiver", ticket: context.ticket.id, detail, human_required: false, recoverable: false, suggested_action: "Review the explicit QA waiver before merging.", occurred_at: new Date().toISOString() });
            }
          } finally { db.close(); }
          console.log(`foreman: QA WAIVER recorded for ${context.ticket.id}; validation_result will be failed`);
          return { action: "waive" };
        }
        continue;
      }
      const discussion = await text({ message: "What should the Planner focus on?", defaultValue: "Explain the QA failures and propose the safest concrete remediation." });
      if (isCancel(discussion)) continue;
      const diff = execFileSync("git", ["-C", context.builderWorktree, "diff", "--binary", "HEAD"], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
      let instruction = [
        "You are the read-only Planner mediating QA nonconvergence. Do not edit files or run mutating tools.",
        `Ticket: ${context.ticket.id} — ${context.ticket.title}`,
        `Requirements: ${context.ticket.acceptance.join("; ")}`,
        `Required tests: ${context.ticket.required_tests.join("; ")}`,
        `User discussion: ${String(discussion)}`,
        `Complete QA history:\n${JSON.stringify(context.history, null, 2)}`,
        `Full Builder diff:\n${diff || "(no tracked diff)"}`,
        "Return RAFI_QA_REMEDIATION_START, then one JSON object {\"summary\":\"...\",\"fix_instructions\":[\"...\"]}, then RAFI_QA_REMEDIATION_END.",
        "End with STEP_STATUS: plan_complete | summary=\"QA remediation proposed\"",
      ].join("\n\n");
      let resumeSessionId: string | undefined;
      while (true) {
        const run = await runRoleInstruction({
          projectDir, role: "planner", instruction, label: "QA Planner remediation", agent: planner?.make,
          model: explicitDefaultValue(planner?.model), effort: explicitEffort(planner?.reasoning), fast: planner?.fast,
          resumeSessionId, permissionConfig: readOnlyPermissionConfig(), sandboxMode: "read-only",
          logPath: makeRoleLogPath(projectDir, "qa-remediation"), logEvent: "rafi-plan",
        });
        if (run.turn.result.isError || run.turn.status.kind !== "plan_complete") throw new Error(`Planner remediation failed: ${run.turn.status.error ?? run.turn.result.text.slice(0, 500)}`);
        const match = /RAFI_QA_REMEDIATION_START\s*([\s\S]*?)\s*RAFI_QA_REMEDIATION_END/.exec(run.turn.result.text);
        if (!match) throw new Error("Planner remediation did not return the required structured proposal");
        const proposal = JSON.parse(match[1]!.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as { summary?: string; fix_instructions?: string[] };
        if (!proposal.summary || !Array.isArray(proposal.fix_instructions) || !proposal.fix_instructions.every((item) => typeof item === "string")) throw new Error("Planner remediation proposal is malformed");
        console.log(`\nPlanner remediation: ${proposal.summary}\n${proposal.fix_instructions.map((item) => `- ${item}`).join("\n")}`);
        const decision = await select({ message: "Use this remediation for a new Builder fix session?", options: [
          { value: "approve", label: "Approve (Recommended)" }, { value: "revise", label: "Discuss/revise" }, { value: "cancel", label: "Cancel and return to choices" },
        ] });
        if (decision === "approve") return { action: "remediate", remediation: [proposal.summary, ...proposal.fix_instructions].join("\n") };
        if (isCancel(decision) || decision === "cancel") break;
        const feedback = await text({ message: "Planner revision feedback:" }); if (isCancel(feedback)) break;
        resumeSessionId = run.sessionId; instruction = `Revise the complete QA remediation proposal using this feedback: ${String(feedback)}. Keep the exact structured envelope and final plan_complete marker.`;
      }
    }
  };
}

function readAgentDefaults(projectDir: string): { revision?: number; builder?: AgentRoleDefaultsV1; qa?: AgentRoleDefaultsV1; planner?: AgentRoleDefaultsV1 } {
  const path = join(projectDir, "rafi-config.yaml");
  if (!existsSync(path)) return {};
  try {
    const parsed = parseYaml(readFileSync(path, "utf8")) as { agent_defaults?: AgentDefaultsV1 } | undefined;
    if (parsed?.agent_defaults?.version !== 1) return {};
    return { revision: parsed.agent_defaults.revision, builder: parsed.agent_defaults.roles.builder, qa: parsed.agent_defaults.roles.qa, planner: parsed.agent_defaults.roles.planner };
  } catch {
    return {};
  }
}

function explicitDefaultValue(value: string | undefined): string | undefined {
  return value && value !== "default" ? value : undefined;
}

function recoveryCompactionHistoryUncertain(
  projectDir: string,
  recovery: { legacy?: boolean; runDecisions?: unknown } | undefined,
  runId: string | undefined,
  role: "builder" | "qa",
): boolean {
  if (!recovery) return false;
  if (recovery.legacy || !recovery.runDecisions || !runId) return true;
  const db = new WorkflowDb(projectDir);
  try { return db.hasUncheckpointedRoleTurn(runId, role); }
  finally { db.close(); }
}

/** Make the executable branch plan exactly match each explicit root-to-tip stack. */
export function applyExplicitStackTopology(plan: BranchPlan, stacks: DeliveryStack[], delivery: DeliveryConfig, branchPrefix: string): BranchPlan {
  const nodeByTicket = new Map(plan.nodes.map((node) => [node.ticket.id, node]));
  const unitById = new Map(delivery.units.map((unit) => [unit.id, unit]));
  const ordered: BranchPlanNode[] = [];
  for (const stack of stacks) {
    let predecessorBranch = plan.baseRef;
    let predecessorActiveTicket: string | undefined;
    let missingPredecessorIdentity: string | undefined;
    let depth = 0;
    for (const unitId of stack.units) {
      const unit = unitById.get(unitId); if (!unit) throw new Error(`stack ${stack.id} references missing delivery unit ${unitId}`);
      const sharedBranch = unit.branch_mode === "shared" ? `${branchPrefix || "feature"}/${slug(unitId)}` : undefined;
      const unitBaseBranch = predecessorBranch;
      for (let ticketIndex = 0; ticketIndex < unit.tickets.length; ticketIndex++) {
        const ticketId = unit.tickets[ticketIndex]!; depth += unit.branch_mode === "shared" && ticketIndex > 0 ? 0 : 1;
        const node = nodeByTicket.get(ticketId);
        const recorded = stack.published_branches?.[ticketId];
        if (!node) {
          if (recorded || sharedBranch) predecessorBranch = recorded ?? sharedBranch!;
          else missingPredecessorIdentity = ticketId;
          predecessorActiveTicket = undefined;
          continue;
        }
        if (missingPredecessorIdentity) throw new Error(`partial stack ${stack.id} is missing the saved branch identity for completed predecessor ${missingPredecessorIdentity}`);
        const branch = sharedBranch ?? node.branch;
        ordered.push({
          ...node, branch, baseBranch: sharedBranch ? unitBaseBranch : predecessorBranch,
          dependencies: predecessorActiveTicket ? [predecessorActiveTicket] : [], depth,
          ...(unit.branch_mode === "shared" ? { deliveryUnitId: unit.id, deliveryUnitFinal: ticketIndex === unit.tickets.length - 1 } : {}),
        });
        predecessorBranch = branch; predecessorActiveTicket = ticketId;
      }
    }
  }
  if (ordered.length !== plan.nodes.length) throw new Error("explicit stack topology did not assign every selected ticket exactly once");
  return { ...plan, nodes: ordered };
}

function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "group"; }

function explicitEffort(value: string | undefined): EffortLevel | undefined {
  return value && ["low", "medium", "high", "xhigh"].includes(value) ? value as EffortLevel : undefined;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'"'"'`)}'`;
}

function printHandoffPruneCommand(runId: string): void {
  console.log("foreman: disposable handoff cache can be pruned with:");
  console.log(`  rafi handoffs prune-cache --run ${shellQuote(runId)} --keep-latest 1`);
}
