#!/usr/bin/env node
/** Authenticated, opt-in end-to-end acceptance journey for `rafi create`. */
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  buildWorkspace,
  compactTerminalText,
  composeLogs,
  createCreateGrillMeResponder,
  livePreflightFailures,
  requireLiveAcknowledgement,
  run,
  runTodoAppChecks,
  runTtyJourney,
} from "./live-interview-harness.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const fixture = join(root, "test", "fixtures", "live-todo-app");
const workdir = mkdtempSync(join(tmpdir(), "rafi-live-create-"));
const requestedRuntimes = process.env.RAFI_LIVE_RUNTIMES?.split(",").map((value) => value.trim()).filter(Boolean);
const runtimes = requestedRuntimes?.length ? requestedRuntimes : ["claude", "codex"];
if (runtimes.some((runtime) => runtime !== "claude" && runtime !== "codex")) {
  throw new Error("RAFI_LIVE_RUNTIMES accepts only claude and codex");
}
const runStates = [];
let succeeded = false;
let dockerComposeReady = false;

function die(message) {
  console.error(`live create: ${message}`);
  process.exitCode = 1;
}

function cleanup() {
  if (succeeded) {
    rmSync(workdir, { recursive: true, force: true });
    return;
  }
  console.error(`live create: failed diagnostics retained at ${workdir}`);
  for (const state of runStates) {
    if (dockerComposeReady && state.composeReady && existsSync(state.repo)) composeLogs(state.repo, state.composeProject);
  }
}
process.on("exit", cleanup);

function invariant(value, message) {
  if (!value) throw new Error(message);
}

function createResponder() {
  return createCreateGrillMeResponder({
    maxQuestions: 6,
    stopAnswer: "Stop questions and make the plan now",
    setupSteps: [
      { prompt: "App name:", keys: "Rafi Live Todo\r" },
      { prompt: "Frontend stack", keys: "React TypeScript (Vite)\r" },
      { prompt: "Backend stack", keys: "FastAPI\r" },
      { prompt: "Database:", keys: "PostgreSQL\r" },
      { prompt: "Cloud provider", keys: "Local only\r" },
      { prompt: "Package manager", keys: "npm\r" },
      { prompt: "Will this app call LLMs", keys: "\r" },
      { prompt: "Do you have existing ticket or planning docs", keys: "y\r" },
      { prompt: "Files, folders, or globs for existing tickets/plans", keys: "FEATURES.md\r" },
      { prompt: "Where should future source snapshots be stored", keys: "\r" },
      { prompt: "Default ticket work mode", keys: "\r" },
      { prompt: "Use these compact/fresh defaults", keys: "\r" },
      { prompt: "Add Rafi files to .gitignore", keys: "\r" },
      { prompt: "Run `rafi plan .` now", keys: "y\r" },
      { prompt: "Planning brief:", keys: "Create a ticket-maker-ready plan for every decision in FEATURES.md. Use grill-me and honor the user's early-stop choice whenever a useful judgment question exists.\r" },
    ],
    ticketSetupSteps: [
      { prompt: "Run `rafi tickets setup:init` now", keys: "\r" },
      { prompt: "Which ticket setup section should be configured", keys: "\u001B[B\u001B[B\u001B[B\r" },
      { prompt: "Primary ticket source:", keys: "\r" },
      { prompt: "Local source paths or globs", keys: "\r" },
      { prompt: "When both runtimes are configured", keys: "\r" },
      { prompt: "Default ticket work mode", keys: "\r" },
      { prompt: "Default completion behavior for branch ticket runs", keys: "\r" },
      { prompt: "Run ticket population now", keys: "\r" },
    ],
  });
}

function readPlanLogRecords(repo) {
  const foremanDir = join(repo, ".foreman");
  if (!existsSync(foremanDir)) return [];
  return readdirSync(foremanDir)
    .filter((name) => name.endsWith("-rafi-plan.jsonl"))
    .flatMap((name) => readFileSync(join(foremanDir, name), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      }));
}

async function runCreateJourney(runtime) {
  const repo = join(workdir, `${runtime}-todo-app`);
  const transcript = join(workdir, `${runtime}-create-interview.typescript`);
  const composeProject = `rafi_live_create_${runtime}_${Date.now()}_${process.pid}`.replace(/[^a-z0-9_]/gi, "_");
  const state = { runtime, repo, transcript, composeProject, composeReady: false };
  runStates.push(state);

  cpSync(fixture, repo, { recursive: true });
  run("docker", ["compose", "-p", composeProject, "up", "-d", "--build"], { cwd: repo });
  state.composeReady = true;
  runTodoAppChecks(repo, composeProject);

  const cli = join(root, "packages", "rafi", "dist", "index.js");
  const command = `stty cols 120 rows 40; exec timeout 30m node ${JSON.stringify(cli)} create --runtime ${runtime} --grill-me ${JSON.stringify(repo)}`;
  const responder = createResponder();
  await runTtyJourney({ command, cwd: repo, transcript, responder });
  const responseState = responder.snapshot();
  invariant(responseState.validGrillAnswers >= 1 || responseState.auditCompleted, `${runtime} create reached approval without a valid grill-me answer or completed audit`);
  invariant(responseState.planApprovals === 1, `${runtime} create did not approve exactly one plan`);

  for (const artifact of ["rafi-config.yaml", "docs/rafi-plan.md", "docs/rafi-plan.json", ".tickets/tickets.yaml"]) {
    invariant(existsSync(join(repo, artifact)), `${runtime} missing expected artifact: ${artifact}`);
  }
  const config = parseYaml(readFileSync(join(repo, "rafi-config.yaml"), "utf8"));
  invariant(JSON.stringify(config?.harness?.targets) === JSON.stringify([runtime]), `${runtime} config target was not locked to ${runtime}`);
  const plan = readFileSync(join(repo, "docs", "rafi-plan.md"), "utf8");
  for (const id of ["F-LABELS", "F-DUE-DATES", "F-COMPLETION-FILTERS"]) {
    invariant(plan.includes(id), `${runtime} plan does not cover ${id}`);
  }
  const terminal = compactTerminalText(readFileSync(transcript, "utf8"));
  invariant(terminal.includes("rafiplanroleplannermodeexhaustive"), `${runtime} transcript does not show exhaustive child planning`);
  invariant(readPlanLogRecords(repo).some((record) => record?.event === "rafi-plan" && record.runtime === runtime), `${runtime} planner log does not show runtime ${runtime}`);
  invariant(readPlanLogRecords(repo).some((record) => record?.event === "grill_answer_collected" || record?.event === "audit_complete"), `${runtime} planner log does not show grill-me verification`);

  run("node", [join(root, "packages", "ai-foreman", "dist", "index.js"), "tickets", "validate", "--project", repo]);
  runTodoAppChecks(repo, composeProject);
  run("docker", ["compose", "-p", composeProject, "down", "-v"], { cwd: repo });
  state.composeReady = false;
}

try {
  requireLiveAcknowledgement("Claude and Codex");
  const preflight = livePreflightFailures(runtimes);
  dockerComposeReady = preflight.dockerComposeReady;
  if (preflight.failures.length) throw new Error(`preflight failed:\n${preflight.failures.map((failure) => `- ${failure}`).join("\n")}`);
  if (!existsSync(fixture)) throw new Error(`fixture missing: ${fixture}`);

  buildWorkspace(root);
  for (const runtime of runtimes) await runCreateJourney(runtime);
  succeeded = true;
} catch (error) {
  die(error instanceof Error ? error.message : String(error));
}
