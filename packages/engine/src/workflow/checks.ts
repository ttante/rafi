// The five load checks of ARCH 4.8: reachable, fail paths end, loops limited, roles exist, types fit roles.
import { roles as builtInRoles } from "./roles.js";
import type { Role, StepEnd, Workflow, WorkflowNode } from "./types.js";

const ENDS: ReadonlySet<string> = new Set<StepEnd>(["done", "blocked", "unfixed"]);

export interface LoadProblem {
  readonly check: "reachable" | "fail-ends" | "loop-limit" | "role-exists" | "type-fits-role" | "shape";
  readonly node: string;
  readonly message: string;
}

function targets(node: WorkflowNode): string[] {
  const list = [node.onPass, node.onFail];
  if (node.limit) list.push(node.limit.exhausted);
  return list;
}

function reachable(workflow: Workflow, byId: Map<string, WorkflowNode>): Set<string> {
  const seen = new Set<string>();
  const queue = [workflow.start];
  while (queue.length) {
    const id = queue.shift()!;
    const node = byId.get(id);
    if (!node || seen.has(id)) continue;
    seen.add(id);
    queue.push(...targets(node));
  }
  return seen;
}

/** A fail path ends when following onFail from a node reaches an end or a limited loop. */
function failEnds(node: WorkflowNode, byId: Map<string, WorkflowNode>): boolean {
  const seen = new Set<string>();
  let current: WorkflowNode | undefined = node;
  while (current) {
    if (current.limit && ENDS.has(current.limit.exhausted)) return true;
    if (ENDS.has(current.onFail)) return true;
    if (seen.has(current.id)) return false;
    seen.add(current.id);
    current = byId.get(current.onFail);
  }
  return false;
}

/** Every cycle through onFail edges must pass a node with a limit. */
function loopLimited(start: WorkflowNode, byId: Map<string, WorkflowNode>): boolean {
  const stack: { node: WorkflowNode; limited: boolean; path: Set<string> }[] = [
    { node: start, limited: Boolean(start.limit), path: new Set([start.id]) },
  ];
  while (stack.length) {
    const { node, limited, path } = stack.pop()!;
    for (const next of [node.onPass, node.onFail]) {
      const target = byId.get(next);
      if (!target) continue;
      const nextLimited = limited || Boolean(target.limit);
      if (target.id === start.id) {
        if (!nextLimited) return false;
        continue;
      }
      if (path.has(target.id)) continue;
      stack.push({ node: target, limited: nextLimited, path: new Set([...path, target.id]) });
    }
  }
  return true;
}

function roleProblems(node: WorkflowNode, list: readonly Role[]): LoadProblem[] {
  if (node.type === "rafi") {
    return node.role ? [{ check: "role-exists", node: node.id, message: "a rafi step has no role" }] : [];
  }
  const role = list.find((r) => r.id === node.role);
  if (!role) return [{ check: "role-exists", node: node.id, message: `unknown role ${String(node.role)}` }];
  if (node.type === "checker" && role.permissions === "write") {
    return [{ check: "type-fits-role", node: node.id, message: `checker step with write role ${role.id}` }];
  }
  if (node.type === "maker" && role.permissions !== "write") {
    return [{ check: "type-fits-role", node: node.id, message: `maker step with read-only role ${role.id}` }];
  }
  return [];
}

export function checkWorkflow(workflow: Workflow, list: readonly Role[] = builtInRoles): LoadProblem[] {
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  const problems: LoadProblem[] = [];
  for (const node of workflow.nodes) {
    for (const target of targets(node)) {
      if (!byId.has(target) && !ENDS.has(target)) {
        problems.push({ check: "shape", node: node.id, message: `unknown next step ${target}` });
      }
    }
  }
  if (!byId.has(workflow.start)) problems.push({ check: "shape", node: workflow.start, message: "unknown start" });
  const seen = reachable(workflow, byId);
  for (const node of workflow.nodes) {
    if (!seen.has(node.id)) problems.push({ check: "reachable", node: node.id, message: "unreachable step" });
    if (!failEnds(node, byId)) problems.push({ check: "fail-ends", node: node.id, message: "fail path never ends" });
    if (!loopLimited(node, byId)) {
      problems.push({ check: "loop-limit", node: node.id, message: "loop without a limit" });
    }
    problems.push(...roleProblems(node, list));
  }
  return problems;
}
