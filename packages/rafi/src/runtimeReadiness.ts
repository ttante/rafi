import type { AgentRuntime } from "./compiler.js";
import { probeRuntime, formatRuntimeProbeFailure } from "ai-foreman/runtime-readiness.js";
import {
  isRuntimeAuthFailure,
  runtimeCommandLabel,
  runtimeRepairCommands,
} from "./compiler.js";

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

  constructor(opts: RuntimeReadinessErrorOptions) {
    super(formatRuntimeReadinessFailure(opts), { cause: opts.cause });
    this.name = "RuntimeReadinessError";
    this.runtime = opts.runtime;
    this.exitCode = opts.exitCode;
    this.stdout = opts.stdout ?? "";
    this.stderr = opts.stderr ?? "";
    this.authLikely = isRuntimeAuthFailure(`${this.stderr}\n${this.stdout}`);
  }
}

export async function checkAgentRuntimeReady(targetDir: string, runtime: AgentRuntime): Promise<void> {
  const result = await probeRuntime(targetDir, runtime, { phase: "readiness" });
  if (!result.ok) throw new RuntimeReadinessError({
    runtime,
    exitCode: result.exitCode,
    stderr: formatRuntimeProbeFailure(result),
  });
}

export async function ensureAgentRuntimesReady(
  targetDir: string,
  runtimes: readonly AgentRuntime[],
  choose: (err: RuntimeReadinessError, otherRuntime: AgentRuntime) => Promise<RuntimeReadinessChoice>,
  check: (targetDir: string, runtime: AgentRuntime) => void | Promise<void> = checkAgentRuntimeReady,
): Promise<AgentRuntime[]> {
  const selected = uniqueRuntimes(runtimes);
  for (const runtime of selected) {
    while (true) {
      try {
        await check(targetDir, runtime);
        break;
      } catch (err) {
        const failure = err instanceof RuntimeReadinessError
          ? err
          : new RuntimeReadinessError({ runtime, cause: err });
        const fallbackRuntime = otherRuntime(runtime);
        const choice = await choose(failure, fallbackRuntime);
        if (choice === "retry") continue;
        if (choice === "switch") {
          await check(targetDir, fallbackRuntime);
          return [fallbackRuntime];
        }
        throw failure;
      }
    }
  }
  return selected;
}

export function formatRuntimeReadinessFailure(opts: RuntimeReadinessErrorOptions): string {
  const output = [opts.stderr, opts.stdout].filter(Boolean).join("\n").trim();
  const exit = opts.exitCode === undefined || opts.exitCode === null ? "unknown" : String(opts.exitCode);
  const authLine = isRuntimeAuthFailure(output)
    ? "The runtime output looks like an authentication failure."
    : "This often means the selected agent runtime is missing or not authenticated.";
  const details = output ? `\n\nRuntime output:\n${truncateRuntimeOutput(output)}` : "";
  return (
    `${runtimeCommandLabel(opts.runtime)} failed the create-time readiness check (exit code ${exit}).\n\n` +
    `${authLine}\n\n` +
    "Repair and verify:\n" +
    indent(runtimeRepairCommands(opts.runtime)) +
    details
  );
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
