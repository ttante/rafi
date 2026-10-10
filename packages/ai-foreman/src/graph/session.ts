import type { BuilderAdapter, TurnResult } from "../adapters/types.js";
import { WorkflowDb } from "../workflowDb.js";
import { WorkflowReader } from "../workflowReader.js";
import { canonical, bytesDigest, digest } from "./util.js";
import { currentGraphDerivedAccess, inheritGraphDerivedAccess, withGraphDerivedAccess, type GraphDerivedAccess } from "./derived.js";
type Dispatch = (text: string, policy?: Parameters<BuilderAdapter["sendTurn"]>[1]) => Promise<TurnResult>;
/** Provider history remains derived on later turns, even without a new graph read. */
export async function dispatchWithGraphAccess(root: string, adapter: BuilderAdapter, text: string,
  policy: Parameters<BuilderAdapter["sendTurn"]>[1], dispatch: Dispatch,
  additional: GraphDerivedAccess[] = [], writable = true): Promise<TurnResult> {
  const grants = retainedSessionGrants(root, adapter);
  const inherited = currentGraphDerivedAccess();
  for (const access of [...additional, ...(inherited ? Array.isArray(inherited) ? inherited : [inherited] : [])])
    if (!grants.some(g => canonical(g) === canonical(access))) grants.push(access);
  const protect = (values: Array<string | undefined>): void => {
    if (!grants.length || !writable) return;
    const db = new WorkflowDb(root);
    try {
      const current = adapter.sessionId();
      if (current) {
        const id = digest("session-access", { provider: adapter.agent, session: current });
        db.registerGraphEvidence(id, grants);
        db.graphStore().put("session-access", id, { grants });
      }
      for (const value of values) if (value) db.registerGraphEvidence(value, grants);
    } finally { db.close(); }
  };
  const assertAccess = (): void => {
    if (!grants.length || !writable) return;
    const check = new WorkflowReader(root);
    try { if (!check.graphEvidenceAllowed(bytesDigest(text))) throw new Error("Graph access changed; provider history and derived output require explicit recovery"); }
    finally { check.close(); }
  };
  protect([text]);
  assertAccess();
  try {
    const result = await withGraphDerivedAccess(grants, () => dispatch(text, policy));
    // Recovery may reveal or replace the native session during dispatch. Its
    // retained history must be checked before the response leaves this boundary.
    for (const access of retainedSessionGrants(root, adapter))
      if (!grants.some(g => canonical(g) === canonical(access))) grants.push(access);
    protect([text, result.text, result.cleanedResponse, result.rawResponse, result.providerInstruction]);
    assertAccess();
    return result;
  } finally { inheritGraphDerivedAccess(grants); protect([]); }
}

/** Owns derived transformations after a provider call, including retained sessions. */
export async function withGraphSessionAccess<T>(root: string, adapter: BuilderAdapter, action: () => Promise<T>): Promise<T> {
  const grants = retainedSessionGrants(root, adapter);
  const inherited = currentGraphDerivedAccess();
  if (inherited) for (const access of Array.isArray(inherited) ? inherited : [inherited])
    if (!grants.some(g => canonical(g) === canonical(access))) grants.push(access);
  try { return await withGraphDerivedAccess(grants, action); }
  finally { inheritGraphDerivedAccess(grants); }
}

function retainedSessionGrants(root: string, adapter: BuilderAdapter): GraphDerivedAccess[] {
  const reader = new WorkflowReader(root);
  let grants: GraphDerivedAccess[] = [];
  try {
    const session = adapter.sessionId();
    if (session) {
      const key = digest("session-access", { provider: adapter.agent, session });
      grants = reader.graphRecord<{ grants: GraphDerivedAccess[] }>("session-access", key)?.value.grants ?? [];
      if (grants.length && !reader.graphEvidenceAllowed(bytesDigest(key)))
        throw new Error("Provider session contains revoked graph evidence; explicit fresh source-based recovery is required");
    }
  } finally { reader.close(); }
  return grants;
}
