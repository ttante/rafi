import { select, isCancel, log } from "@clack/prompts";
import {
  checkRuntimeReady,
  RuntimeAuthError,
  runtimeCommandLabel,
  type AgentRuntime,
} from "../runtimeAuth.js";

export async function ensureRuntimeReadyForCommand(
  projectDir: string,
  runtime: AgentRuntime,
  label: string,
): Promise<void> {
  while (true) {
    try {
      checkRuntimeReady(projectDir, runtime);
      return;
    } catch (err) {
      const failure = err instanceof RuntimeAuthError
        ? err
        : new RuntimeAuthError({ runtime, context: label, cause: err });
      log.error(failure.message);
      const choice = await select({
        message: `${runtimeCommandLabel(runtime)} is not ready for ${label}. Fix authentication, then retry the check.`,
        options: [
          { value: "retry", label: "Retry check" },
          { value: "cancel", label: "Cancel" },
        ],
      });
      if (isCancel(choice) || choice === "cancel") {
        console.log("foreman: cancelled");
        process.exit(0);
      }
    }
  }
}
