import { execFileSync, spawn, spawnSync } from "node:child_process";

export const LIVE_ACK_ENV = "RAFI_LIVE_INTERVIEW";
export const LIVE_SKIP_BUILD_ENV = "RAFI_LIVE_SKIP_BUILD";
export const LIVE_TIMEOUT_MS = 30 * 60 * 1000;

const CLACK_ACTIVE = "◆";
const CLACK_SUBMIT = "◇";
const CLACK_TEXT_CURSOR = "█";

export const UNSUPPORTED_INTERACTIVE_PROMPTS = [
  ["isnotreadywhatshouldrafido", "an authenticated runtime is not ready"],
  ["failedwhileupdating", "a runtime update recovery prompt"],
];

export function findUnsupportedPrompt(value) {
  const visible = compactTerminalText(value);
  return UNSUPPORTED_INTERACTIVE_PROMPTS.find(([marker]) => visible.includes(marker));
}

export function compactTerminalText(value) {
  return value
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[^a-z0-9]+/gi, "")
    .toLowerCase();
}

export function has(command, args = ["--version"]) {
  return spawnSync(command, args, { stdio: "ignore" }).status === 0;
}

export function livePreflightFailures(runtimes) {
  const failures = [];
  if (process.platform !== "linux") failures.push("Linux is required because the journey is driven through util-linux `script`");
  if (!has("script")) failures.push("`script` is unavailable; install the util-linux package");

  const compose = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  const dockerComposeReady = compose.status === 0;
  if (!dockerComposeReady) {
    const output = `${compose.stderr ?? ""}\n${compose.stdout ?? ""}`.trim().replace(/\s+/g, " ");
    failures.push(`Docker Compose is unavailable${output ? `: ${output}` : ""}`);
  }
  for (const runtime of [...new Set(runtimes)]) {
    if (!has(runtime)) failures.push(`\`${runtime} --version\` failed; install and authenticate ${runtime === "claude" ? "Claude Code" : "Codex"}`);
  }
  return { failures, dockerComposeReady };
}

export function requireLiveAcknowledgement(runtimeDescription) {
  if (process.env[LIVE_ACK_ENV] !== "1") {
    throw new Error(`set ${LIVE_ACK_ENV}=1 to acknowledge that this uses authenticated ${runtimeDescription} sessions`);
  }
}

export function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: options.cwd,
    stdio: options.stdio ?? "inherit",
    env: { ...process.env, ...(options.env ?? {}) },
  });
}

export function buildWorkspace(root) {
  if (process.env[LIVE_SKIP_BUILD_ENV] !== "1") run("pnpm", ["-r", "build"], { cwd: root });
}

export function runTodoAppChecks(root, composeProject) {
  run("docker", ["compose", "-p", composeProject, "exec", "-T", "api", "python", "-m", "pytest"], { cwd: root });
  run("docker", ["compose", "-p", composeProject, "exec", "-T", "web", "npm", "test", "--", "--run"], { cwd: root });
  run("docker", ["compose", "-p", composeProject, "exec", "-T", "web", "npm", "run", "build"], { cwd: root });
}

function promptStream() {
  let buffer = "";
  let waitingForSubmit = false;
  return {
    append(chunk) {
      buffer = `${buffer}${chunk}`.slice(-256 * 1024);
      if (waitingForSubmit) {
        const submitted = buffer.lastIndexOf(CLACK_SUBMIT);
        if (submitted < 0) return false;
        buffer = buffer.slice(submitted + CLACK_SUBMIT.length);
        waitingForSubmit = false;
      }
      return true;
    },
    text() { return buffer; },
    acted() { buffer = ""; waitingForSubmit = true; },
  };
}

export function createFixedPromptResponder(steps) {
  const stream = promptStream();
  let index = 0;
  return {
    handle(chunk) {
      if (!stream.append(chunk) || index >= steps.length) return [];
      const step = steps[index];
      if (!compactTerminalText(stream.text()).includes(compactTerminalText(step.prompt))) return [];
      index += 1;
      stream.acted();
      return [step.keys];
    },
    assertComplete() {
      if (index !== steps.length) throw new Error(`TTY journey ended before expected prompt: ${steps[index]?.prompt ?? "unknown"}`);
    },
    snapshot() { return { stepIndex: index, stepCount: steps.length }; },
  };
}

function activeTextPrompt(value) {
  return value.includes(CLACK_ACTIVE) && value.includes(CLACK_TEXT_CURSOR);
}

export function createTicketPlanResponder(options) {
  const stream = promptStream();
  let setupIndex = 0;
  let phase = "setup";
  let standardQuestions = 0;
  let grilledQuestions = 0;
  let reviews = 0;

  function action(keys) {
    stream.acted();
    return [keys];
  }

  return {
    handle(chunk) {
      if (!stream.append(chunk)) return [];
      const raw = stream.text();
      const visible = compactTerminalText(raw);

      if (phase === "setup") {
        const step = options.setupSteps[setupIndex];
        if (!step || !visible.includes(compactTerminalText(step.prompt))) return [];
        setupIndex += 1;
        if (setupIndex === options.setupSteps.length) phase = "standard";
        return action(step.keys);
      }

      const isReview = visible.includes(compactTerminalText("Review this exact plan and ticket set:"));
      if (phase === "standard" && isReview) {
        if (standardQuestions < 1) throw new Error("ticket-plan journey reached its first proposal without a standard interview question");
        reviews += 1;
        phase = "revision";
        return action("\u001B[B\r");
      }
      if (phase === "standard" && activeTextPrompt(raw)) {
        standardQuestions += 1;
        if (standardQuestions > options.maxQuestionsPerPhase) throw new Error(`standard interview exceeded ${options.maxQuestionsPerPhase} questions`);
        return action(`\u0015${options.standardAnswer}\r`);
      }

      if (phase === "revision" && visible.includes(compactTerminalText("What should change?"))) {
        phase = "grilled";
        return action(`\u0015${options.revision}\r`);
      }

      if (phase === "grilled" && isReview) {
        if (grilledQuestions < 1) throw new Error("ticket-plan journey reached its revised proposal without a grilled interview question");
        reviews += 1;
        phase = "start-offer";
        return action("\r");
      }
      if (phase === "grilled" && activeTextPrompt(raw)) {
        grilledQuestions += 1;
        if (grilledQuestions > options.maxQuestionsPerPhase) throw new Error(`grilled interview exceeded ${options.maxQuestionsPerPhase} questions`);
        return action(`\u0015${options.grilledAnswer}\r`);
      }

      if (phase === "start-offer" && visible.includes(compactTerminalText("Start the agreed next ticket or delivery group now?"))) {
        phase = "done";
        return action("\r");
      }
      return [];
    },
    assertComplete() {
      if (setupIndex !== options.setupSteps.length) {
        throw new Error(`TTY journey ended before expected prompt: ${options.setupSteps[setupIndex]?.prompt ?? "unknown"}`);
      }
      if (phase !== "done") throw new Error(`ticket-plan TTY journey ended during ${phase}`);
      if (reviews !== 2) throw new Error(`ticket-plan journey expected two proposal reviews, saw ${reviews}`);
    },
    snapshot() { return { phase, setupIndex, standardQuestions, grilledQuestions, reviews }; },
  };
}

export async function runTtyJourney({ command, cwd, transcript, responder, timeoutMs = LIVE_TIMEOUT_MS, echoOutput = true }) {
  await new Promise((resolveJourney, rejectJourney) => {
    const child = spawn("script", ["-qefc", command, transcript], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, COLUMNS: "120", LINES: "40" },
    });
    let recent = "";
    let settled = false;
    const timeout = setTimeout(() => finish(new Error(`TTY journey exceeded the ${Math.round(timeoutMs / 60_000)} minute timeout`)), timeoutMs);

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
      if (echoOutput) process.stdout.write(chunk);
      const text = chunk.toString("utf8");
      recent = `${recent}${text}`.slice(-128 * 1024);
      const unsupported = findUnsupportedPrompt(recent);
      if (unsupported) {
        finish(new Error(`TTY journey stopped at ${unsupported[1]}; fix it before rerunning. See ${transcript}`));
        return;
      }
      try {
        for (const keys of responder.handle(text)) child.stdin.write(keys);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    }

    child.stdout.on("data", advance);
    child.stderr.on("data", (chunk) => { if (echoOutput) process.stderr.write(chunk); });
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error(`TTY journey failed (exit ${code ?? "unknown"}${signal ? `, signal ${signal}` : ""}); see ${transcript}`));
        return;
      }
      try {
        responder.assertComplete();
        finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

export function composeLogs(repo, composeProject) {
  spawnSync("docker", ["compose", "-p", composeProject, "logs", "--no-color"], { cwd: repo, stdio: "inherit" });
}
