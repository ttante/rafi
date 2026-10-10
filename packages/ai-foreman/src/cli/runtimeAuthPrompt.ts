import { select, isCancel, log } from "@clack/prompts";
import { requireClaudeSDK } from "../adapters/claude.js";
import {
  checkRuntimeReady,
  RuntimeAuthError,
  runtimeCommandLabel,
  type AgentRuntime,
} from "../runtimeAuth.js";
import { BuildOwnershipError } from "../buildAdmission.js";
import { RuntimeCleanupError, runtimeCleanupRecoveryHelp, type BuildReadinessContext, resolveExecutablePath } from "../runtimeReadiness.js";
import type { RuntimeProbeResult } from "rafi-spec";
import { otherRuntime, runtimeDisplayName } from "./runtimeSelection.js";
import { currentActivity } from "../activity.js";
import { durableHumanDecision } from "../humanDecision.js";
import { WorkflowDb } from "../workflowDb.js";
import { createHash } from "node:crypto";

export type RuntimeCommandRecoveryChoice = "retry" | "switch" | "cancel";

export interface RuntimeCommandRecoveryContext {
  otherRuntime: AgentRuntime;
  allowSwitch: boolean;
}

export interface RuntimeReadyForCommandOptions {
  label: string;
  build?: BuildReadinessContext;
  timeoutMs?: number;
  durable?: { projectDir: string; runId: string; scopeRevision: string };
  onTrace?: import("../runtimeReadiness.js").ProbeRuntimeOptions["onTrace"];
  yes?: boolean;
  allowSwitch?: boolean;
  model?: string | undefined;
  check?: (projectDir: string, runtime: AgentRuntime) => void | RuntimeProbeResult | Promise<void | RuntimeProbeResult>;
  checkClaudeSdk?: () => Promise<void>;
  choose?: (
    err: RuntimeAuthError,
    context: RuntimeCommandRecoveryContext,
  ) => Promise<RuntimeCommandRecoveryChoice>;
}

export interface RuntimeReadyForCommandResult {
  runtime: AgentRuntime;
  model?: string;
  fellBack: boolean;
  executable: string;
}

export async function ensureBuildRuntimeReadyForCommand(projectDir: string, runtime: AgentRuntime, opts: RuntimeReadyForCommandOptions & { build: BuildReadinessContext }): Promise<RuntimeReadyForCommandResult> {
  if (!opts.build?.authority) throw new BuildOwnershipError("stale-owner", "Build readiness requires original owning-project context");
  return ensureRuntimeReadyForCommand(projectDir, runtime, opts);
}

export async function ensureRuntimeReadyForCommand(
  projectDir: string,
  runtime: AgentRuntime,
  labelOrOptions: string | RuntimeReadyForCommandOptions,
): Promise<RuntimeReadyForCommandResult> {
  const opts = typeof labelOrOptions === "string"
    ? { label: labelOrOptions }
    : labelOrOptions;
  const check = opts.check ?? (async (projectDir: string, runtime: AgentRuntime) => {
    if (opts.durable && !opts.build) throw new BuildOwnershipError("stale-owner", "Build readiness requires its original owning-project context");
    return checkRuntimeReady(projectDir, runtime, { build: opts.build, onTrace: opts.onTrace, timeoutMs: opts.timeoutMs });
  });
  const checkClaudeSdk = opts.checkClaudeSdk ?? requireClaudeSDK;
  const allowSwitch = opts.allowSwitch !== false;
  const nonInteractive = !opts.choose && (Boolean(opts.yes) || !process.stdin.isTTY || !process.stdout.isTTY);

  while (true) {
    try {
      const probe = await check(projectDir, runtime);
      if (runtime === "claude") await checkClaudeSdk();
      const executable = probe?.executable ?? resolveExecutablePath(runtime === "claude" ? "claude" : "codex");
      if (!executable) throw new Error(`${runtime} executable disappeared after readiness`);
      return { runtime, model: opts.model, fellBack: false, executable };
    } catch (err) {
      if (err instanceof BuildOwnershipError || (err instanceof RuntimeCleanupError && opts.build)) throw err;
      const failure = err instanceof RuntimeAuthError
        ? err
        : new RuntimeAuthError({
            runtime,
            context: opts.label,
            stderr: err instanceof Error ? err.message : String(err),
            cause: err,
          });

      if (nonInteractive && !opts.durable && !(failure.cleanupUnverified && process.stdin.isTTY && process.stdout.isTTY)) {
        throw failure;
      }

      const fallbackRuntime = otherRuntime(runtime);
      const canSwitch = allowSwitch && !failure.cleanupUnverified;
      const choice = opts.durable && !opts.choose
        ? await durableRuntimeRecovery(opts.durable, failure, opts.label, fallbackRuntime, canSwitch)
        : opts.choose
        ? await opts.choose(failure, { otherRuntime: fallbackRuntime, allowSwitch: canSwitch })
        : await promptRuntimeRecovery(failure, opts.label, fallbackRuntime, canSwitch);

      if (choice === "retry") {
        currentActivity()?.note(`rafi: retrying ${runtime} readiness check`);
        continue;
      }
      if (choice === "switch" && canSwitch) {
        currentActivity()?.note(`rafi: checking fallback runtime ${fallbackRuntime}`);
        try {
          const probe = await check(projectDir, fallbackRuntime);
          if (fallbackRuntime === "claude") {
            await checkClaudeSdk();
          }
          if (opts.model) {
            console.log(
              `foreman: ignored --model ${opts.model} after switching to ${fallbackRuntime}; model names are provider-specific.`,
            );
          }
          console.log(`foreman: using ${runtimeDisplayName(fallbackRuntime)} for this run.`);
          const executable = probe?.executable ?? resolveExecutablePath(fallbackRuntime === "claude" ? "claude" : "codex");
          if (!executable) throw new Error(`${fallbackRuntime} executable disappeared after readiness`);
          return { runtime: fallbackRuntime, model: undefined, fellBack: true, executable };
        } catch (switchErr) {
          if (switchErr instanceof BuildOwnershipError || (switchErr instanceof RuntimeCleanupError && opts.build)) throw switchErr;
          const switchFailure = switchErr instanceof RuntimeAuthError
            ? switchErr
            : new RuntimeAuthError({
                runtime: fallbackRuntime,
                context: opts.label,
                stderr: switchErr instanceof Error ? switchErr.message : String(switchErr),
                cause: switchErr,
              });
          log.error(`Fallback runtime is not ready:\n${switchFailure.message}`);
          continue;
        }
      }

      if (choice === "cancel") {
        if (opts.durable) throw failure;
        console.log("foreman: cancelled");
        process.exit(0);
      }

      throw failure;
    }
  }
}

async function durableRuntimeRecovery(
  scope: NonNullable<RuntimeReadyForCommandOptions["durable"]>,
  failure: RuntimeAuthError, label: string, fallbackRuntime: AgentRuntime, allowSwitch: boolean,
): Promise<RuntimeCommandRecoveryChoice> {
  const db = new WorkflowDb(scope.projectDir);
  try {
    db.ensureRun(scope.runId);
    const identity = createHash("sha256").update(JSON.stringify([scope.scopeRevision, failure.runtime, label, allowSwitch])).digest("hex");
    const prefix = `runtime-recovery:${scope.runId}:${identity}:`;
    const attempt = db.operations(scope.runId).filter(item => item.kind === "runtime-recovery-decision" && item.idempotencyKey.startsWith(prefix)).length;
    const key = `${prefix}${attempt}`;
    console.error(failure.message);
    const choice = await durableHumanDecision<RuntimeCommandRecoveryChoice>({
      projectDir: scope.projectDir, runId: scope.runId, key,
      prompt: `${runtimeCommandLabel(failure.runtime)} is not ready for ${label}. Choose how to recover.`,
      choices: [{ id: "retry", label: "Fix manually and retry" }, ...(allowSwitch ? [{ id: "switch", label: `Use ${runtimeDisplayName(fallbackRuntime)}` }] : []), { id: "cancel", label: "Stop and preserve work" }],
      operation: () => promptRuntimeRecovery(failure, label, fallbackRuntime, allowSwitch),
    });
    // Spend this authorization before executing it. A later failure must never
    // reuse an old retry answer and turn a human decision into an infinite loop.
    db.atomic(() => {
      db.planOperation({ runId: scope.runId, idempotencyKey: key, kind: "runtime-recovery-decision", intent: { choice } });
      db.updateOperation(key, "in_progress");
      db.updateOperation(key, "confirmed", { result: { choice } });
    });
    return choice;
  } finally { db.close(); }
}

async function promptRuntimeRecovery(
  err: RuntimeAuthError,
  label: string,
  fallbackRuntime: AgentRuntime,
  allowSwitch: boolean,
): Promise<RuntimeCommandRecoveryChoice> {
  log.error(err.message);
  if (err.cleanupUnverified) {
    while (true) {
      const choice = await select({
        message: `${label} is paused until probe cleanup is verified. Choose a resolution.`,
        options: [
          { value: "retry", label: "Recheck cleanup after repairing process visibility" },
          { value: "help", label: "Show platform-specific resolution approaches" },
          { value: "cancel", label: "Cancel deliberately; keep project files" },
        ],
      });
      if (isCancel(choice) || choice === "cancel") return "cancel";
      if (choice === "help") { log.info(runtimeCleanupRecoveryHelp()); continue; }
      return "retry";
    }
  }
  log.info(
    "Cancel stops this command and keeps project files in place. It does not uninstall packages, delete generated files, or change configuration.",
  );
  if (!allowSwitch) {
    log.info("Switching runtimes is disabled while resuming because session IDs are runtime-specific.");
  }
  const options = [
    { value: "retry", label: "Fix manually and retry check" },
    ...(allowSwitch
      ? [{ value: "switch", label: `Use ${runtimeDisplayName(fallbackRuntime)} for now` }]
      : []),
    { value: "cancel", label: "Cancel - stop here; keep generated files" },
  ];
  const choice = await select({
    message: `${runtimeCommandLabel(err.runtime)} is not ready for ${label}. What should Foreman do?`,
    options,
  });
  if (isCancel(choice)) return "cancel";
  return choice as RuntimeCommandRecoveryChoice;
}
