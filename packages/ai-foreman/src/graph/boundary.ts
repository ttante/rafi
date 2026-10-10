import type { BuilderAdapter } from "../adapters/types.js";
import { WorkflowDb } from "../workflowDb.js";
import { withActivityPhase } from "../activity.js";
import { loadGraphConfig } from "./config.js";
import { graphScope } from "./read.js";
import { refreshGraph } from "./maintenance.js";
import { graphSemanticHost } from "./host.js";
import { digest } from "./util.js";
export const GRAPH_CHANGE_SIGNAL = "RAFI_GRAPH_MAINTENANCE: meaningful-indexed-change";
export interface GraphPendingTask {
  version: 1;
  state: "pending" | "attempted";
  scope: string;
  workspace: string;
  logicalTaskId: string;
  reason: string;
  outcome?: unknown;
}
/** A completed editing assignment plus host-observed source change is required.
 * Changed bytes alone are deliberately insufficient to establish this trigger. */
export function queueGraphMaintenance(root: string, workspace: string, logicalTaskId: string, response: string, sourceChanged: boolean): void {
  if (!sourceChanged || !response.split(/\r?\n/).some(line => line.trim() === GRAPH_CHANGE_SIGNAL))
    return;
  const effective = loadGraphConfig(root);
  if (!effective.enabled || effective.config?.maintenance !== "selective")
    return;
  const scope = graphScope(workspace), id = digest("pending-task", { scope, logicalTaskId, policy: effective.policyDigest });
  const db = new WorkflowDb(root);
  try {
    const store = db.graphStore();
    if (!store.get("job", id))
      store.put("job", id, { version: 1, state: "pending", scope, workspace, logicalTaskId, reason: "Completed editing agent declared indexed relationships or behavior changed; host observed source change" } satisfies GraphPendingTask);
  }
  finally {
    db.close();
  }
}
export async function maintainGraphTask(root: string, workspace: string, logicalTaskId: string, host: BuilderAdapter): Promise<unknown> {
  const effective = loadGraphConfig(root);
  if (!effective.enabled || effective.config?.maintenance !== "selective")
    return;
  const scope = graphScope(workspace), id = digest("pending-task", { scope, logicalTaskId, policy: effective.policyDigest });
  const db = new WorkflowDb(root);
  try {
    const store = db.graphStore(), pending = store.get<GraphPendingTask>("job", id);
    if (!pending || pending.value.state !== "pending")
      return;
    // Reserve the attempt before awaiting any child; duplicate consumers cannot
    // each start semantic/provider work for this same editing boundary.
    store.put("job", id, { ...pending.value, state: "attempted" }, pending.revision);
    const outcome = await withActivityPhase("updating scoped Graphify evidence", () => refreshGraph(root, workspace, logicalTaskId, { semanticHost: graphSemanticHost(root, host) }));
    store.put("job", id, { ...pending.value, state: "attempted", outcome });
    if (outcome.state !== "published") console.error(`rafi graph: maintenance ${outcome.state}: ${outcome.reason ?? "inspect graph status for recovery"}`);
    return outcome;
  }
  finally {
    db.close();
  }
}
