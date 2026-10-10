import type Database from "better-sqlite3";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { bytesDigest, digest, readBounded, canonical } from "./util.js";
import { graphExclusions } from "./corpus.js";
import type { GraphAdoptionV1 } from "rafi-spec";
import { readGraphRecord } from "./storage.js";
export interface GraphDerivedAccess {
  policyDigest: string;
  workspace: string;
  exclusionsDigest: string;
  /** Independent canonical-project exclusion baseline for worktree evidence. */
  projectExclusionsDigest?: string;
  sourceVersions: Record<string, string>;
  paths: string[];
}
const deliveryAccess = new AsyncLocalStorage<GraphDerivedAccess | GraphDerivedAccess[]>();
/** Carries provenance through asynchronous provider callbacks without tainting concurrent turns. */
export function withGraphDerivedAccess<T>(access: GraphDerivedAccess | GraphDerivedAccess[] | undefined, action: () => T): T {
  return access ? deliveryAccess.run(access, action) : action();
}
export function currentGraphDerivedAccess(): GraphDerivedAccess | GraphDerivedAccess[] | undefined {
  const access = deliveryAccess.getStore();
  return Array.isArray(access) && access.length === 0 ? undefined : access;
}
/** Expand an owning operation's provenance as it consumes retained evidence. */
export function inheritGraphDerivedAccess(access: GraphDerivedAccess[]): void {
  const current = deliveryAccess.getStore();
  if (!Array.isArray(current)) return;
  for (const grant of access)
    if (!current.some(item => canonical(item) === canonical(grant))) current.push(grant);
}
export function registerGraphDerived(db: Database.Database, bytes: string | Buffer, access: GraphDerivedAccess | GraphDerivedAccess[]): void {
  if (Array.isArray(access) && access.length === 0) return;
  db.exec("CREATE TABLE IF NOT EXISTS graph_derived_refs(digest TEXT PRIMARY KEY,access_json TEXT NOT NULL)");
  const id = bytesDigest(bytes);
  const previous = db.prepare("SELECT access_json FROM graph_derived_refs WHERE digest=?").get(id) as { access_json: string } | undefined;
  const parsed = previous ? JSON.parse(previous.access_json) : [];
  const grants: GraphDerivedAccess[] = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of Array.isArray(access) ? access : [access])
    if (!grants.some(grant => canonical(grant) === canonical(item))) grants.push(item);
  db.prepare("INSERT INTO graph_derived_refs(digest,access_json) VALUES(?,?) ON CONFLICT(digest) DO UPDATE SET access_json=excluded.access_json").run(id, JSON.stringify(grants));
}
export function graphDerivedAllowed(db: Database.Database, root: string, contentDigest: string): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='graph_derived_refs'").get())
    return true;
  const row = db.prepare("SELECT access_json FROM graph_derived_refs WHERE digest=?").get(contentDigest) as {
    access_json: string;
  } | undefined;
  if (!row)
    return true;
  try {
    const decoded = JSON.parse(row.access_json);
    if (decoded?.transferWithheld === true) return false;
    const parsed = decoded as GraphDerivedAccess | GraphDerivedAccess[];
    const grants = Array.isArray(parsed) ? parsed : [parsed];
    return grants.length > 0 && grants.every(access => {
    const path = ["rafi-config.yaml", "project.yaml"].map(p => join(root, p)).find(existsSync);
    const raw = path ? parse(readBounded(path, 4 * 1024 * 1024).toString("utf8")) : undefined;
    const adoption = readGraphRecord<GraphAdoptionV1>(db, "adoption", "project")?.value;
    const config = raw?.graph ?? adoption?.config;
    if (!config?.enabled || !adoption || adoption.projectRef !== digest("project", realpathSync(root)) || digest("policy", config) !== access.policyDigest || adoption.policyDigest !== access.policyDigest)
      return false;
    if (!existsSync(access.workspace)) return false;
    if (digest("exclusions", graphExclusions(access.workspace, access.paths).text) !== access.exclusionsDigest)
      return false;
    if (access.projectExclusionsDigest && digest("exclusions", graphExclusions(root, access.paths).text) !== access.projectExclusionsDigest)
      return false;
    for (const [id, version] of Object.entries(access.sourceVersions))
      if (!raw?.sources?.entries?.some((e: {
        id: string;
        active: boolean;
        versions: Array<{
          fingerprint: string;
        }>;
      }) => e.id === id && e.active && e.versions.some(v => v.fingerprint === version)))
        return false;
    return true;
    });
  }
  catch {
    return false;
  }
}
