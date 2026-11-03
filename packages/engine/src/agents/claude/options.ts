// Query options for the Agent SDK (ARCH 11.5). The executable path is the readiness-checked `claude`.
import type { TurnRequest } from "../types.js";

export interface ClaudeOptions {
  readonly cwd: string;
  /** Absolute path to `claude` (NEW-ADP-4); undefined lets the SDK use its own. */
  readonly executable?: string;
  readonly model?: string;
  readonly resume?: string;
}

export function queryOptions(o: ClaudeOptions, first: TurnRequest, extra: Record<string, unknown>) {
  return {
    cwd: o.cwd,
    ...(o.executable ? { pathToClaudeCodeExecutable: o.executable } : {}),
    ...(o.model ? { model: o.model } : {}),
    ...(o.resume ? { resume: o.resume } : {}),
    ...(first.instructions ? { appendSystemPrompt: first.instructions } : {}),
    outputFormat: { type: "json_schema", schema: first.schema.json },
    ...extra,
  };
}
