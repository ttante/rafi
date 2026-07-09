import type { ProjectConfig } from "rafi-spec";
import {
  compile,
  RuntimeUpdateError,
  type CompileProjectOptions,
} from "./compiler.js";

export type RootUpdateRecoveryChoice = "retry" | "append" | "overwrite";

export async function compileWithRootUpdateRecovery(
  targetDir: string,
  config: ProjectConfig,
  opts: CompileProjectOptions,
  choose: (err: RuntimeUpdateError) => Promise<RootUpdateRecoveryChoice>,
): Promise<ProjectConfig> {
  let runConfig = config;
  while (true) {
    try {
      compile(targetDir, runConfig, opts);
      return runConfig;
    } catch (err) {
      if (!(err instanceof RuntimeUpdateError) || config.agent_files.mode !== "update") {
        throw err;
      }
      const choice = await choose(err);
      if (choice === "retry") {
        runConfig = config;
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
