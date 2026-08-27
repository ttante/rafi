#!/usr/bin/env node
/** Authenticated, opt-in end-to-end acceptance journey for `rafi tickets plan`. */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  buildWorkspace,
  compactTerminalText,
  composeLogs,
  createTicketPlanResponder,
  livePreflightFailures,
  requireLiveAcknowledgement,
  run,
  runTodoAppChecks,
  runTtyJourney,
} from "./live-interview-harness.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const appFixture = join(root, "test", "fixtures", "live-todo-app");
const planFixture = join(root, "test", "fixtures", "live-ticket-plan");
const requirements = join(planFixture, "REQUIREMENTS.md");
const workdir = mkdtempSync(join(tmpdir(), "rafi-live-ticket-plan-"));
const repo = join(workdir, "todo-app");
const transcript = join(workdir, "ticket-plan-interview.typescript");
const composeProject = `rafi_live_ticket_plan_${Date.now()}_${process.pid}`.replace(/[^a-z0-9_]/gi, "_");
const selectedRuntime = process.env.RAFI_LIVE_TICKET_PLAN_RUNTIME ?? "codex";
let succeeded = false;
let dockerComposeReady = false;

function die(message) {
  console.error(`live ticket plan: ${message}`);
  process.exitCode = 1;
}

function invariant(value, message) {
  if (!value) throw new Error(message);
}

function cleanup() {
  if (succeeded) {
    rmSync(workdir, { recursive: true, force: true });
    return;
  }
  console.error(`live ticket plan: failed diagnostics retained at ${workdir}`);
  if (dockerComposeReady && existsSync(repo)) composeLogs(repo, composeProject);
}
process.on("exit", cleanup);

function mutableRafiOutput(path) {
  return path === ".gitignore"
    || path === "rafi-config.yaml"
    || path.startsWith(".tickets/")
    || path.startsWith(".rafi/interviews/")
    || path.startsWith(".foreman/")
    || path === "docs/ticket-progress.md"
    || path === "docs/ticket-archive.md"
    || path === "docs/rafi-ticket-plan.md"
    || path.startsWith("docs/rafi-ticket-plans/");
}

function protectedTreeSnapshot(directory) {
  const hashes = new Map();
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      const path = relative(directory, absolute).replace(/\\/g, "/");
      if (mutableRafiOutput(path)) continue;
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) hashes.set(path, createHash("sha256").update(readFileSync(absolute)).digest("hex"));
    }
  };
  walk(directory);
  return hashes;
}

function assertSameProtectedTree(before, after) {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changed = paths.filter((path) => before.get(path) !== after.get(path));
  invariant(changed.length === 0, `planning changed files outside RAFI outputs: ${changed.join(", ")}`);
}

function localSourcePaths(config) {
  const entries = config.sources && typeof config.sources === "object"
    ? config.sources.entries
    : undefined;
  if (Array.isArray(entries)) {
    return entries
      .filter((source) => source?.type === "local" && typeof source.locator?.path === "string")
      .map((source) => source.locator.path);
  }
  const legacySources = config.tickets && typeof config.tickets === "object"
    ? config.tickets.sources
    : undefined;
  if (!Array.isArray(legacySources)) return [];
  return legacySources
    .filter((source) => source?.type === "local" && Array.isArray(source.paths))
    .flatMap((source) => source.paths.map(String));
}

function ticketText(ticket) {
  return [ticket.title, ticket.summary, ...(ticket.acceptance ?? []), ...(ticket.required_tests ?? []), ticket.notes]
    .filter(Boolean)
    .join("\n");
}

try {
  invariant(selectedRuntime === "codex" || selectedRuntime === "claude", "RAFI_LIVE_TICKET_PLAN_RUNTIME must be codex or claude");
  requireLiveAcknowledgement(selectedRuntime === "codex" ? "Codex" : "Claude");
  const preflight = livePreflightFailures([selectedRuntime]);
  dockerComposeReady = preflight.dockerComposeReady;
  if (preflight.failures.length) throw new Error(`preflight failed:\n${preflight.failures.map((failure) => `- ${failure}`).join("\n")}`);
  for (const fixture of [appFixture, planFixture, requirements]) invariant(existsSync(fixture), `fixture missing: ${fixture}`);

  buildWorkspace(root);
  cpSync(appFixture, repo, { recursive: true });
  rmSync(join(repo, "FEATURES.md"), { force: true });
  copyFileSync(join(planFixture, "PROJECT.md"), join(repo, "README.md"));
  mkdirSync(join(repo, "docs"), { recursive: true });
  copyFileSync(join(planFixture, "BASELINE.md"), join(repo, "docs", "live-baseline.md"));

  run("docker", ["compose", "-p", composeProject, "up", "-d", "--build"], { cwd: repo });
  runTodoAppChecks(repo, composeProject);

  const cli = join(root, "packages", "rafi", "dist", "index.js");
  const foreman = join(root, "packages", "ai-foreman", "dist", "index.js");
  run("node", [
    cli, "tickets", "setup:init", "--project", repo, "--defaults", "--runtime", "both",
    "--app-name", "Rafi Live Todo", "--local-source", "docs/live-baseline.md",
    "--completion", "pr", "--provider", "github", "--skip-access-check",
  ]);
  copyFileSync(join(planFixture, "tickets.yaml"), join(repo, ".tickets", "tickets.yaml"));
  run("node", [cli, "tickets", "update", "LIVE-CSV-EXPORT", "--project", repo, "--status", "next", "--actor", "live acceptance", "--summary", "Seed existing next work"]);
  run("node", [
    cli, "tickets", "discover", "--project", repo,
    "--summary", "Let users save reusable named task views",
    "--proposed-ticket", "LIVE-SAVED-VIEWS", "--priority-guess", "P1", "--area", "Tasks",
    "--rationale", "Users repeatedly recreate the same task filters", "--actor", "live acceptance",
  ]);
  run("node", [cli, "tickets", "render", "--project", repo]);
  run("node", [cli, "tickets", "validate", "--project", repo]);
  const protectedBefore = protectedTreeSnapshot(repo);

  const brief = requirements;
  const runtimeKeys = selectedRuntime === "codex" ? "\u001B[B\r" : "\r";
  const responder = createTicketPlanResponder({
    maxQuestionsPerPhase: 6,
    setupSteps: [
      { prompt: "Use Rafi project Rafi Live Todo at", keys: "\r" },
      { prompt: "What would you like to plan?", keys: `\u0015${brief}\r` },
      { prompt: "Which should this session use?", keys: "\u0015Use the remembered baseline and the external requirements from my description; reconcile every named item.\r" },
      { prompt: "Future-work ideas:", keys: "\u0015Fold item 1 into LIVE-SAVED-VIEWS and mark it merged.\r" },
      { prompt: "Existing next tickets:", keys: "\u0015Retain LIVE-CSV-EXPORT and add both new tickets as next work.\r" },
      { prompt: "Default ticket work mode:", keys: "\r" },
      { prompt: "Use these compact/fresh defaults?", keys: "\r" },
      { prompt: "Interview depth:", keys: "\r" },
      { prompt: "Both runtimes are configured", keys: runtimeKeys },
      { prompt: "Keep defaults, or enter a session override", keys: "\r" },
    ],
    standardAnswer: "Require authentication and make shared views read-only. Use the recommended defaults for anything else and prepare the first exact proposal.",
    revision: "Upgrade to grill-me. Change LIVE-SHARED-VIEWS so shared links expire after 30 days. Resolve any useful judgment questions, and preserve every other agreed decision.",
    grilledAnswer: "Expired links show a clear expired state and owners can generate a replacement. Use recommended defaults for anything else and prepare the revised exact proposal.",
  });
  const command = `stty cols 120 rows 40; exec timeout 30m node ${JSON.stringify(cli)} tickets plan`;
  await runTtyJourney({ command, cwd: join(repo, "web"), transcript, responder });

  const responseState = responder.snapshot();
  invariant(responseState.grilledQuestions >= 1 || responseState.auditCompleted, "exhaustive approval requires a valid grill-me answer or completed audit");
  invariant(responseState.reviews === 2, "the journey must review exactly two proposals");

  const ticketFile = parseYaml(readFileSync(join(repo, ".tickets", "tickets.yaml"), "utf8"));
  const tickets = ticketFile?.tickets;
  invariant(Array.isArray(tickets), "tickets.yaml does not contain a ticket array");
  invariant(tickets.length === 3, `expected exactly three tickets, found ${tickets.length}`);
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  for (const id of ["LIVE-CSV-EXPORT", "LIVE-SAVED-VIEWS", "LIVE-SHARED-VIEWS"]) invariant(byId.has(id), `missing ticket ${id}`);
  const exportTicket = byId.get("LIVE-CSV-EXPORT");
  const savedTicket = byId.get("LIVE-SAVED-VIEWS");
  const sharedTicket = byId.get("LIVE-SHARED-VIEWS");
  invariant(/filter/i.test(ticketText(exportTicket)) && /label/i.test(ticketText(exportTicket)) && /due date/i.test(ticketText(exportTicket)), "existing export ticket was not refined");
  invariant(sharedTicket.depends_on?.includes("LIVE-SAVED-VIEWS"), "shared views ticket does not depend on saved views");
  invariant(/30\s*days?|30-day|expire/i.test(ticketText(sharedTicket)) && /30/.test(ticketText(sharedTicket)), "revised 30-day expiration policy is missing");
  const refs = tickets.flatMap((ticket) => ticket.source_refs ?? []);
  invariant(refs.some((ref) => ref.source === "live-baseline" && ref.item === "BASE-CSV-EXPORT"), "missing baseline source_refs provenance");
  for (const item of ["REQ-EXPORT-FILTERED", "REQ-SAVED-VIEWS", "REQ-SHARED-VIEWS"]) {
    invariant(refs.some((ref) => ref.source === "live-ticket-plan" && ref.item === item), `missing live-ticket-plan source_refs provenance for ${item}`);
  }
  invariant((savedTicket.source_refs ?? []).some((ref) => ref.item === "REQ-SAVED-VIEWS"), "saved views provenance is missing");

  const delivery = parseYaml(readFileSync(join(repo, ".tickets", "delivery.yaml"), "utf8"));
  invariant(delivery?.version === 1 && delivery.units?.length === 1, "expected one version-1 delivery unit");
  const unit = delivery.units[0];
  invariant(unit.id === "live-saved-views", "unexpected delivery unit ID");
  invariant(Array.isArray(unit.tickets), "delivery unit ticket set is missing");
  invariant(JSON.stringify([...unit.tickets].sort()) === JSON.stringify(["LIVE-SAVED-VIEWS", "LIVE-SHARED-VIEWS"].sort()), "delivery unit ticket set is incorrect");
  invariant(unit.branch_mode === "shared" && unit.completion === "pr" && unit.provider === "github", "shared GitHub PR delivery policy is incorrect");
  invariant(unit.pr_ready === false && unit.merge_method === "squash" && unit.cleanup === true, "draft/squash/cleanup delivery settings are incorrect");

  const config = parseYaml(readFileSync(join(repo, "rafi-config.yaml"), "utf8"));
  const sources = localSourcePaths(config);
  invariant(sources.length === 2, `expected two deduplicated local sources, found ${sources.length}`);
  invariant(sources.includes("docs/live-baseline.md"), "remembered source was not preserved");
  const importedSources = sources.filter((path) => path.startsWith(".tickets/imports/local-"));
  invariant(importedSources.length === 1, "external local source was not persisted as one snapshot");
  invariant(readFileSync(join(repo, importedSources[0]), "utf8") === readFileSync(requirements, "utf8"), "external source snapshot content differs");

  const planningModule = await import(pathToFileURL(join(root, "packages", "ai-foreman", "dist", "ticketPlanning.js")).href);
  const context = planningModule.readTicketPlanningContext(repo);
  invariant(JSON.stringify([...context.existingNext].sort()) === JSON.stringify(["LIVE-CSV-EXPORT", "LIVE-SAVED-VIEWS", "LIVE-SHARED-VIEWS"].sort()), "next-work state did not retain and extend the queue");
  invariant(context.futureWork.some((item) => item.id === 1 && item.disposition === "merged"), "future-work item #1 was not marked merged");

  const latestPlanPath = join(repo, "docs", "rafi-ticket-plan.md");
  invariant(existsSync(latestPlanPath), "latest ticket-plan artifact is missing");
  const historyDir = join(repo, "docs", "rafi-ticket-plans");
  const history = readdirSync(historyDir).filter((name) => name.endsWith(".md"));
  invariant(history.length === 1, `expected one historical plan, found ${history.length}`);
  const latestPlan = readFileSync(latestPlanPath, "utf8");
  invariant(latestPlan === readFileSync(join(historyDir, history[0]), "utf8"), "latest and historical ticket plans differ");
  for (const value of ["LIVE-CSV-EXPORT", "LIVE-SAVED-VIEWS", "LIVE-SHARED-VIEWS", "30"]) {
    invariant(latestPlan.includes(value), `ticket plan artifact is missing ${value}`);
  }

  const planBackups = readdirSync(join(repo, ".tickets", "backups")).filter((name) => name.startsWith("ticket-plan-"));
  invariant(planBackups.length === 1, `expected one ticket-plan backup, found ${planBackups.length}`);
  const journal = JSON.parse(readFileSync(join(repo, ".tickets", "backups", planBackups[0], "journal.json"), "utf8"));
  invariant(journal.status === "committed", "ticket-plan backup journal was not committed");

  const interviewFiles = readdirSync(join(repo, ".rafi", "interviews")).filter((name) => name.endsWith(".json"));
  invariant(interviewFiles.length === 1, `expected one interview record, found ${interviewFiles.length}`);
  const interviewRaw = readFileSync(join(repo, ".rafi", "interviews", interviewFiles[0]), "utf8");
  const interview = JSON.parse(interviewRaw);
  invariant(interview.workflow === "tickets-plan" && interview.status === "completed", "ticket-plan interview record is not completed");
  invariant(!/30 days|expired links show/i.test(interviewRaw), "compact recovery record retained interview transcript content");

  const terminal = compactTerminalText(readFileSync(transcript, "utf8"));
  invariant(terminal.includes(`runtime${selectedRuntime}`), `transcript does not show runtime ${selectedRuntime}`);
  invariant(terminal.includes("created2edited1validationpassed"), "transcript does not show the expected exact apply summary");
  invariant(terminal.includes("starttheagreednextticketordeliverygroupnow"), "transcript does not show the declined start offer");

  run("node", [foreman, "tickets", "validate", "--project", repo]);
  assertSameProtectedTree(protectedBefore, protectedTreeSnapshot(repo));
  runTodoAppChecks(repo, composeProject);
  run("docker", ["compose", "-p", composeProject, "down", "-v"], { cwd: repo });
  succeeded = true;
} catch (error) {
  die(error instanceof Error ? error.message : String(error));
}
