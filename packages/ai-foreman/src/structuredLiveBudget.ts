/** Inherited supervision for public CLI journeys, including detached workers. */
import { reserveStructuredLiveQuery, structuredLiveBudgetPath } from "rafi-spec";
import type { ProviderQueryBudget } from "./adapters/types.js";

export function inheritedStructuredLiveBudget(provider: "claude" | "codex", env = process.env): ProviderQueryBudget | undefined {
  if (!env.RAFI_STRUCTURED_LIVE_RUNNER && !env.RAFI_STRUCTURED_LIVE_BUDGET_PATH) return undefined;
  const deadline = Date.parse(env.RAFI_LIVE_DEADLINE ?? "");
  const root = env.RAFI_LIVE_RETAINED_LOG_DIRECTORY, scope = env.RAFI_LIVE_CREDENTIAL_SCOPE;
  if (env.RAFI_LIVE_STRUCTURED !== "1" || !root || !scope || !env.RAFI_STRUCTURED_LIVE_RUNNER ||
    !Number.isFinite(deadline) || deadline <= Date.now() || deadline > Date.now() + 30 * 60_000 ||
    env.RAFI_STRUCTURED_LIVE_BUDGET_PATH !== structuredLiveBudgetPath(root, scope, deadline) ||
    !(env.RAFI_LIVE_PROVIDERS ?? "claude,codex").split(",").includes(provider)) throw new Error("Invalid inherited structured live supervision");
  const requireAuthoritativeCost = env.RAFI_LIVE_REQUIRE_COST_METER === "1";
  if (requireAuthoritativeCost && provider === "codex") throw new Error("Codex live structured validation is blocked: no authoritative spend meter");
  const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  return { reserveQuery: selected => {
    if (selected !== provider) throw new Error("Inherited live provider mismatch");
    return reserveStructuredLiveQuery({ path: env.RAFI_STRUCTURED_LIVE_BUDGET_PATH!, runner: `${env.RAFI_STRUCTURED_LIVE_RUNNER}/cli-${process.pid}`,
      provider, signal, deadline, requireAuthoritativeCost });
  } };
}
