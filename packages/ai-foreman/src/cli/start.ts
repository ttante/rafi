import { Command } from "commander";
import { resolve, join, relative } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
import { applySharedDeliveryBranch, buildBranchAuditInstruction, buildBranchPlan, parseAuditDependencies } from "../branch/planner.js";
import { currentGitRef, ensureCleanBaseWorktree, generatedTrackerDirtyPaths } from "../branch/git.js";
import { formatGitHubFailure, preflightGh } from "../branch/github.js";
import { preflightGlab } from "../branch/gitlab.js";
import { readDeliveryUnitSession, runBranchPlan } from "../branch/runner.js";
import { checkpointBuildRun, completeBuildRun, createBuildRun, heartbeatBuildRun, persistBuildSession, readBuildRuns, releaseBuildLease, resumeBuildRun } from "../buildRuns.js";
import type { BuildRunRecordV1, ResolvedAgentSettings } from "rafi-spec";
import type { AgentDefaultsV1, AgentRoleDefaultsV1 } from "rafi-spec";
import { parse as parseYaml } from "yaml";
import {
  findResumableBranchSessions,
  formatBranchContinueCommand,
  formatBranchSummaryFollowupCommands,
} from "../branch/resume.js";
import type { BranchPlan, BranchPlanNode, CompletionMode, MergeMethod, ReviewProvider } from "../branch/types.js";
import { detectGitProvider, loadTicketSetupConfig } from "../tickets/setupConfig.js";
import { loadDeliveryConfig, selectDeliveryUnitForRun, selectStacksForRun, updateStackDeliveryState, type DeliveryConfig, type DeliveryStack, type DeliveryUnitProgress } from "../tickets/delivery.js";
import { AgentStatusReporter } from "../statusReporter.js";
import { WorkflowDb } from "../workflowDb.js";
import { makeLogPath as makeRoleLogPath, readOnlyPermissionConfig, runRoleInstruction } from "../agentRun.js";
import type { QaNonconvergenceContext, QaNonconvergenceDecision } from "../qaReview.js";

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

  if (createPrFlagProvided && opts.createPr === false) {
    completionMode = "none";
  }

  const savedBranchMode = savedBuild?.branch_strategy === "branch-per-ticket";
  let branchMode = Boolean(savedBranchMode || branchFlagOn || createPrFlagOn || completionMode !== "none");
  if (!branchFlagProvided && !createPrFlagProvided && !optionWasProvided(command, "completion") && delivery) {
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
    const result = preflightGh(cwd);
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
  }
}

async function ensureReviewProviderReady(cwd: string, provider: ReviewProvider, log: Log, yes: boolean): Promise<void> {
  if (provider === "github") {
    await ensureGitHubReadyForCreatePr(cwd, log, yes);
    return;
  }
  while (true) {
    const result = preflightGlab(cwd);
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
    .option("--branch-prefix <prefix>", "branch name prefix for ticket branches", "rafi")
    .option("--max-branch-depth <n>", "maximum selected branch stack depth", "5")
    .option("--pr-ready", "create ready-for-review PRs instead of draft PRs")
    .option("--keep-worktrees", "keep successful ticket worktrees for inspection")
    .option("--ticket <id>", "ticket id to continue in branch mode; repeat for multiple tickets", collectTicket, [])
    .option("--skip-delivery-unit <id>", "skip one unfinished delivery unit for this run", collectTicket, [])
    .action(async (project: string, opts, command: Command) => {
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
      const continueTickets = (opts.ticket as string[] | undefined) ?? [];
      const maxBranchDepth = Number.parseInt(opts.maxBranchDepth, 10);
      if (!Number.isInteger(maxBranchDepth) || maxBranchDepth < 1) {
        fail("--max-branch-depth must be a positive integer");
      }
      if (!branchMode && continueTickets.length > 0) {
        fail("--ticket is only supported with --branch-per-ticket --continue or --branch-per-ticket --resume");
      }
      if (branchMode) {
        if (opts.resume && continueTickets.length > 1) {
          fail("--resume <sessionId> in branch mode supports exactly one --ticket; use --continue for multiple tickets");
        }
        if ((opts.resume || opts.continue) && continueTickets.length === 0 && !recoveryRecord) {
          fail(branchContinueTicketHelp(cwd, opts.resume ? "--resume" : "--continue"));
        }
        if (continueTickets.length > 0 && !(opts.resume || opts.continue)) {
          fail("--ticket in branch mode requires --continue or --resume <sessionId>");
        }
        if (opts.tickets) fail("--tickets is not supported with --branch-per-ticket; initialize and use .tickets/tickets.yaml");
        if (!isTicketsInitialized(cwd)) fail("--branch-per-ticket requires initialized .tickets/ (run ai-foreman tickets init)");
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

      const config = loadConfig(join(cwd, "foreman.yaml"));
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const logPath = join(cwd, ".foreman", `${stamp}.jsonl`);
      const log = new Log(logPath);

      const qaEnabled = opts.qa !== false && config.qa.enabled !== false;

      const createRawBuilder = async (builderCwd: string, sessionId?: string): Promise<BuilderAdapter> => {
        const builderPolicy = new PermissionPolicy(config.permissions, builderCwd);
        const roleBundle = loadRoleBundle("builder", { projectDir: builderCwd });
        const adapterOpts = {
          cwd: builderCwd,
          runtimeExecutable: agentExecutable,
          runtimePhase: "builder" as const,
          model,
          resumeSessionId: sessionId,
          permission: createPermissionHandler(builderPolicy, log),
          effort: builderEffort,
          fast: builderFast,
          systemPromptAppend: roleBundle.system || undefined,
          skills: roleBundle.skills.length > 0 ? roleBundle.skills : undefined,
        };
        return agent === "codex"
          ? new CodexAdapter(adapterOpts)
          : await ClaudeAdapter.create(adapterOpts);
      };

      const createBuilder = async (builderCwd: string, sessionId?: string): Promise<BuilderAdapter> => {
        const initial = await createRawBuilder(builderCwd, sessionId);
        return new RecoveringAdapter({
          initial,
          runtime: agent,
          label: "builder turn",
          enabled: !opts.yes && Boolean(process.stdin.isTTY && process.stdout.isTTY),
          allowSwitch: !(opts.resume || opts.continue),
          recreate: async (nextRuntime, resumeSessionId) => {
            const nextReady = await ensureRuntimeReadyForCommand(builderCwd, nextRuntime, {
              label: "builder recovery",
              allowSwitch: false,
              model: nextRuntime === agent ? model : undefined,
            });
            agent = nextReady.runtime;
            model = nextReady.model;
            agentExecutable = nextReady.executable;
            return createRawBuilder(builderCwd, resumeSessionId);
          },
        });
      };

      const createRawQa = async (qaCwd: string, sessionId?: string): Promise<BuilderAdapter> => {
        const qaPolicy = new PermissionPolicy(config.permissions, qaCwd);
        const roleBundle = loadRoleBundle("qa", { projectDir: qaCwd });
        const adapterOpts = {
          cwd: qaCwd,
          runtimeExecutable: qaExecutable,
          runtimePhase: "qa" as const,
          model: qaModel,
          resumeSessionId: sessionId,
          permission: createPermissionHandler(qaPolicy, log),
          effort: qaEffort,
          fast: qaFast,
          systemPromptAppend: `${roleBundle.system}\n\nYou are an independent QA reviewer. Do not edit source, tickets, configuration, or project documentation. You may run tests and create only harmless ignored caches or coverage output.`,
          skills: roleBundle.skills.length > 0 ? roleBundle.skills : undefined,
        };
        return qaAgent === "codex"
          ? new CodexAdapter(adapterOpts)
          : await ClaudeAdapter.create(adapterOpts);
      };

      const createQa = async (qaCwd: string, sessionId?: string): Promise<BuilderAdapter> => {
        const initial = await createRawQa(qaCwd, sessionId);
        return new RecoveringAdapter({
          initial,
          runtime: qaAgent,
          label: "QA turn",
          enabled: !opts.yes && Boolean(process.stdin.isTTY && process.stdout.isTTY),
          allowSwitch: !sessionId,
          recreate: async (nextRuntime, resumeSessionId) => {
            const nextReady = await ensureRuntimeReadyForCommand(qaCwd, nextRuntime, {
              label: "QA recovery",
              allowSwitch: false,
              model: nextRuntime === qaAgent ? qaModel : undefined,
            });
            qaAgent = nextReady.runtime;
            qaModel = nextReady.model;
            qaExecutable = nextReady.executable;
            return createRawQa(qaCwd, resumeSessionId);
          },
        });
      };
      const qaNonconvergence = createQaNonconvergenceHandler(cwd, Boolean(opts.yes), roleDefaults.planner);

      if (branchMode) {
        const ticketsConfig = loadTicketsConfig(cwd);
        const allowedBaseDirtyPaths = generatedTrackerDirtyPaths(ticketsConfig.paths);
        try {
          ensureCleanBaseWorktree(cwd, { allowedDirtyPaths: allowedBaseDirtyPaths });
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
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
        const resumeSessionByTicket = new Map<string, { worktreePath: string; sessionId: string }>();
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
            resumeSessionByTicket.set(ticketId, { worktreePath: session.worktreePath, sessionId });
            nodes.push({
              ticket,
              branch: session.branch,
              baseRef: session.base,
              baseBranch: session.base,
              dependencies: [],
              depth: 1,
              worktreePath: session.worktreePath,
            });
          }
          plan = {
            baseRef: nodes[0]?.baseRef ?? ((opts.base as string | undefined) ?? currentGitRef(cwd)),
            nodes,
            issues: [],
          };
          log.write("branch-plan", {
            baseRef: plan.baseRef,
            tickets: plan.nodes.map((node) => node.ticket.id),
            branches: plan.nodes.map((node) => ({ ticket: node.ticket.id, branch: node.branch, base: node.baseBranch })),
            issues: plan.issues,
            resume: true,
          });
        } else {
          plan = buildBranchPlan(tickets, states, {
            steps,
            baseRef: (opts.base as string | undefined) ?? currentGitRef(cwd),
            branchPrefix: opts.branchPrefix as string,
            maxBranchDepth,
            rootBaseBranches: branchDefaults.rootBaseBranches,
            ticketIds: selectedStackTickets ?? deliveryRun?.remaining.slice(0, steps) ?? recoveryRecord?.tickets,
          });

          let auditBuilder: BuilderAdapter | undefined;
          let auditViewer: Promise<void> | undefined;
          try {
            auditBuilder = await createBuilder(cwd);
            auditViewer = printEvents(auditBuilder.events());
            const audit = await auditBuilder.sendTurn(buildBranchAuditInstruction(plan.nodes.map((node) => node.ticket)));
            if (audit.isError) throw new Error(audit.text);
            const auditDependencies = parseAuditDependencies(audit.text);
            plan = buildBranchPlan(tickets, states, {
              steps,
              baseRef: (opts.base as string | undefined) ?? currentGitRef(cwd),
              branchPrefix: opts.branchPrefix as string,
              maxBranchDepth,
              auditDependencies,
              rootBaseBranches: branchDefaults.rootBaseBranches,
              ticketIds: selectedStackTickets ?? deliveryRun?.remaining.slice(0, steps) ?? recoveryRecord?.tickets,
            });
            log.write("branch-plan", {
              baseRef: plan.baseRef,
              tickets: plan.nodes.map((node) => node.ticket.id),
              branches: plan.nodes.map((node) => ({ ticket: node.ticket.id, branch: node.branch, base: node.baseBranch })),
              issues: plan.issues,
              auditDependencyCount: auditDependencies.length,
            });
          } finally {
            await auditBuilder?.close().catch(() => {});
            await auditViewer?.catch(() => {});
          }
          if (deliveryRun?.unit.branch_mode === "shared") {
            plan = applySharedDeliveryBranch(plan, deliveryRun.unit.id, deliveryRun.remaining, opts.branchPrefix as string);
            const saved = readDeliveryUnitSession(cwd, deliveryRun.unit.id);
            const first = plan.nodes[0];
            if (saved && first && saved.branch === first.branch && existsSync(saved.worktreePath)) {
              resumeSessionByTicket.set(first.ticket.id, { worktreePath: saved.worktreePath, sessionId: saved.sessionId });
            }
          }
          if (selectedStacks.length && deliveryConfig) {
            plan = applyExplicitStackTopology(plan, selectedStacks, deliveryConfig, opts.branchPrefix as string);
          }
          if (recoveryRecord && opts.resume && plan.nodes[0]) {
            const prior = findResumableBranchSessions(join(cwd, ".foreman")).find((session) => session.ticket === (recoveryRecord.currentTicket ?? plan.nodes[0]!.ticket.id));
            if (prior) resumeSessionByTicket.set(plan.nodes[0]!.ticket.id, { worktreePath: prior.worktreePath, sessionId: opts.resume as string });
          }
        }

        console.log(`foreman: ${continueTickets.length > 0 ? "resuming branch-per-ticket mode" : "branch-per-ticket mode"} for ${plan.nodes.length} ticket(s)`);
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

        if (!opts.yes && plan.issues.every((issue) => !issue.blocking)) {
          const action = await select({
            message: "Proceed with branch-per-ticket run?",
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

        const capturedBranchBuilder: ResolvedAgentSettings = {
          role: "builder", source: opts.agent || opts.model || opts.effort || opts.fast ? "cli" : roleDefaults.builder ? "project" : "provider",
          make: agent, model: model ?? "default", reasoning: builderEffort ?? "default", fast: Boolean(builderFast),
          session_strategy: roleDefaults.builder?.session_strategy ?? "compact", settings_revision: settingsRevision,
        };
        const capturedBranchQa: ResolvedAgentSettings = {
          role: "qa", source: roleDefaults.qa ? "project" : "provider", make: qaAgent, model: qaModel ?? "default",
          reasoning: qaEffort ?? "default", fast: qaFast, session_strategy: roleDefaults.qa?.session_strategy ?? "compact", settings_revision: settingsRevision,
        };
        let masterRun = recoveryRecord ? resumeBuildRun(cwd, recoveryRecord.runId, { builder: capturedBranchBuilder, qa: capturedBranchQa, builderSessionId: opts.resume ? String(opts.resume) : null }) : createBuildRun({
          tickets: plan.nodes.map((node) => node.ticket.id), deliveryUnit: selectedStacks.length ? selectedStacks.map((stack) => stack.id).join(",") : deliveryRun?.unit.id,
          repositoryRoot: cwd, branchMode: "per-ticket", builder: capturedBranchBuilder, qa: capturedBranchQa,
        });
        const branchHeartbeat = setInterval(() => { masterRun = heartbeatBuildRun(cwd, masterRun); }, 10_000); branchHeartbeat.unref();
        const summaries = await runBranchPlan({
          projectDir: cwd,
          runId: masterRun.runId,
          plan,
          log,
          agent,
          model,
          effort: builderEffort,
          fast: builderFast,
          notificationsEnabled: config.notifications.enabled,
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
          trackerPaths: {
            progressDoc: ticketsConfig.paths.progressDoc,
            archiveDoc: ticketsConfig.paths.archiveDoc,
          },
          resumeSessions: resumeSessionByTicket,
          createBuilder: (builderCwd, sessionId) => createBuilder(builderCwd, sessionId),
          createQa: (qaCwd, sessionId) => createQa(qaCwd, sessionId),
          builderSessionStrategy: roleDefaults.builder?.session_strategy ?? "compact",
          qaSessionStrategy: roleDefaults.qa?.session_strategy ?? "compact",
          observeBuilder: (builder) => printEvents(builder.events()),
          qaNonconvergence,
        });
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

        const failed = summaries.some((row) => row.buildStatus === "blocked" || row.buildStatus === "needs-human");
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
      };
      const capturedQa: ResolvedAgentSettings = { role: "qa", source: roleDefaults.qa ? "project" : "provider", make: qaAgent, model: qaModel ?? "default", reasoning: qaEffort ?? "default", fast: qaFast, session_strategy: roleDefaults.qa?.session_strategy ?? "compact", settings_revision: settingsRevision };
      let buildRun: BuildRunRecordV1 = recoveryRecord ? resumeBuildRun(cwd, recoveryRecord.runId, { builder: capturedBuilder, qa: capturedQa, builderSessionId: opts.resume ? String(opts.resume) : null }) : createBuildRun({
        tickets: [], repositoryRoot: cwd, branchMode: "current", builder: capturedBuilder, qa: capturedQa,
      });
      const heartbeat = setInterval(() => { buildRun = heartbeatBuildRun(cwd, buildRun); }, 10_000);
      heartbeat.unref();
      const checkpointSignal = (): void => {
        try { buildRun = releaseBuildLease(cwd, buildRun, "interrupted"); } catch { /* best effort */ }
      };
      process.once("SIGINT", checkpointSignal);
      process.once("SIGTERM", checkpointSignal);
      const builder = await createBuilder(cwd, resumeSessionId);
      const foreman = new Foreman(
        builder, log, config.notifications.enabled, qaEnabled, 3, cwd, undefined,
        qaEnabled ? createQa : undefined, capturedQa.session_strategy,
        createBuilder, capturedBuilder.session_strategy,
        qaNonconvergence,
      );
      const statusReporter = new AgentStatusReporter({
        role: "builder", provider: capturedBuilder.make, model: capturedBuilder.model,
        reasoning: capturedBuilder.reasoning, fast: capturedBuilder.fast, step: 1, total: steps,
        phase: "builder work session", sessionTransition: resumeSessionId ? "resumed exact session" : "initial session", adapter: () => foreman.builderAdapter(),
      }, (line, snapshot) => {
        console.log(line); log.write("agent-status", { ...snapshot });
        const db = new WorkflowDb(cwd); try { db.recordTelemetry(buildRun.runId, snapshot); } finally { db.close(); }
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
        await foreman.runPreflight(steps, ticketsContent);
        if (foreman.builderSessionId()) buildRun = persistBuildSession(cwd, buildRun, "builder", foreman.builderSessionId()!);
        if (foreman.qaSessionId()) buildRun = persistBuildSession(cwd, buildRun, "qa", foreman.qaSessionId()!);
        buildRun = checkpointBuildRun(cwd, buildRun, "preflight-complete");

        if (!opts.yes) {
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

        const result = await foreman.runBatch(steps, trackerRelPath);
        if (foreman.qaSessionId()) buildRun = persistBuildSession(cwd, buildRun, "qa", foreman.qaSessionId()!);
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
        if (result.outcome !== "all-done" && result.outcome !== "plan-complete") {
          const executable = command.parent?.name() === "rafi" ? "rafi" : "ai-foreman";
          const remainingSteps = Math.max(1, result.requested - result.completed);
          for (const line of formatResumeGuidance(executable, cwd, remainingSteps, foreman.builderSessionId())) {
            console.log(line);
          }
        }
        process.exit(result.outcome === "needs-human" ? 2 : 0);
      } catch (err) {
        clearInterval(heartbeat);
        statusReporter.stop();
        buildRun = releaseBuildLease(cwd, checkpointBuildRun(cwd, buildRun, "failed", { status: "failed", failure: { category: "unknown", summary: err instanceof Error ? err.message.slice(0, 1000) : String(err).slice(0, 1000), at: new Date().toISOString() } }), "failed");
        await foreman.close().catch(() => {});
        log.write("error", { message: String(err) });
        fail(`run failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
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
      const sharedBranch = unit.branch_mode === "shared" ? `${branchPrefix.replace(/^\/+|\/+$/g, "") || "rafi"}/${slug(unitId)}` : undefined;
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
