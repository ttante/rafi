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
  let auditCompleted = false;
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
      if (visible.includes(compactTerminalText("independent verification found"))) auditCompleted = true;

      if (phase === "setup") {
        const step = options.setupSteps[setupIndex];
        if (!step || !visible.includes(compactTerminalText(step.prompt))) return [];
        setupIndex += 1;
        if (setupIndex === options.setupSteps.length) phase = "standard";
        return action(step.keys);
      }

      const isReview = visible.includes(compactTerminalText("Review this exact plan and ticket set:"));
      const isInlineTextPrompt = raw.includes(CLACK_ACTIVE)
        && visible.includes(compactTerminalText("Choices:"));
      const isNativeSelectPrompt = raw.includes(CLACK_ACTIVE) && /[●○]/.test(raw);
      if (phase === "standard" && isReview) {
        reviews += 1;
        phase = "revision";
        return action("\u001B[B\r");
      }
      if (phase === "standard" && (activeTextPrompt(raw) || isInlineTextPrompt || isNativeSelectPrompt)) {
        standardQuestions += 1;
        if (standardQuestions > options.maxQuestionsPerPhase) throw new Error(`standard interview exceeded ${options.maxQuestionsPerPhase} questions`);
        return action(isNativeSelectPrompt && !isInlineTextPrompt ? "\r" : `\u0015${options.standardAnswer}\r`);
      }

      if (phase === "revision" && visible.includes(compactTerminalText("What should change?"))) {
        phase = "grilled";
        return action(`\u0015${options.revision}\r`);
      }

      if (phase === "grilled" && isReview) {
        if (grilledQuestions < 1 && !auditCompleted) throw new Error("ticket-plan journey reached approval without a valid grill-me answer or completed independent audit");
        reviews += 1;
        phase = "start-offer";
        return action("\r");
      }
      const hasGrillShape = visible.includes("recommended") && visible.includes(compactTerminalText("Stop questions and make the plan now"));
      const isTextPrompt = activeTextPrompt(raw) || isInlineTextPrompt;
      const isGrillPrompt = isTextPrompt || (raw.includes(CLACK_ACTIVE) && hasGrillShape);
      if (phase === "grilled" && isGrillPrompt) {
        if (!hasGrillShape) throw new Error("ticket-plan grilled question was not machine-recognizable");
        grilledQuestions += 1;
        if (grilledQuestions > options.maxQuestionsPerPhase) throw new Error(`grilled interview exceeded ${options.maxQuestionsPerPhase} questions`);
        return action(isTextPrompt ? `\u0015${options.grilledAnswer}\r` : "\r");
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
    snapshot() { return { phase, setupIndex, standardQuestions, grilledQuestions, auditCompleted, reviews }; },
  };
}

export function createCreateGrillMeResponder(options) {
  const stream = promptStream();
  let setupIndex = 0;
  let ticketSetupIndex = 0;
  let phase = "setup";
  let grillQuestions = 0;
  let validGrillAnswers = 0;
  let auditCompleted = false;
  let stopSelected = false;
  let planApprovals = 0;

  function action(keys) {
    stream.acted();
    return [keys];
  }

  function answerQuestion(raw, visible) {
    const isText = activeTextPrompt(raw);
    const hasStopOption = visible.includes(compactTerminalText(options.stopAnswer));
    const activeStart = raw.lastIndexOf(CLACK_ACTIVE);
    const activePrompt = activeStart >= 0 ? raw.slice(activeStart) : raw;
    const isInlineText = !isText
      && raw.includes(CLACK_ACTIVE)
      && hasStopOption
      && activePrompt.includes("|")
      && !/[●○]/.test(activePrompt);
    const isSelect = !isText && !isInlineText && raw.includes(CLACK_ACTIVE) && hasStopOption;
    if (stopSelected) {
      if (raw.includes(CLACK_ACTIVE)) {
        throw new Error("create grill-me journey saw another planner question after selecting early stop");
      }
      return [];
    }
    if (!isText && !isInlineText && !isSelect) return [];
    const hasRecommendation = visible.includes("recommended");
    if (!hasStopOption || !hasRecommendation) throw new Error("create grill-me question was not machine-recognizable");
    grillQuestions += 1;
    validGrillAnswers += 1;
    if (grillQuestions > options.maxQuestions) throw new Error(`create grill-me interview exceeded ${options.maxQuestions} questions`);
    stopSelected = true;
    const stopAt = raw.lastIndexOf(options.stopAnswer);
    const questionStart = raw.lastIndexOf(CLACK_ACTIVE, stopAt);
    const optionsBeforeStop = questionStart >= 0 && stopAt >= 0
      ? Math.max(0, (raw.slice(questionStart, stopAt).match(/[●○]/g) ?? []).length - 1)
      : 0;
    if (isSelect && optionsBeforeStop < 1) throw new Error("create grill-me select prompt options could not be counted");
    return action(isText || isInlineText
      ? `\u0015${options.stopAnswer}\r`
      : (options.nativeStopKeys ?? `${"\u001B[B".repeat(optionsBeforeStop)}\r`));
  }

  return {
    handle(chunk) {
      if (!stream.append(chunk)) return [];
      const raw = stream.text();
      const visible = compactTerminalText(raw);
      if (visible.includes(compactTerminalText("independent verification found"))) auditCompleted = true;

      if (phase === "setup") {
        const step = options.setupSteps[setupIndex];
        if (!step || !visible.includes(compactTerminalText(step.prompt))) return [];
        setupIndex += 1;
        if (setupIndex === options.setupSteps.length) phase = "grill";
        return action(step.keys);
      }

      if (phase === "grill") {
        if (visible.includes(compactTerminalText("Approve this structured plan?"))) {
          if (validGrillAnswers < 1 && !auditCompleted) throw new Error("create grill-me journey reached approval without a valid grill-me answer or completed independent audit");
          planApprovals += 1;
          phase = "ticket-setup";
          return action("\r");
        }
        return answerQuestion(raw, visible);
      }

      if (phase === "ticket-setup") {
        const step = options.ticketSetupSteps[ticketSetupIndex];
        if (!step || !visible.includes(compactTerminalText(step.prompt))) return [];
        ticketSetupIndex += 1;
        if (ticketSetupIndex === options.ticketSetupSteps.length) phase = "done";
        return action(step.keys);
      }
      return [];
    },
    assertComplete() {
      if (setupIndex !== options.setupSteps.length) {
        throw new Error(`TTY journey ended before expected create prompt: ${options.setupSteps[setupIndex]?.prompt ?? "unknown"}`);
      }
      if (phase === "grill") throw new Error("create grill-me TTY journey ended during planner grill-me questions");
      if (ticketSetupIndex !== options.ticketSetupSteps.length) {
        throw new Error(`TTY journey ended before expected ticket setup prompt: ${options.ticketSetupSteps[ticketSetupIndex]?.prompt ?? "unknown"}`);
      }
      if (phase !== "done") throw new Error(`create grill-me TTY journey ended during ${phase}`);
      if (validGrillAnswers < 1 && !auditCompleted) throw new Error("create grill-me journey completed without a valid grill-me answer or independent audit");
      if (planApprovals !== 1) throw new Error(`create grill-me journey expected one plan approval, saw ${planApprovals}`);
    },
    snapshot() { return { phase, setupIndex, ticketSetupIndex, grillQuestions, validGrillAnswers, auditCompleted, stopSelected, planApprovals }; },
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
