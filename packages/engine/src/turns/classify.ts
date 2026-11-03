// The one classification of a turn's ending (ARCH 5.1–5.2, NEW-ENG-4). Adapters normalize; this sorts.
// An unknown provider error is `provider` (retried), never a stop. Replies are read and validated by the runner.
import type { AgentEvent, ToolRun } from "../agents/types.js";

export type Category = "ok" | "format" | "content" | "provider" | "timeout" | "cancelled" | "quota" | "auth"
  | "environment";

export function classify(terminal: AgentEvent | null): Category {
  if (!terminal) return "provider";
  switch (terminal.kind) {
    case "error":
      if (terminal.detail === "error_max_structured_output_retries") return "content";
      if (terminal.code === "quota") return "quota";
      if (terminal.code === "auth") return "auth";
      if (terminal.code === "configuration") return "environment";
      return "provider";
    case "idle-timeout":
      return "timeout";
    case "cancelled":
      return "cancelled";
    case "reply":
      return "ok";
    default:
      return "provider";
  }
}

const EXPLORING: ReadonlySet<string> = new Set(["Read", "Glob", "Grep", "LS"]);

/** C56: a failed exploratory read that says a path wasn't found is harmless (folded to one quiet line). */
export function harmless(run: ToolRun): boolean {
  return EXPLORING.has(run.tool) && run.outcome === "failed" &&
    /does not exist|not found|no such file|ENOENT/i.test(run.error ?? "");
}
