import type { AgentRuntime } from "./compiler.js";
import { probeRuntime, formatRuntimeProbeFailure, RuntimeCleanupError, runtimeCleanupRecoveryHelp } from "ai-foreman/runtime-readiness.js";
import { requireClaudeSDK } from "ai-foreman/claude-adapter.js";
import {
  isRuntimeAuthFailure,
  runtimeCommandLabel,
  runtimeRepairCommands,
} from "./compiler.js";
import { currentActivity } from "ai-foreman/activity.js";

export type RuntimeReadinessChoice = "retry" | "switch" | "cancel";

export interface RuntimeReadinessErrorOptions {
  runtime: AgentRuntime;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  cause?: unknown;
}

export class RuntimeReadinessError extends Error {
  readonly runtime: AgentRuntime;
  readonly exitCode?: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly authLikely: boolean;
  readonly cleanupUnverified: boolean;

  constructor(opts: RuntimeReadinessErrorOptions) {
    super(formatRuntimeReadinessFailure(opts), { cause: opts.cause });
    this.name = "RuntimeReadinessError";
    this.runtime = opts.runtime;
    this.exitCode = opts.exitCode;
    this.stdout = opts.stdout ?? "";
    this.stderr = opts.stderr ?? "";
    this.authLikely = isRuntimeAuthFailure(`${this.stderr}\n${this.stdout}`);
    this.cleanupUnverified = opts.cause instanceof RuntimeCleanupError;
  }
}

export async function checkAgentRuntimeReady(targetDir: string, runtime: AgentRuntime): Promise<void> {
  const result = await probeRuntime(targetDir, runtime, { phase: "readiness" });
  if (!result.ok) throw new RuntimeReadinessError({
    runtime,
    exitCode: result.exitCode,
    stderr: formatRuntimeProbeFailure(result),
  });
  if (runtime === "claude") {
    try {
      await requireClaudeSDK();
    } catch (err) {
      throw new RuntimeReadinessError({
        runtime,
        stderr: err instanceof Error ? err.message : String(err),
        cause: err,
      });
    }
  }
}

export async function ensureAgentRuntimesReady(
  targetDir: string,
  runtimes: readonly AgentRuntime[],
  choose: (err: RuntimeReadinessError, otherRuntime: AgentRuntime) => Promise<RuntimeReadinessChoice>,
  check: (targetDir: string, runtime: AgentRuntime) => void | Promise<void> = checkAgentRuntimeReady,
): Promise<AgentRuntime[]> {
  const selected = uniqueRuntimes(runtimes);
  for (const originalRuntime of selected) {
    let runtime = originalRuntime;
    let switched = false;
    while (true) {
      try {
        await check(targetDir, runtime);
        if (switched) return [runtime];
        break;
      } catch (err) {
        const failure = err instanceof RuntimeReadinessError
          ? err
          : new RuntimeReadinessError({ runtime, cause: err, stderr: err instanceof Error ? err.message : String(err) });
        const fallbackRuntime = otherRuntime(runtime);
        const choice = await choose(failure, fallbackRuntime);
        if (choice === "retry") {
          currentActivity()?.note(`rafi: retrying ${runtime} readiness check`);
          continue;
        }
        if (choice === "switch") {
          currentActivity()?.note(`rafi: checking fallback runtime ${fallbackRuntime}`);
          runtime = fallbackRuntime;
          switched = true;
          continue;
        }
        throw failure;
      }
    }
  }
  return selected;
}

export function formatRuntimeReadinessFailure(opts: RuntimeReadinessErrorOptions): string {
  if (opts.cause instanceof RuntimeCleanupError) return `${opts.cause.message}\n\nCreate is paused before further provider work. This is a process cleanup problem; changing login or provider will not clear it.\n\n${runtimeCleanupRecoveryHelp()}`;
  const output = [opts.stderr, opts.stdout].filter(Boolean).join("\n").trim();
  const exit = opts.exitCode === undefined || opts.exitCode === null ? "unknown" : String(opts.exitCode);
  const authLine = isRuntimeAuthFailure(output)
    ? "The runtime output looks like an authentication failure."
    : "The selected runtime failed; review the actual output below before changing authentication.";
  const details = output ? `\n\nRuntime output:\n${truncateRuntimeOutput(output)}` : "";
  return (
    `${runtimeCommandLabel(opts.runtime)} failed the create-time readiness check (exit code ${exit}).\n\n` +
    `${authLine}\n\n` +
    "Repair and verify:\n" +
    indent(runtimeRepairCommands(opts.runtime)) +
    details
  );
}

export { runtimeCleanupRecoveryHelp } from "ai-foreman/runtime-readiness.js";

export async function promptProbeCleanupRecovery(message: string, label: string): Promise<"retry" | "cancel"> {
  const { select, isCancel, log } = await import("@clack/prompts");
  log.error(message);
  while (true) {
    const choice = await select({ message: `${label} is paused until the previous probe is safely cleaned up.`, options: [
      { value: "retry", label: "Recheck cleanup after repairing process visibility" },
      { value: "help", label: "Show platform-specific resolution approaches" },
      { value: "cancel", label: "Cancel deliberately; preserve current files and settings" },
    ] });
    if (isCancel(choice) || choice === "cancel") return "cancel";
    if (choice === "help") { log.info(runtimeCleanupRecoveryHelp()); continue; }
    return "retry";
  }
}

function uniqueRuntimes(runtimes: readonly AgentRuntime[]): AgentRuntime[] {
  const out: AgentRuntime[] = [];
  for (const runtime of runtimes) {
    if (!out.includes(runtime)) out.push(runtime);
  }
  return out;
}

function otherRuntime(runtime: AgentRuntime): AgentRuntime {
  return runtime === "claude" ? "codex" : "claude";
}

function outputToString(value: string | Buffer | undefined): string {
  if (!value) return "";
  return Buffer.isBuffer(value) ? value.toString("utf8") : value;
}

function truncateRuntimeOutput(output: string): string {
  const max = 2000;
  if (output.length <= max) return output;
  return `${output.slice(0, max).trimEnd()}\n... truncated ...`;
}

function indent(value: string): string {
  return value.split("\n").map((line) => `  ${line}`).join("\n");
}
