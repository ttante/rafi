import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { assertGraphConfig, DEFAULT_GRAPH_LIMITS, type GraphAdoptionV1, type GraphConfigV1 } from "rafi-spec";
import { WorkflowReader } from "../workflowReader.js";
import { digest, readBounded } from "./util.js";
export interface EffectiveGraphConfig {
  config?: GraphConfigV1;
  adoption?: GraphAdoptionV1;
  enabled: boolean;
  reason: string;
  policyDigest: string;
  projectRef: string;
  limits: typeof DEFAULT_GRAPH_LIMITS;
}
export function loadGraphConfig(configRoot: string): EffectiveGraphConfig {
  const root = realpathSync(configRoot);
  const projectRef = digest("project", root);
  let config: GraphConfigV1 | undefined;
  for (const name of ["rafi-config.yaml", "project.yaml"]) {
    const path = join(root, name);
    if (!existsSync(path))
      continue;
    const raw = parse(readBounded(path, 4 * 1024 * 1024).toString("utf8"));
    if (raw?.graph !== undefined) {
      assertGraphConfig(raw.graph);
      config = raw.graph;
    }
    break;
  }
  const reader = new WorkflowReader(root);
  let adoption: GraphAdoptionV1 | undefined;
  try {
    adoption = reader.graphRecord<GraphAdoptionV1>("adoption", "project")?.value;
  }
  finally {
    reader.close();
  }
  if (adoption) {
    if (adoption.version !== 1)
      throw new Error("Unsupported graph adoption version");
    assertGraphConfig(adoption.config);
  }
  config ??= adoption?.config;
  const policyDigest = digest("policy", config ?? null);
  const enabled = Boolean(config?.enabled && adoption && adoption.policyDigest === policyDigest && adoption.projectRef === projectRef);
  const reason = !config?.enabled ? "disabled" : !adoption ? "unadopted" : adoption.projectRef !== projectRef ? "destination-adoption-required" : adoption.policyDigest !== policyDigest ? "policy-acceptance-required" : "adopted";
  return { config, adoption, enabled, reason, policyDigest, projectRef, limits: { ...DEFAULT_GRAPH_LIMITS, ...config?.limits } };
}
