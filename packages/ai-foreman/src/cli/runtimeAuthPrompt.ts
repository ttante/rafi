import { select, isCancel, log } from "@clack/prompts";
import { requireClaudeSDK } from "../adapters/claude.js";
import {
  checkRuntimeReady,
  RuntimeAuthError,
  runtimeCommandLabel,
  type AgentRuntime,
} from "../runtimeAuth.js";
import { otherRuntime, runtimeDisplayName } from "./runtimeSelection.js";

export type RuntimeCommandRecoveryChoice = "retry" | "switch" | "cancel";

export interface RuntimeCommandRecoveryContext {
  otherRuntime: AgentRuntime;
  allowSwitch: boolean;
}

export interface RuntimeReadyForCommandOptions {
  label: string;
  yes?: boolean;
  allowSwitch?: boolean;
  model?: string | undefined;
  check?: (projectDir: string, runtime: AgentRuntime) => void | Promise<void>;
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
}

export async function ensureRuntimeReadyForCommand(
  projectDir: string,
  runtime: AgentRuntime,
  labelOrOptions: string | RuntimeReadyForCommandOptions,
): Promise<RuntimeReadyForCommandResult> {
  const opts = typeof labelOrOptions === "string"
    ? { label: labelOrOptions }
    : labelOrOptions;
  const check = opts.check ?? checkRuntimeReady;
  const checkClaudeSdk = opts.checkClaudeSdk ?? requireClaudeSDK;
  const allowSwitch = opts.allowSwitch !== false;
  const nonInteractive = !opts.choose && (Boolean(opts.yes) || !process.stdin.isTTY || !process.stdout.isTTY);

  while (true) {
    try {
      await check(projectDir, runtime);
      return { runtime, model: opts.model, fellBack: false };
    } catch (err) {
      const failure = err instanceof RuntimeAuthError
        ? err
        : new RuntimeAuthError({ runtime, context: opts.label, cause: err });

      if (nonInteractive) {
        throw failure;
      }

      const fallbackRuntime = otherRuntime(runtime);
      const choice = opts.choose
        ? await opts.choose(failure, { otherRuntime: fallbackRuntime, allowSwitch })
        : await promptRuntimeRecovery(failure, opts.label, fallbackRuntime, allowSwitch);

      if (choice === "retry") continue;
      if (choice === "switch" && allowSwitch) {
        try {
          await check(projectDir, fallbackRuntime);
          if (fallbackRuntime === "claude") {
            await checkClaudeSdk();
          }
          if (opts.model) {
            console.log(
              `foreman: ignored --model ${opts.model} after switching to ${fallbackRuntime}; model names are provider-specific.`,
            );
          }
          console.log(`foreman: using ${runtimeDisplayName(fallbackRuntime)} for this run.`);
          return { runtime: fallbackRuntime, model: undefined, fellBack: true };
        } catch (switchErr) {
          const switchFailure = switchErr instanceof RuntimeAuthError
            ? switchErr
            : new RuntimeAuthError({ runtime: fallbackRuntime, context: opts.label, cause: switchErr });
          log.error(`Fallback runtime is not ready:\n${switchFailure.message}`);
          continue;
        }
      }

      if (choice === "cancel") {
        console.log("foreman: cancelled");
        process.exit(0);
      }

      throw failure;
    }
  }
}

async function promptRuntimeRecovery(
  err: RuntimeAuthError,
  label: string,
  fallbackRuntime: AgentRuntime,
  allowSwitch: boolean,
): Promise<RuntimeCommandRecoveryChoice> {
  log.error(err.message);
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
