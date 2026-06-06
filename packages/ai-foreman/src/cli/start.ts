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

export function buildStartCommand(): Command {
  return new Command("start")
    .description("Enlist a builder and drive it through a batch of N steps.")
    .argument("<project>", "path to the project directory the builder works in")
    .requiredOption("-s, --steps <n>", "number of steps to drive")
    .option("-a, --agent <agent>", "builder agent (claude | codex)", "claude")
    .option("-m, --model <model>", "override the builder's model")
    .option("-r, --resume <sessionId>", "resume a prior builder session")
    .option("--continue", "resume the most recent logged session for this project")
    .option("-t, --tickets <path>", "path to ticket file (.md, .txt, .yaml, …) — passed to the builder as context")
    .option("-y, --yes", "skip pre-flight confirmation prompt")
    .option("--effort <level>", "reasoning effort level (low|medium|high|xhigh)")
    .option("--fast", "fast mode — lower latency (maps to effort=low for codex)")
    .option("--no-qa", "disable per-ticket QA review (enabled by default)")
    .action(async (project: string, opts) => {
      const steps = Number.parseInt(opts.steps, 10);
      if (!Number.isInteger(steps) || steps < 1) {
        fail("--steps must be a positive integer");
      }
      const VALID_AGENTS = ["claude", "codex"];
      if (!VALID_AGENTS.includes(opts.agent)) {
        fail(`unknown agent "${opts.agent}" — choose: ${VALID_AGENTS.join(" | ")}`);
      }

      const VALID_EFFORT = ["low", "medium", "high", "xhigh"];
      if (opts.effort && !VALID_EFFORT.includes(opts.effort)) {
        fail(`unknown effort "${opts.effort}" — choose: ${VALID_EFFORT.join(" | ")}`);
      }

      const cwd = resolve(project);
      if (!existsSync(cwd)) fail(`project directory not found: ${cwd}`);

      const TRACKER_SEARCH_PATHS = ["docs/ticket-progress.md", "ticket-progress.md"];
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

      const resumeSessionId =
        (opts.resume as string | undefined) ??
        (opts.continue ? findLastSessionId(join(cwd, ".foreman")) : undefined);
      if (opts.continue && !resumeSessionId) {
        fail(`no previous session id found under ${join(cwd, ".foreman")}`);
      }

      const config = loadConfig(join(cwd, "foreman.yaml"));
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const logPath = join(cwd, ".foreman", `${stamp}.jsonl`);
      const log = new Log(logPath);
      const policy = new PermissionPolicy(config.permissions, cwd);

      const roleBundle = loadRoleBundle("builder", { projectDir: cwd });
      const adapterOpts = {
        cwd,
        model: opts.model as string | undefined,
        resumeSessionId,
        permission: createPermissionHandler(policy, log),
        effort: opts.effort as EffortLevel | undefined,
        fast: opts.fast as boolean | undefined,
        systemPromptAppend: roleBundle.system || undefined,
        skills: roleBundle.skills.length > 0 ? roleBundle.skills : undefined,
      };
      const builder: BuilderAdapter =
        opts.agent === "codex"
          ? new CodexAdapter(adapterOpts)
          : await ClaudeAdapter.create(adapterOpts);
      const qaEnabled = opts.qa !== false && config.qa.enabled !== false;
      const foreman = new Foreman(builder, log, config.notifications.enabled, qaEnabled, 3, cwd);

      const modifiers = [
        opts.model ? `model=${opts.model}` : null,
        opts.effort ? `effort=${opts.effort}` : null,
        opts.fast ? "fast" : null,
        qaEnabled ? null : "qa=off",
      ].filter(Boolean).join(" ");
      console.log(`foreman: driving a ${opts.agent} builder through ${steps} step(s)${modifiers ? ` [${modifiers}]` : ""}`);
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
