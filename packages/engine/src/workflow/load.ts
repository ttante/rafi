// Looking up a workflow by id and version, and its digest (pinned by build.started, ARCH 4.8).
import { createHash } from "node:crypto";
import { standard } from "./standard.js";
import type { Workflow } from "./types.js";

export const builtInWorkflows: readonly Workflow[] = Object.freeze([standard]);

export function workflowDigest(workflow: Workflow): string {
  const hash = createHash("sha256").update(JSON.stringify(workflow)).digest("hex");
  return `sha256:${hash}`;
}

export function findWorkflow(
  ref: { id: string; version: number; digest?: string }, list: readonly Workflow[] = builtInWorkflows,
): Workflow | undefined {
  const found = list.find((w) => w.id === ref.id && w.version === ref.version);
  if (!found) return undefined;
  if (ref.digest !== undefined && ref.digest !== workflowDigest(found)) return undefined;
  return found;
}

export function nodeById(workflow: Workflow, id: string) {
  return workflow.nodes.find((node) => node.id === id);
}
