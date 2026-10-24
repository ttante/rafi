import { randomUUID } from "node:crypto";
import { canonicalJson, structuredDigest, ticketPopulationPageOutput, type OutputContract, type TicketPopulationProposalV1Contract } from "rafi-spec";
import type { TurnRequest, TurnResult } from "./adapters/types.js";
import { WorkflowDb } from "./workflowDb.js";
import { operationPayload } from "./structuredOperation.js";
import { assertTicketPopulationPageBinding, withTicketPopulationPage, type TicketPopulationPageScope } from "./ticketPopulationPageAuthority.js";

type Page = { plan_id: string; revision: number; tickets: TicketPopulationProposalV1Contract["tickets"];
  retirements: TicketPopulationProposalV1Contract["retirements"]; terminal: boolean };
type PageTurn = { result: TurnResult; status: { kind: string; reason?: string; error?: string; summary?: string } };

/** Each provider page is sealed and durably appended before aggregate interpretation. */
export async function streamTicketPopulation(input: { projectDir: string; interviewId: string; correction: number;
  instruction: string; checkpoint(scope: TicketPopulationPageScope): void;
  dispatch(instruction: string, policy: TurnRequest & { output: OutputContract }): Promise<PageTurn> }): Promise<{ proposal: TicketPopulationProposalV1Contract; turn: PageTurn }> {
  const runId = `ticket-population:${input.interviewId}`;
  const artifactId = `${runId}:artifact:${input.correction}`;
  const db = new WorkflowDb(input.projectDir);
  try {
    db.enableStructuredCommunication();
    const prior = db.operation(artifactId);
    if (prior) {
      const retained = prior.intent as TicketPopulationPageScope & { instructionDigest: string };
      const header = db.populationPageLedger(artifactId);
      if (retained.instructionDigest !== structuredDigest(input.instruction) || retained.projectDir !== input.projectDir ||
        retained.runId !== runId || !header || header.state !== "terminal")
        throw new Error("Ticket population artifact already exists; reconcile retained pages before a fresh lineage");
      const pages = db.populationPageRecords(artifactId);
      const tickets: Page["tickets"] = [], retirements: Page["retirements"] = [];
      let last: TurnResult | undefined;
      let identity: Pick<Page, "plan_id" | "revision"> | undefined;
      for (const [ordinal, content] of pages.entries()) {
        const stored = JSON.parse(content) as Page & { dispatchId: string; selectedDispatchDigest: string };
        last = db.retainedStructuredTurn(stored.dispatchId);
        assertTicketPopulationPageBinding(db, retained, last.selectedDispatch!);
        const page = operationPayload<Page>(last, ticketPopulationPageOutput);
        if (last.selectedDispatch?.digest !== stored.selectedDispatchDigest ||
          canonicalJson({ ...page, selectedDispatchDigest: stored.selectedDispatchDigest, dispatchId: stored.dispatchId }) !== content ||
          page.terminal !== (ordinal === pages.length - 1) || identity && (identity.plan_id !== page.plan_id || identity.revision !== page.revision))
          throw new Error("Retained ticket page failed native replay");
        identity = { plan_id: page.plan_id, revision: page.revision };
        tickets.push(...page.tickets); retirements.push(...page.retirements);
      }
      if (!last || !identity) throw new Error("Terminal ticket population has no native pages");
      const proposal = { version: 1 as const, ...identity, tickets, retirements };
      if (Buffer.byteLength(canonicalJson(proposal)) > 6 * 1024 * 1024 || new Set(tickets.map(ticket => ticket.slice_ref)).size !== tickets.length)
        throw new Error("Retained ticket population aggregate is invalid");
      if (prior.status !== "confirmed") db.updateOperation(artifactId, "confirmed", { result: { pageCount: pages.length, recovered: true } });
      return { proposal, turn: { result: last, status: { kind: "done" } } };
    }
    const scope: TicketPopulationPageScope = { projectDir: input.projectDir, artifactId, runId,
      lineageId: `${artifactId}:${randomUUID()}`, leaseId: randomUUID() };
    db.ensureRun(runId);
    db.planOperation({ runId, idempotencyKey: artifactId, kind: "ticket-population-artifact", intent: { ...scope, instructionDigest: structuredDigest(input.instruction) } });
    db.updateOperation(artifactId, "in_progress");
    input.checkpoint(scope); // Durable interview owner exists before provider contact.
    const tickets: Page["tickets"] = [], retirements: Page["retirements"] = [];
    let identity: Pick<Page, "plan_id" | "revision"> | undefined;
    let predecessorDigest: string | null = null;
    let last: PageTurn | undefined;
    try {
      for (let ordinal = 0; ordinal < 60; ordinal++) {
        last = await withTicketPopulationPage(scope, () => input.dispatch(`${input.instruction}\n\n` +
          `Return page ${ordinal + 1} of at most 60 using the native ticket-population-page contract. ` +
          `At most 150 tickets and 750 KiB canonical bytes per page; all pages together must fit 6 MiB. ` +
          `Do not repeat prior tickets or retirements. terminal must be true only when the complete proposal has been supplied. ` +
          `Keep plan_id and revision identical across pages. Previous page digest: ${predecessorDigest ?? "none"}. ` +
          `Already retained ticket slice references: ${JSON.stringify(tickets.map(ticket => ticket.slice_ref))}.`,
        { output: ticketPopulationPageOutput, journalRunId: runId }));
        if (last.result.isError || last.result.failure) throw new Error(last.status.reason ?? last.status.error ?? "Ticket population page was rejected");
        const page = operationPayload<Page>(last.result, ticketPopulationPageOutput);
        const tuple = last.result.selectedDispatch;
        if (!tuple) throw new Error("Ticket page has no native tuple");
        assertTicketPopulationPageBinding(db, scope, tuple);
        db.replayStructuredDispatch(tuple.dispatchId, ticketPopulationPageOutput);
        const header = db.populationPageLedger(artifactId);
        if (!header) throw new Error("Ticket page was sent before its artifact was sealed");
        const content = canonicalJson({ ...page, selectedDispatchDigest: tuple.digest, dispatchId: tuple.dispatchId });
        const appended = db.appendPageLedger({ ...scope, tupleDigest: header.tupleDigest, ordinal,
          predecessorDigest, content, terminal: page.terminal });
        // Domain interpretation begins only after the immutable page is durable.
        if (identity && (identity.plan_id !== page.plan_id || identity.revision !== page.revision)) throw new Error("Ticket page changed plan identity");
        identity = { plan_id: page.plan_id, revision: page.revision };
        tickets.push(...page.tickets); retirements.push(...page.retirements);
        predecessorDigest = appended.digest;
        if (!page.terminal) continue;
        const proposal = { version: 1 as const, ...identity, tickets, retirements };
        if (Buffer.byteLength(canonicalJson(proposal)) > 6 * 1024 * 1024) throw new Error("Ticket population aggregate exceeds 6 MiB");
        if (new Set(tickets.map(ticket => ticket.slice_ref)).size !== tickets.length) throw new Error("Ticket pages contain duplicate slices");
        db.updateOperation(artifactId, "confirmed", { result: { pageCount: ordinal + 1, terminalDigest: appended.digest } });
        return { proposal, turn: last };
      }
      throw new Error("Ticket population did not terminate within 60 pages");
    } catch (error) {
      db.updateOperation(artifactId, "uncertain", { error: String(error).slice(0, 4000) });
      throw error;
    }
  } finally { db.close(); }
}
