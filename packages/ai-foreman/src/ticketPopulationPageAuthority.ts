import { AsyncLocalStorage } from "node:async_hooks";
import type { SelectedDispatchTupleV2 } from "rafi-spec";
import type { WorkflowDb } from "./workflowDb.js";

export interface TicketPopulationPageScope {
  readonly projectDir: string;
  readonly artifactId: string;
  readonly runId: string;
  readonly lineageId: string;
  readonly leaseId: string;
}
const populationPage = new AsyncLocalStorage<TicketPopulationPageScope>();
export function withTicketPopulationPage<T>(scope: TicketPopulationPageScope, dispatch: () => Promise<T>): Promise<T> {
  return populationPage.run(Object.freeze({ ...scope }), dispatch);
}
/** Only the population owner with a persisted artifact intent may select a page. */
export function sealTicketPopulationPage(db: WorkflowDb, root: string, tuple: SelectedDispatchTupleV2): void {
  if (tuple.operation !== "ticket-population-page") return;
  const scope = populationPage.getStore();
  const artifact = scope && db.operation(scope.artifactId);
  if (!scope || scope.projectDir !== root || !artifact || artifact.kind !== "ticket-population-artifact" ||
    artifact.runId !== scope.runId || artifact.status !== "in_progress" ||
    (artifact.intent as TicketPopulationPageScope).lineageId !== scope.lineageId ||
    (artifact.intent as TicketPopulationPageScope).leaseId !== scope.leaseId)
    throw new Error("Ticket population pages require their active persisted artifact owner");
  const prior = db.populationPageLedger(scope.artifactId);
  if (prior && prior.state !== "open") throw new Error("Ticket population artifact is already terminal");
  db.beginPageLedger({ ...scope, tupleDigest: prior?.tupleDigest ?? tuple.digest });
  db.planOperation({ runId: scope.runId, idempotencyKey: `${scope.artifactId}:page:${tuple.dispatchId}`,
    kind: "ticket-population-page-binding", intent: { ...scope, tupleDigest: tuple.digest } });
}

export function assertTicketPopulationPageBinding(db: WorkflowDb, scope: TicketPopulationPageScope, tuple: SelectedDispatchTupleV2): void {
  const binding = db.operation(`${scope.artifactId}:page:${tuple.dispatchId}`);
  const intent = binding?.intent as (TicketPopulationPageScope & { tupleDigest: string }) | undefined;
  if (!intent || binding?.kind !== "ticket-population-page-binding" || binding.runId !== scope.runId ||
    intent.tupleDigest !== tuple.digest || intent.lineageId !== scope.lineageId || intent.leaseId !== scope.leaseId)
    throw new Error("Ticket page receipt belongs to another artifact or lineage");
}
