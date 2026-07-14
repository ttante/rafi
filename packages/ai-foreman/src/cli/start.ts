import { Command } from "commander";
import { resolve, join, relative } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { select, text, isCancel } from "@clack/prompts";
import { loadConfig } from "../config.js";
import { Log } from "../log.js";
import { PermissionPolicy } from "../permissions/policy.js";
import { ClaudeAdapter } from "../adapters/claude.js";
import { CodexAdapter } from "../adapters/codex.js";
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
import { buildBranchAuditInstruction, buildBranchPlan, parseAuditDependencies } from "../branch/planner.js";
import { currentGitRef, ensureCleanBaseWorktree, generatedTrackerDirtyPaths } from "../branch/git.js";
import { formatGitHubFailure, preflightGh } from "../branch/github.js";
import { runBranchPlan } from "../branch/runner.js";
import {
  findResumableBranchSessions,
  formatBranchContinueCommand,
  formatBranchSummaryFollowupCommands,
} from "../branch/resume.js";
import type { BranchPlan, BranchPlanNode } from "../branch/types.js";

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

export function buildStartCommand(): Command {
  return new Command("start")
    .description("Enlist a builder and drive it through a batch of N steps.")
    .argument("<project>", "path to the project directory the builder works in")
    .requiredOption("-s, --steps <n>", "number of steps to drive")
    .option("-a, --agent <agent>", "builder agent (claude | codex)")
    .option("-m, --model <model>", "override the builder's model")
    .option("-r, --resume <sessionId>", "resume a prior builder session")
    .option("--continue", "resume the most recent logged session for this project")
    .option("-t, --tickets <path>", "path to ticket file (.md, .txt, .yaml, …) — passed to the builder as context")
    .option("-y, --yes", "skip pre-flight confirmation prompt")
    .option("--effort <level>", "reasoning effort level (low|medium|high|xhigh)")
    .option("--fast", "fast mode — lower latency (maps to effort=low for codex)")
    .option("--no-qa", "disable per-ticket QA review (enabled by default)")
    .option("--branch-per-ticket", "run each selected structured ticket in an isolated git worktree and branch")
    .option("--create-pr", "push each successful ticket branch and create a GitHub PR (implies --branch-per-ticket)")
    .option("--base <ref>", "base ref for root ticket branches (default: current branch or HEAD)")
    .option("--branch-prefix <prefix>", "branch name prefix for ticket branches", "rafi")
    .option("--max-branch-depth <n>", "maximum selected branch stack depth", "2")
    .option("--pr-ready", "create ready-for-review PRs instead of draft PRs")
    .option("--keep-worktrees", "keep successful ticket worktrees for inspection")
    .option("--ticket <id>", "ticket id to continue in branch mode; repeat for multiple tickets", collectTicket, [])
    .action(async (project: string, opts) => {
      const steps = Number.parseInt(opts.steps, 10);
      if (!Number.isInteger(steps) || steps < 1) {
        fail("--steps must be a positive integer");
      }
      const VALID_EFFORT = ["low", "medium", "high", "xhigh"];
      if (opts.effort && !VALID_EFFORT.includes(opts.effort)) {
        fail(`unknown effort "${opts.effort}" — choose: ${VALID_EFFORT.join(" | ")}`);
      }

      const cwd = resolve(project);
      if (!existsSync(cwd)) fail(`project directory not found: ${cwd}`);
      let agent: AgentRuntime;
      try {
        agent = resolveAgentForProject(cwd, opts.agent as string | undefined);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
      let model = opts.model as string | undefined;

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

      const branchMode = Boolean(opts.branchPerTicket || opts.createPr);
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
        if ((opts.resume || opts.continue) && continueTickets.length === 0) {
          fail(branchContinueTicketHelp(cwd, opts.resume ? "--resume" : "--continue"));
        }
        if (continueTickets.length > 0 && !(opts.resume || opts.continue)) {
          fail("--ticket in branch mode requires --continue or --resume <sessionId>");
        }
        if (opts.tickets) fail("--tickets is not supported with --branch-per-ticket; initialize and use .tickets/tickets.yaml");
        if (!isTicketsInitialized(cwd)) fail("--branch-per-ticket requires initialized .tickets/ (run ai-foreman tickets init)");
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

      const createBuilder = async (builderCwd: string, sessionId?: string): Promise<BuilderAdapter> => {
        const builderPolicy = new PermissionPolicy(config.permissions, builderCwd);
        const roleBundle = loadRoleBundle("builder", { projectDir: builderCwd });
        const adapterOpts = {
          cwd: builderCwd,
          model,
          resumeSessionId: sessionId,
          permission: createPermissionHandler(builderPolicy, log),
          effort: opts.effort as EffortLevel | undefined,
          fast: opts.fast as boolean | undefined,
          systemPromptAppend: roleBundle.system || undefined,
          skills: roleBundle.skills.length > 0 ? roleBundle.skills : undefined,
        };
        return agent === "codex"
          ? new CodexAdapter(adapterOpts)
          : await ClaudeAdapter.create(adapterOpts);
      };

      if (branchMode) {
        const ticketsConfig = loadTicketsConfig(cwd);
        const allowedBaseDirtyPaths = generatedTrackerDirtyPaths(ticketsConfig.paths);
        try {
          ensureCleanBaseWorktree(cwd, { allowedDirtyPaths: allowedBaseDirtyPaths });
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        }
        if (opts.createPr) {
          await ensureGitHubReadyForCreatePr(cwd, log, Boolean(opts.yes));
        }

        const ready = await ensureRuntimeReadyForCommand(cwd, agent, {
          label: "start",
          yes: Boolean(opts.yes),
          allowSwitch: !(opts.resume || opts.continue),
          model,
        });
        agent = ready.runtime;
        model = ready.model;

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
          });

          let auditBuilder: BuilderAdapter | undefined;
          let auditViewer: Promise<void> | undefined;
          try {
            auditBuilder = await createBuilder(cwd);
            auditViewer = printEvents(auditBuilder.events());
            const audit = await auditBuilder.sendTurn(buildBranchAuditInstruction(plan.nodes.map((node) => node.ticket)));
            const auditDependencies = parseAuditDependencies(audit.text);
            plan = buildBranchPlan(tickets, states, {
              steps,
              baseRef: (opts.base as string | undefined) ?? currentGitRef(cwd),
              branchPrefix: opts.branchPrefix as string,
              maxBranchDepth,
              auditDependencies,
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
        }

        console.log(`foreman: ${continueTickets.length > 0 ? "resuming branch-per-ticket mode" : "branch-per-ticket mode"} for ${plan.nodes.length} ticket(s)`);
        console.log(`foreman: project ${cwd}`);
        console.log(`foreman: base ${plan.baseRef}`);
        console.log(`foreman: log ${logPath}\n`);
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

        const summaries = await runBranchPlan({
          projectDir: cwd,
          runId: stamp,
          plan,
          log,
          agent,
          model,
          effort: opts.effort as EffortLevel | undefined,
          fast: opts.fast as boolean | undefined,
          notificationsEnabled: config.notifications.enabled,
          qaEnabled,
          createPr: Boolean(opts.createPr),
          prReady: Boolean(opts.prReady),
          keepWorktrees: Boolean(opts.keepWorktrees),
          allowedBaseDirtyPaths,
          trackerPaths: {
            progressDoc: ticketsConfig.paths.progressDoc,
            archiveDoc: ticketsConfig.paths.archiveDoc,
          },
          resumeSessions: resumeSessionByTicket,
          createBuilder: (builderCwd, sessionId) => createBuilder(builderCwd, sessionId),
          observeBuilder: (builder) => printEvents(builder.events()),
        });

        console.log("foreman: branch run summary");
        console.log("ticket\tbranch\tbase\tstatus\tcommit\tpush\tpr");
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
      const builder = await createBuilder(cwd, resumeSessionId);
      const foreman = new Foreman(builder, log, config.notifications.enabled, qaEnabled, 3, cwd);

      const modifiers = [
        model ? `model=${model}` : null,
        opts.effort ? `effort=${opts.effort}` : null,
        opts.fast ? "fast" : null,
        qaEnabled ? null : "qa=off",
      ].filter(Boolean).join(" ");
      console.log(`foreman: driving a ${agent} builder through ${steps} step(s)${modifiers ? ` [${modifiers}]` : ""}`);
      console.log(`foreman: project ${cwd}`);
      if (trackerRelPath) console.log(`foreman: tracker ${trackerRelPath}`);
      console.log(`foreman: log ${logPath}\n`);

      const viewer = printEvents(builder.events());

      try {
        console.log("ai-foreman: asking builder to plan the next tickets or steps...\n");
        await foreman.runPreflight(steps, ticketsContent);

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
              await builder.close();
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
              await builder.close();
              await viewer;
              process.exit(0);
            }
            console.log();
            await foreman.sendPreflightFeedback(String(fb));
          }
        }

        const result = await foreman.runBatch(steps, trackerRelPath);
        await builder.close();
        await viewer;

        console.log(`\nforeman: ${result.completed}/${result.requested} step(s) completed`);
        console.log(`foreman: outcome — ${result.outcome}`);
        if (result.detail) console.log(`foreman: ${result.detail}`);
        const sid = builder.sessionId();
        if (sid) console.log(`foreman: resume this builder with  --resume ${sid}`);
        process.exit(result.outcome === "needs-human" ? 2 : 0);
      } catch (err) {
        await builder.close().catch(() => {});
        log.write("error", { message: String(err) });
        fail(`run failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
}
