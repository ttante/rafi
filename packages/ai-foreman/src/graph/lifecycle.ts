import { graphScope } from "./read.js";
import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { WorkflowDb } from "../workflowDb.js";
import { loadGraphConfig } from "./config.js";
import { confined } from "./util.js";
import type { GraphGenerationV1 } from "rafi-spec";
/** Loaded readers own in-memory bytes; durable consumers explicitly retain IDs. */
export function retainGraphGeneration(root: string, generationId: string, owner: string): void {
  const db = new WorkflowDb(root);
  try {
    db.graphStore().put("retention", owner, { generationId, owner, createdAt: new Date().toISOString() });
  }
  finally {
    db.close();
  }
}
export function pruneGraph(root: string): {
  removed: string[];
  retainedBytes: number;
  limited: boolean;
} {
  const config = loadGraphConfig(root), base = join(root, "graphify-out", "rafi");
  if (!existsSync(base))
    return { removed: [], retainedBytes: 0, limited: false };
  confined(root, "graphify-out/rafi");
  const db = new WorkflowDb(root);
  try {
    const store = db.graphStore();
    const protectedIds = new Set([...store.list<{
      generationId: string;
    }>("head"), ...store.list<{
      generationId: string;
    }>("retention")].map(x => x.value.generationId));
    // Active/recoverable run receipts pin their navigation generations. A graph
    // cannot become required QA authority, but pruning must respect live users.
    for (const receipt of store.list<{ runId?: string; generationIds?: string[] }>("receipt")) {
      const run = receipt.value.runId ? db.getRun(receipt.value.runId) : undefined;
      if (run && !["completed", "cancelled"].includes(run.status))
        for (const id of receipt.value.generationIds ?? []) protectedIds.add(id);
    }
    const staging = join(base, "staging");
    if (existsSync(staging)) {
      confined(root, "graphify-out/rafi/staging");
      for (const name of readdirSync(staging)) {
        const match = /^([a-f0-9]{64})-(\d+)$/.exec(name);
        if (!match) continue;
        const job = store.get<{ scope?: string }>("job", match[1])?.value;
        if (job?.scope && Date.now() - lstatSync(join(staging, name)).mtimeMs >= 86400000 && !store.ownsLease(job.scope, match[1], Number(match[2]), Date.now()))
          rmSync(confined(staging, name), { recursive: true });
      }
    }
    const dir = join(base, "generations"), removed: string[] = [];
    let retainedBytes = 0;
    if (!existsSync(dir))
      return { removed, retainedBytes, limited: false };
    confined(root, "graphify-out/rafi/generations");
    let visited = 0;
    const inventoryStarted = Date.now();
    const size = (path: string): number => {
      if (++visited > 200000 || Date.now() - inventoryStarted > 5000)
        throw new Error("Graph cleanup inventory limit exceeded");
      const st = lstatSync(path); if (st.isSymbolicLink())
        throw new Error("Refusing graph cleanup through symbolic link"); return st.isDirectory() ? readdirSync(path).reduce((n, name) => n + size(join(path, name)), 0) : st.size;
    };
    const generations = store.list<GraphGenerationV1>("generation").sort((a, b) => b.value.createdAt.localeCompare(a.value.createdAt));
    // Only known immutable Rafi generations can be deleted. Never follow an
    // arbitrary user-provided cache path or remove shared Python installations.
    for (const row of generations.filter(r => protectedIds.has(r.id))) {
      if (existsSync(join(dir, row.id)))
        retainedBytes += size(confined(dir, row.id));
    }
    const counts = new Map<string, number>();
    for (const row of generations.filter(r => !protectedIds.has(r.id))) {
      if (!/^[a-f0-9]{64}$/.test(row.id) || !existsSync(join(dir, row.id)))
        continue;
      const path = confined(dir, row.id), bytes = size(path);
      const scope = row.value.binding.workspaceRef, count = counts.get(scope) ?? 0;
      counts.set(scope, count + 1);
      if (count < 3 && Date.now() - Date.parse(row.value.createdAt) < 7 * 86400000 && retainedBytes + bytes <= config.limits.storageBytes) {
        retainedBytes += bytes;
        continue;
      }
      rmSync(path, { recursive: true });
      removed.push(row.id);
      store.put("revocation", `cache:${row.id}`, { generationId: row.id, reason: "cache-pruned", at: new Date().toISOString() });
    }
    return { removed, retainedBytes, limited: retainedBytes > config.limits.storageBytes };
  }
  finally {
    db.close();
  }
}
export function graphStorageBytes(root: string): number {
  const base = join(root, "graphify-out", "rafi");
  if (!existsSync(base))
    return 0;
  confined(root, "graphify-out/rafi");
  let entries = 0;
  const started = Date.now();
  const walk = (path: string): number => {
    if (++entries > 200000 || Date.now() - started > 5000)
      throw new Error("Graph storage inventory limit exceeded"); const st = lstatSync(path); if (st.isSymbolicLink())
      throw new Error("Graph storage contains an unsupported symbolic link"); return st.isDirectory() ? readdirSync(path).reduce((n, name) => n + walk(join(path, name)), 0) : st.size;
  };
  return ["generations", "staging", "semantic-sessions"].reduce((n, name) => n + (existsSync(join(base, name)) ? walk(join(base, name)) : 0), 0);
}

/** A checkout boundary invalidates its mutable head, never its immutable history.
 * This is metadata-only: a merge or recreation does not itself authorize extraction. */
export function invalidateGraphWorkspace(root: string, workspace: string, reason: "merge-or-rebase" | "worktree-created" | "worktree-removed"): void {
  const config = loadGraphConfig(root);
  if (!config.enabled || !existsSync(workspace)) return;
  const scope = graphScope(workspace);
  const db = new WorkflowDb(root);
  try {
    const store = db.graphStore(), head = store.get<{ generationId: string }>("head", scope);
    if (!head) return;
    store.remove("head", scope);
    store.put("revocation", `workspace:${scope}`, { reason, generationId: head.value.generationId, at: new Date().toISOString(), limitation: "Checkout changed; capture and rebind before current-source reuse" });
  } finally { db.close(); }
}
