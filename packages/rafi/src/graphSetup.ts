import { WorkflowDb } from "ai-foreman/workflow-db.js";
import { WorkflowReader } from "ai-foreman/workflow-reader.js";
import type { GraphAdoptionV1 } from "rafi-spec";
import { createRoleBuilder } from "ai-foreman/agent-run.js";
import { refreshGraph, graphSemanticHost, loadGraphConfig, type GraphMaintenanceOutcome } from "ai-foreman/graph-maintenance.js";
import type { RoleBuilder } from "ai-foreman/agent-run.js";
/** An accepted but never-started initial build survives interrupted compilation.
 * An intended/failed build requires explicit graph recovery, never blind replay. */
export function pendingSetupGraph(root: string): GraphAdoptionV1 | undefined {
  const config = loadGraphConfig(root);
  if (!config.enabled || config.adoption?.authorization !== "setup") return;
  const reader = new WorkflowReader(root);
  try { return reader.graphRecord("job", `setup:${config.adoption.initialOperationId}`) ? undefined : config.adoption; }
  finally { reader.close(); }
}
/** Accepted setup uses its configured Planner host only if semantic work exists.
 * AST-only initialization never creates a provider session. The semantic worker
 * remains isolated, packet-only and bound to the selected host's settings. */
export async function initializeSetupGraph(root: string, taskId: string, python: string,
  createHost: typeof createRoleBuilder = createRoleBuilder): Promise<GraphMaintenanceOutcome> {
  let role: RoleBuilder | undefined;
  const db = new WorkflowDb(root);
  try {
    const key = `setup:${taskId}`, store = db.graphStore();
    if (store.get("job", key)) throw new Error("Setup graph initialization already started; use explicit graph recovery instead of replay");
    store.put("job", key, { state: "setup-initial-intended", operationId: taskId }, 0);
    const outcome = await refreshGraph(root, root, taskId, { python, semanticHost: async (chunks, operationId, budget) => {
      role ??= await createHost({ projectDir: root, role: "planner", label: "Graphify setup", yes: true,
        allowSwitch: false, persistSessionBindings: false, sandboxMode: "read-only" });
      const extract = graphSemanticHost(root, role.builder);
      if (!extract) throw new Error("semantic-runtime-unavailable: selected setup host does not expose certified runtime settings");
      return extract(chunks, operationId, budget);
    } });
    store.put("job", key, { ...outcome, setupTaskId: taskId });
    return outcome;
  } finally { db.close(); await role?.builder.close().catch(() => {}); }
}
