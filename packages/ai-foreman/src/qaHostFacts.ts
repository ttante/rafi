import { loadGraphConfig } from "./graph/config.js";

/** A read-only configuration observation, not a graph scan or proof about external Graphify installations. */
export function qaHostGraphFact(projectDir: string): string {
  try {
    const graph = loadGraphConfig(projectDir);
    return `Host observation of Rafi-managed graph configuration: ${JSON.stringify({ adoption: graph.adoption ? "recorded" : "not-recorded", enabled: graph.enabled, reason: graph.reason })}. This describes only Rafi-managed graph adoption at observation time, not any external Graphify installation; assess applicable project rules and any evidence of external adoption separately.`;
  } catch {
    return "Host observation of Rafi-managed graph configuration is unavailable; do not assume it is adopted or unadopted.";
  }
}
