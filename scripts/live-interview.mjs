#!/usr/bin/env node
/**
 * Deliberately opt-in release-candidate exercise. It uses real authenticated
 * runtimes; normal unit/CI runs must never invoke it or manage credentials.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const fixture = join(root, "test", "fixtures", "live-todo-app");
const workdir = mkdtempSync(join(tmpdir(), "rafi-live-interview-"));
const repo = join(workdir, "todo-app");
const transcript = join(workdir, "interview.typescript");
const composeProject = `rafi_live_${Date.now()}_${process.pid}`.replace(/[^a-z0-9_]/gi, "_");
let succeeded = false;
let dockerComposeReady = false;

function die(message) {
  console.error(`live interview: ${message}`);
  process.exitCode = 1;
}

function has(command, args = ["--version"]) {
  return spawnSync(command, args, { stdio: "ignore" }).status === 0;
}

function preflightFailures() {
  const failures = [];
  if (process.platform !== "linux") failures.push("Linux is required because the journey is driven through util-linux `script`");
  if (!has("script")) failures.push("`script` is unavailable; install the util-linux package");

  const compose = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  dockerComposeReady = compose.status === 0;
  if (!dockerComposeReady) {
    const output = `${compose.stderr ?? ""}\n${compose.stdout ?? ""}`.trim().replace(/\s+/g, " ");
    failures.push(`Docker Compose is unavailable${output ? `: ${output}` : ""}`);
  }
  if (!has("claude")) failures.push("`claude --version` failed; install and authenticate Claude Code");
  if (!has("codex")) failures.push("`codex --version` failed; install and authenticate Codex");
  return failures;
}

function run(command, args, options = {}) {
  execFileSync(command, args, { cwd: options.cwd ?? root, stdio: "inherit", env: { ...process.env, ...options.env } });
}

function compactTerminalText(value) {
  // Clack redraws its UI with ANSI cursor controls. Remove those controls and
  // whitespace so prompt matching works both in a normal terminal and in a
  // `script` transcript where individual characters may be separated by CR/LF.
  return value
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[^a-z0-9]+/gi, "")
    .toLowerCase();
}

const UNSUPPORTED_INTERACTIVE_PROMPTS = [
  ["isnotreadywhatshouldrafido", "an authenticated runtime is not ready"],
  ["failedwhileupdating", "a runtime update recovery prompt"],
];

async function runTtyJourney(command, steps) {
  await new Promise((resolveJourney, rejectJourney) => {
    const child = spawn("script", ["-qefc", command, transcript], {
      cwd: repo,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, COLUMNS: "120", LINES: "40" },
    });
    let output = "";
    let stepIndex = 0;
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("TTY journey exceeded the 30 minute timeout")), 30 * 60 * 1000);

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        child.kill("SIGTERM");
        rejectJourney(error);
      } else {
        resolveJourney();
      }
    }

    function advance(chunk) {
      process.stdout.write(chunk);
      output = `${output}${chunk.toString("utf8")}`.slice(-128 * 1024);
      const visible = compactTerminalText(output);
      const unsupported = UNSUPPORTED_INTERACTIVE_PROMPTS.find(([marker]) => visible.includes(marker));
      if (unsupported) {
        finish(new Error(`TTY journey stopped at ${unsupported[1]}; fix it before rerunning. See ${transcript}`));
        return;
      }
      while (stepIndex < steps.length && visible.includes(compactTerminalText(steps[stepIndex].prompt))) {
        const step = steps[stepIndex++];
        child.stdin.write(step.keys);
      }
    }

    child.stdout.on("data", advance);
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (code !== 0) {
        finish(new Error(`TTY journey failed (exit ${code ?? "unknown"}${signal ? `, signal ${signal}` : ""}); see ${transcript}`));
      } else if (stepIndex !== steps.length) {
        const next = steps[stepIndex];
        finish(new Error(`TTY journey ended before expected prompt: ${next.prompt}; see ${transcript}`));
      } else {
        finish();
      }
    });
  });
}

function cleanup() {
  if (succeeded) {
    rmSync(workdir, { recursive: true, force: true });
    return;
  }
  console.error(`live interview: failed diagnostics retained at ${workdir}`);
  if (dockerComposeReady && existsSync(repo)) {
    spawnSync("docker", ["compose", "-p", composeProject, "logs", "--no-color"], { cwd: repo, stdio: "inherit" });
  }
}
process.on("exit", cleanup);

const preflight = process.env.RAFI_LIVE_INTERVIEW === "1" ? preflightFailures() : [];

if (process.env.RAFI_LIVE_INTERVIEW !== "1") {
  die("set RAFI_LIVE_INTERVIEW=1 to acknowledge that this uses authenticated Claude and Codex sessions");
} else if (preflight.length > 0) {
  die(`preflight failed:\n${preflight.map((failure) => `- ${failure}`).join("\n")}`);
} else if (!existsSync(fixture)) {
  die(`fixture missing: ${fixture}`);
} else {
  try {
    run("pnpm", ["-r", "build"]);
    cpSync(fixture, repo, { recursive: true });

    // The fixture is purposely self-contained. Its package manager commands,
    // API tests, frontend tests, and production build run before and after the
    // interview so agent changes cannot hide a broken baseline.
    run("docker", ["compose", "-p", composeProject, "up", "-d", "--build"], { cwd: repo });
    run("docker", ["compose", "-p", composeProject, "exec", "-T", "api", "python", "-m", "pytest"], { cwd: repo });
    run("docker", ["compose", "-p", composeProject, "exec", "-T", "web", "npm", "test", "--", "--run"], { cwd: repo });
    run("docker", ["compose", "-p", composeProject, "exec", "-T", "web", "npm", "run", "build"], { cwd: repo });

    const cli = join(root, "packages", "rafi", "dist", "index.js");
    const command = `stty cols 120 rows 40; exec timeout 30m node ${JSON.stringify(cli)} create ${JSON.stringify(repo)}`;
    await runTtyJourney(command, [
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
      // Linked handoff: Claude plans from the preserved source, then Codex
      // populates the initialized tracker.
      { prompt: "Run `rafi plan .` now", keys: "y\r" },
      { prompt: "Planning brief:", keys: "Create a ticket-maker-ready plan for every decision in FEATURES.md.\r" },
      { prompt: "Run a read-only planning agent and write Rafi plan docs", keys: "\r" },
      { prompt: "Run `rafi tickets setup:init` now", keys: "\r" },
      { prompt: "Which ticket setup section should be configured", keys: "\u001B[B\u001B[B\u001B[B\r" },
      { prompt: "Primary ticket source:", keys: "\r" },
      // The plan path is prefilled from the linked planner handoff.
      { prompt: "Local source paths or globs", keys: "\r" },
      { prompt: "When both runtimes are configured", keys: "\u001B[B\u001B[B\r" },
      { prompt: "Default completion behavior for branch ticket runs", keys: "\u001B[B\r" },
      { prompt: "Run ticket population now", keys: "\r" },
    ]);

    for (const artifact of ["rafi-config.yaml", "docs/rafi-plan.md", ".tickets/tickets.yaml"]) {
      if (!existsSync(join(repo, artifact))) throw new Error(`missing expected artifact: ${artifact}`);
    }
    const plan = await (await import("node:fs/promises")).readFile(join(repo, "docs/rafi-plan.md"), "utf8");
    for (const id of ["F-LABELS", "F-DUE-DATES", "F-COMPLETION-FILTERS"]) {
      if (!plan.includes(id)) throw new Error(`plan does not cover ${id}`);
    }
    run("node", [join(root, "packages", "ai-foreman", "dist", "index.js"), "tickets", "validate", "--project", repo]);
    run("docker", ["compose", "-p", composeProject, "exec", "-T", "api", "python", "-m", "pytest"], { cwd: repo });
    run("docker", ["compose", "-p", composeProject, "exec", "-T", "web", "npm", "test", "--", "--run"], { cwd: repo });
    run("docker", ["compose", "-p", composeProject, "exec", "-T", "web", "npm", "run", "build"], { cwd: repo });
    run("docker", ["compose", "-p", composeProject, "down", "-v"], { cwd: repo });
    succeeded = true;
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
}
