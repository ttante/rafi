import type { HarnessTarget } from "rafi-spec";

export type PlanningRuntimeSelection =
  | { kind: "selected"; runtime: HarnessTarget }
  | { kind: "not-required" }
  | { kind: "cancelled" };

export interface PlanningRuntimePrompts {
  select(options: {
    message: string;
    options: Array<{ value: HarnessTarget; label: string }>;
  }): Promise<unknown>;
  isCancel(value: unknown): boolean;
}

/**
 * Chooses an explicitly configured planning runtime only when an interactive
 * session has a real choice. Non-interactive callers deliberately leave the
 * runtime unspecified so their existing default-resolution behavior applies.
 */
export async function resolvePlanningRuntime(
  targets: readonly HarnessTarget[],
  interactive: boolean,
  prompts?: PlanningRuntimePrompts,
): Promise<PlanningRuntimeSelection> {
  if (targets.length === 1) return { kind: "selected", runtime: targets[0]! };
  if (!interactive || !targets.includes("claude") || !targets.includes("codex")) return { kind: "not-required" };

  const activePrompts = prompts ?? await import("@clack/prompts");
  const answer = await activePrompts.select({
    message: "Both runtimes are configured. Which should plan this session?",
    options: [
      { value: "claude", label: "Claude (Recommended)" },
      { value: "codex", label: "Codex" },
    ],
  });
  if (activePrompts.isCancel(answer)) return { kind: "cancelled" };
  if (answer === "claude" || answer === "codex") return { kind: "selected", runtime: answer };
  throw new Error("planning runtime selection was invalid");
}
