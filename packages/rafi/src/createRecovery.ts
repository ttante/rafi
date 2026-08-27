import type { ProjectConfig } from "rafi-spec";
import {
  compileAsync,
  RuntimeUpdateError,
  type AgentRuntime,
  type CompileProjectOptions,
} from "./compiler.js";
import { currentActivity } from "ai-foreman/activity.js";

export type RootUpdateRecoveryChoice = "retry" | "append" | "overwrite" | "switch";

export async function compileWithRootUpdateRecovery(
  targetDir: string,
  config: ProjectConfig,
  opts: CompileProjectOptions,
  choose: (err: RuntimeUpdateError) => Promise<RootUpdateRecoveryChoice>,
): Promise<ProjectConfig> {
  let runConfig = config;
  while (true) {
    try {
      await compileAsync(targetDir, runConfig, opts);
      return runConfig;
    } catch (err) {
      if (!(err instanceof RuntimeUpdateError) || config.agent_files.mode !== "update") {
        throw err;
      }
      const choice = await choose(err);
      if (choice === "retry") {
        currentActivity()?.note(`rafi: retrying ${err.runtime} update for ${err.targetFile}`);
        runConfig = config;
      } else if (choice === "switch") {
        currentActivity()?.note(`rafi: switching runtime after ${err.runtime} update failure; retrying with ${otherRuntime(err.runtime)}`);
        runConfig = {
          ...config,
          harness: {
            ...config.harness,
            targets: [otherRuntime(err.runtime)],
          },
        };
      } else {
        runConfig = {
          ...config,
          agent_files: {
            ...config.agent_files,
            mode: choice,
          },
        };
      }
    }
  }
}

function otherRuntime(runtime: AgentRuntime): AgentRuntime {
  return runtime === "claude" ? "codex" : "claude";
}
