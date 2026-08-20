#!/usr/bin/env node
/** Authenticated, opt-in end-to-end acceptance journey for `rafi create`. */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildWorkspace,
  composeLogs,
  createFixedPromptResponder,
  livePreflightFailures,
  requireLiveAcknowledgement,
  run,
  runTodoAppChecks,
  runTtyJourney,
} from "./live-interview-harness.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const fixture = join(root, "test", "fixtures", "live-todo-app");
const workdir = mkdtempSync(join(tmpdir(), "rafi-live-create-"));
const repo = join(workdir, "todo-app");
const transcript = join(workdir, "create-interview.typescript");
const composeProject = `rafi_live_create_${Date.now()}_${process.pid}`.replace(/[^a-z0-9_]/gi, "_");
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
  if (dockerComposeReady && existsSync(repo)) composeLogs(repo, composeProject);
}
process.on("exit", cleanup);

try {
  requireLiveAcknowledgement("Claude and Codex");
  const preflight = livePreflightFailures(["claude", "codex"]);
  dockerComposeReady = preflight.dockerComposeReady;
  if (preflight.failures.length) throw new Error(`preflight failed:\n${preflight.failures.map((failure) => `- ${failure}`).join("\n")}`);
  if (!existsSync(fixture)) throw new Error(`fixture missing: ${fixture}`);

  buildWorkspace(root);
  cpSync(fixture, repo, { recursive: true });
  run("docker", ["compose", "-p", composeProject, "up", "-d", "--build"], { cwd: repo });
  runTodoAppChecks(repo, composeProject);

  const cli = join(root, "packages", "rafi", "dist", "index.js");
  const command = `stty cols 120 rows 40; exec timeout 30m node ${JSON.stringify(cli)} create ${JSON.stringify(repo)}`;
  await runTtyJourney({
    command,
    cwd: repo,
    transcript,
    responder: createFixedPromptResponder([
      { prompt: "App name:", keys: "Rafi Live Todo\r" },
      { prompt: "Frontend stack", keys: "React TypeScript (Vite)\r" },
      { prompt: "Backend stack", keys: "FastAPI\r" },
      { prompt: "Database:", keys: "PostgreSQL\r" },
      { prompt: "Cloud provider", keys: "Local only\r" },
      { prompt: "Package manager", keys: "npm\r" },
      { prompt: "Will this app call LLMs", keys: "\r" },
      { prompt: "Agent runtime targets", keys: "\r" },
      { prompt: "Do you have existing ticket or planning docs", keys: "y\r" },
      { prompt: "Files, folders, or globs for existing tickets/plans", keys: "FEATURES.md\r" },
      { prompt: "Run `rafi plan .` now", keys: "y\r" },
      { prompt: "Planning brief:", keys: "Create a ticket-maker-ready plan for every decision in FEATURES.md.\r" },
      { prompt: "Run a read-only planning agent and write Rafi plan docs", keys: "\r" },
      { prompt: "Run `rafi tickets setup:init` now", keys: "\r" },
      { prompt: "Which ticket setup section should be configured", keys: "\u001B[B\u001B[B\u001B[B\r" },
      { prompt: "Primary ticket source:", keys: "\r" },
      { prompt: "Local source paths or globs", keys: "\r" },
      { prompt: "When both runtimes are configured", keys: "\u001B[B\u001B[B\r" },
      { prompt: "Default completion behavior for branch ticket runs", keys: "\u001B[B\r" },
      { prompt: "Run ticket population now", keys: "\r" },
    ]),
  });

  for (const artifact of ["rafi-config.yaml", "docs/rafi-plan.md", ".tickets/tickets.yaml"]) {
    if (!existsSync(join(repo, artifact))) throw new Error(`missing expected artifact: ${artifact}`);
  }
  const plan = readFileSync(join(repo, "docs", "rafi-plan.md"), "utf8");
  for (const id of ["F-LABELS", "F-DUE-DATES", "F-COMPLETION-FILTERS"]) {
    if (!plan.includes(id)) throw new Error(`plan does not cover ${id}`);
  }
  run("node", [join(root, "packages", "ai-foreman", "dist", "index.js"), "tickets", "validate", "--project", repo]);
  runTodoAppChecks(repo, composeProject);
  run("docker", ["compose", "-p", composeProject, "down", "-v"], { cwd: repo });
  succeeded = true;
} catch (error) {
  die(error instanceof Error ? error.message : String(error));
}
