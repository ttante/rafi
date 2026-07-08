import { Command } from "commander";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { select, isCancel } from "@clack/prompts";
import { loadConfig } from "../config.js";
import { Log } from "../log.js";
import { PermissionPolicy } from "../permissions/policy.js";
import { ClaudeAdapter } from "../adapters/claude.js";
import { CodexAdapter } from "../adapters/codex.js";
import { Foreman, createPermissionHandler } from "../foreman.js";
import type { BuilderAdapter, EffortLevel } from "../adapters/types.js";
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
  cmdArchive,
} from "../tickets/commands.js";
import { isTicketsInitialized } from "../tickets/config.js";
import { importFromMarkdown } from "../tickets/importer.js";
import { formatValidationIssues } from "../tickets/validate.js";

function fail(msg: string): never {
  console.error(`foreman tickets: ${msg}`);
  process.exit(1);
}

function cwd(opts: { project?: string }): string {
  return resolve(opts.project ?? ".");
}

const VALID_AGENTS = ["claude", "codex"] as const;
const VALID_EFFORT = ["low", "medium", "high", "xhigh"] as const;

function validateAgent(agent: string): asserts agent is typeof VALID_AGENTS[number] {
  if (!VALID_AGENTS.includes(agent as typeof VALID_AGENTS[number])) {
    fail(`unknown agent "${agent}" — choose: ${VALID_AGENTS.join(" | ")}`);
  }
}

function validateEffort(effort: string | undefined): asserts effort is EffortLevel | undefined {
  if (effort && !VALID_EFFORT.includes(effort as EffortLevel)) {
    fail(`unknown effort "${effort}" — choose: ${VALID_EFFORT.join(" | ")}`);
  }
}

function makeLogPath(projectDir: string, label: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(projectDir, ".foreman", `${stamp}-${label}.jsonl`);
}

export function buildPopulateInstruction(sourceHints?: string[]): string {
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

Before editing, read these tracker control files:
- .tickets/config.yaml
- .tickets/tickets.yaml
- .tickets/tracker-rules.md
- docs/ticket-progress.md if it exists

Then inspect the repository for existing planning sources. Check root and docs-style Markdown/YAML/TXT files whose names suggest tickets, backlog, roadmap, plan, TODOs, milestones, progress, specs, phases, or implementation steps. Preserve every ticket or task you find. Do not leave out details.

Write the canonical ticket definitions to .tickets/tickets.yaml using Foreman's schema:
- id: stable ticket ID. Preserve existing IDs. If no IDs exist, assign T001, T002, ... in implementation order.
- order: unique numeric implementation order. Use gaps like 1000, 2000, 3000.
- title, area, priority, size, risk, depends_on, summary, acceptance, required_tests, likely_files, rollback, notes.
- Keep dependencies, acceptance criteria, testing expectations, file hints, risk notes, and implementation notes from the source material.
- Do not store mutable status/progress fields in .tickets/tickets.yaml.
- Do not edit .tickets/ticket-state.sqlite directly.

If source content does not cleanly map to the new schema, ask for guidance instead of guessing. Use:
STEP_STATUS: needs_input | question="..." choices="..."

After editing:
- Run foreman tickets render.
- Run foreman tickets validate.
- Fix validation errors if possible.
- Triple-check that every source ticket/task is represented exactly once and no important detail was dropped.

End with exactly one marker line as the final non-empty line:
STEP_STATUS: done | summary="populated Foreman tickets from existing project ticket sources"
or
STEP_STATUS: blocked | reason="why ticket population cannot proceed"`;
}

export function buildTicketsCommand(): Command {
  const tickets = new Command("tickets").description(
    "Manage the structured ticket tracker for a project.",
  );

  // ── init ────────────────────────────────────────────────────────────────────

  tickets
    .command("init")
    .description("Initialize .tickets/ structure in a project directory.")
    .option("-p, --project <dir>", "project directory (default: cwd)")
    .option("--app-name <name>", "application name")
    .option("--timezone <tz>", "IANA timezone (e.g. America/Chicago)", "UTC")
    .option("--queue-limit <n>", "next-queue window size", "50")
    .action((opts) => {
      const dir = cwd(opts);
      try {
        cmdInit(dir, {
          appName: opts.appName as string | undefined,
          timezone: opts.timezone as string,
          queueLimit: Number(opts.queueLimit),
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
    .description("Ask a builder to populate .tickets/tickets.yaml from existing project ticket/backlog docs.")
    .option("-p, --project <dir>", "project directory (default: cwd)")
    .option("-a, --agent <agent>", "builder agent (claude | codex)", "claude")
    .option("-m, --model <model>", "override the builder's model")
    .option("--effort <level>", "reasoning effort level (low|medium|high|xhigh)")
    .option("--sources <paths...>", "source hint files, folders, or globs to check first")
    .option("--fast", "fast mode - lower latency")
    .option("-y, --yes", "skip confirmation prompt before letting the builder edit tickets")
    .action(async (opts) => {
      const dir = cwd(opts);
      const agent = opts.agent as string;
      validateAgent(agent);
      validateEffort(opts.effort as string | undefined);

      if (!existsSync(dir)) fail(`project directory not found: ${dir}`);
      if (!isTicketsInitialized(dir)) {
        fail(`ticket tracker is not initialized in ${dir}; run \`foreman tickets init --project ${dir}\` first`);
      }

      if (!opts.yes) {
        const action = await select({
          message: "Populate .tickets/tickets.yaml by letting the builder edit this project?",
          options: [
            { value: "proceed", label: "Proceed - builder may edit ticket files" },
            { value: "cancel", label: "Cancel" },
          ],
        });
        if (isCancel(action) || action === "cancel") {
          console.log("foreman tickets: cancelled");
          process.exit(0);
        }
      }

      const config = loadConfig(join(dir, "foreman.yaml"));
      const logPath = makeLogPath(dir, "tickets-populate");
      const log = new Log(logPath);
      const policy = new PermissionPolicy(config.permissions, dir);
      const adapterOpts = {
        cwd: dir,
        model: opts.model as string | undefined,
        permission: createPermissionHandler(policy, log),
        effort: opts.effort as EffortLevel | undefined,
        fast: opts.fast as boolean | undefined,
      };
      const builder: BuilderAdapter =
        agent === "codex"
          ? new CodexAdapter(adapterOpts)
          : await ClaudeAdapter.create(adapterOpts);
      const viewer = printEvents(builder.events());
      const foreman = new Foreman(builder, log, config.notifications.enabled, false, 3, dir);

      console.log(`foreman tickets: populating tickets with ${agent}`);
      console.log(`foreman tickets: project ${dir}`);
      console.log(`foreman tickets: log ${logPath}\n`);

      try {
        const turn = await foreman.runInstruction(buildPopulateInstruction(opts.sources as string[] | undefined));
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

        cmdRender(dir);
        const validation = cmdValidate(dir);
        if (validation.issues.length > 0) {
          console.log(`foreman tickets: ${validation.issues.length} validation issue(s) found:`);
          console.log(formatValidationIssues(validation.issues));
          if (!validation.clean) process.exit(1);
        } else {
          console.log("foreman tickets: validation passed — all 4 passes clean");
        }
        console.log("foreman tickets: populated .tickets/tickets.yaml and rendered docs/ticket-progress.md");
      } catch (err) {
        await builder.close().catch(() => {});
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

  // ── render ───────────────────────────────────────────────────────────────────

  tickets
    .command("render")
    .description("Regenerate docs/ticket-progress.md from current structured sources.")
    .option("-p, --project <dir>", "project directory (default: cwd)")
    .action((opts) => {
      try {
        cmdRender(cwd(opts));
        console.log("foreman tickets: rendered docs/ticket-progress.md");
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
    .description("Print the next-N queue to stdout.")
    .option("-p, --project <dir>", "project directory (default: cwd)")
    .option("--limit <n>", "override queue limit")
    .action((opts) => {
      try {
        const rows = cmdQueue(cwd(opts), opts.limit ? Number(opts.limit) : undefined);
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
    .description("Update docs/ticket-archive.md and prune old completed rows.")
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
    .option("--progress <path>", "path to existing docs/ticket-progress.md")
    .action((opts) => {
      try {
        importFromMarkdown(opts.progress as string ?? "docs/ticket-progress.md");
      } catch (err) {
        console.error(String(err instanceof Error ? err.message : err));
        process.exit(1);
      }
    });

  return tickets;
}
