import { existsSync } from "node:fs";
import { initializeSyntheticWork } from "../../src/buildSyntheticWork.js";
import { qaDigest } from "../../src/qaProtocolV2.js";
import { randomUUID } from "node:crypto";
import { WorkflowDb } from "../../src/workflowDb.js";
import { Foreman } from "../../src/foreman.js";
import { loadTicketsConfig, resolveTicketPaths } from "../../src/tickets/config.js";
import { loadTickets } from "../../src/tickets/ticketLoader.js";
import type { IsolatedQaOptions } from "../../src/qaReview.js";
import { runIsolatedQa } from "../../src/qaReview.js";
import { runBranchPlan, type BranchRunnerOptions } from "../../src/branch/runner.js";
import { createQaRecoveryPacket } from "../../src/qaRecovery.js";
import { qaVerdictOutput, remediationOutput, providerWireContract, renderProviderWireInstruction, selectedDispatchTupleV2, structuredDigest, type OutputContract, type ProviderSessionRefV1 } from "rafi-spec";
import { canonicalFixtureTurn, prepareFixtureAdapter } from "./nativeOutput.js";
import { sealedDispatchRecord } from "../../src/structuredDispatchRecord.js";

/** Test setup uses the same explicit host admission service as production approval. */
export function admitFixtureWork(db:WorkflowDb,runId:string,ticketId:string,definition:unknown={id:ticketId}):void {
  db.ensureRun(runId);
  db.admitWork({runId,kind:"ticket",ticketId,definition,approvalId:"fixture-approval",scopeRevision:"fixture-revision",provenance:{userTurn:`Test explicitly authorizes ${ticketId} in ${runId}`,reason:"Authorized execution fixture"}});
}

export class AuthorizedForeman extends Foreman {
  constructor(...args:ConstructorParameters<typeof Foreman>) {
    if (args[5]) prepareFixtureAdapter(args[0], args[5]);
    const createQa = args[7];
    if (createQa) args[7] = async (...params) => {
      const handle = await createQa(...params); prepareFixtureAdapter(handle.adapter, params[0]); return handle;
    };
    if(args[5]) {
      args[22] ??= `fixture-${randomUUID()}`;
      const db=new WorkflowDb(args[5]);
      try {
        const path=resolveTicketPaths(loadTicketsConfig(args[5]),args[5]).tickets;
        const state=db.getRun(args[22]!)?.state;
        const scope=state?.version!==undefined&&Array.isArray(state.tickets)?state.tickets:undefined;
        if(existsSync(path)) {for(const ticket of loadTickets(path))if(!scope||scope.includes(ticket.id))admitFixtureWork(db,args[22]!,ticket.id,ticket);}
        else initializeSyntheticWork(args[5],args[22]!,10,"Explicit unticketed execution fixture");
      } finally {db.close();}
    }
    super(...args);
  }
}
export async function runAuthorizedQa(opts:IsolatedQaOptions) {
  const db=new WorkflowDb(opts.recovery.projectDir);
  try {admitFixtureWork(db,opts.recovery.runId,opts.ticket.id,opts.ticket);} finally {db.close();}
  const createQa = opts.createQa;
  return runIsolatedQa({ ...opts, createQa: async (...args) => {
    const handle = await createQa(...args); prepareFixtureAdapter(handle.adapter, args[0]); return handle;
  } });
}
export async function runAuthorizedBranchPlan(opts:BranchRunnerOptions) {
  const db=new WorkflowDb(opts.projectDir);
  try {for(const node of opts.plan.nodes)admitFixtureWork(db,opts.runId,node.ticket.id,node.ticket);} finally {db.close();}
  const createBuilder = opts.createBuilder, createQa = opts.createQa;
  return runBranchPlan({ ...opts,
    createBuilder: async (...args) => prepareFixtureAdapter(await createBuilder(...args), args[0]),
    ...(createQa ? { createQa: async (...args: Parameters<NonNullable<typeof createQa>>) => {
      const handle = await createQa(...args); prepareFixtureAdapter(handle.adapter, args[0]); return handle;
    } } : {}),
  });
}
export function createAuthorizedQaRecoveryPacket(input:Parameters<typeof createQaRecoveryPacket>[0]) {
  const db=new WorkflowDb(input.projectDir);
  try {if(!db.admittedWork(input.runId,input.ticketId))admitFixtureWork(db,input.runId,input.ticketId);}finally{db.close();}
  return createQaRecoveryPacket(input);
}


/** Source-bound fixture receipt, retained through the production turn journal. */
export function seedQaReceipt(db:WorkflowDb,runId:string,ticketId:string,reviewNumber:number,sourceStateDigest:string,reviewBasisDigest:string, options: { operationId?: string; instruction?: string } = {}):string {
  const generation=db.qaTicketHead(runId,ticketId).sessionGeneration;
  const operationId=options.operationId ?? randomUUID(),at=new Date().toISOString();
  const instructionDigest = db.putEvidence("qa", options.instruction ?? "Independent review");
  const output = qaVerdictOutput;
  db.beginQaTurn({version:2,operationId,runId,ticketId,reviewNumber,sessionGeneration:generation,slot:"initial",sourceStateDigest,reviewBasisDigest,instructionDigest,intendedAt:at,providerSession:{version:2,provider:"codex",sessionId:operationId,role:"qa",stream:"qa",generation,cwd:"/tmp",configRoot:"/tmp",createdAt:at,validatedAt:at},outputContract:{protocolVersion:2,operation:output.operation,schemaVersion:output.schemaVersion,schemaDigest:output.schemaDigest}});
  const selection = fixturePolicy(output, operationId, operationId, { provider: "codex", sessionId: operationId, generation }, options.instruction ?? "Independent review");
  const turn = canonicalFixtureTurn(selection.policy,operationId,{kind:"passed",coverage:null,verifiedInstructionIds:[]},"codex");
  if (turn.structured?.state !== "candidate") throw new Error("Invalid explicit native QA fixture");
  const tuple = turn.selectedDispatch!, sealedDispatch = sealedDispatchRecord(tuple);
  db.planOperation({runId,idempotencyKey:operationId,kind:"provider-dispatch",intent:{protocolVersion:2,state:"preparing"}});
  db.sealPlannedOperationIntent(operationId,{protocolVersion:2,tuple,sealedDispatch,sessionRef:{provider:"codex",sessionId:operationId,role:"qa",stream:"qa",generation,cwd:"/tmp",configRoot:"/tmp"}});
  db.sealStructuredOwnerDispatch(operationId,tuple,selection.instruction);
  db.updateOperation(operationId,"in_progress");
  const {value,...metadata}=turn.structured;
  const valueDigest=db.putEvidence("qa",Buffer.from(JSON.stringify(value)));
  const responseDigest=db.putEvidence("qa",Buffer.from(JSON.stringify({version:2,tupleDigest:tuple.digest,hostTurnId:turn.turnId,receipt:metadata,valueDigest})));
  db.updateOperation(operationId,"confirmed",{result:{validation:"accepted",responseDigest}});
  const receipt={version:2 as const,operationId,dispatch:"completed" as const,providerTurnId:operationId,providerInstructionDigest:db.putEvidence("qa",selection.instruction),terminalEventObserved:true,sourceStateDigest,reviewBasisDigest,completedAt:at,structuredResponseDigest:responseDigest,sealedDispatch};
  db.finishQaTurn(receipt);return qaDigest("turn-receipt",receipt);
}

/** Explicit native remediation evidence, sealed before the simulated provider return. */
export function seedRemediationReceipt(db: WorkflowDb, operationId: string, presentation = { summary: "Fixed", response: "Presentation only" }): import("../../src/qaProtocolV2.js").BuilderRemediationReceiptV3 {
  const attempt = db.qaRemediationAttempt(operationId)!;
  const review = db.qaReviewAttempt(attempt.reviewAttemptId)!;
  const occurrence = db.qaReport(review.reportDigest!, { runId: attempt.runId, ticketId: attempt.ticketId, reviewNumber: review.reviewNumber })!;
  const turnRecordId = randomUUID(), at = new Date().toISOString();
  const session = { version: 1 as const, provider: "codex" as const, sessionId: turnRecordId, role: "builder" as const, stream: "builder", generation: 0, cwd: "/tmp", configRoot: "/tmp", source: "observed" as const, createdAt: at };
  const record: import("../../src/qaDeliveryJournal.js").QaDeliveryTurn = { version: 4, turnRecordId, operationId, reportOccurrenceId: occurrence.reportOccurrenceId, turnIndex: 0, kind: "remediation", status: "intended", intendedSession: session, hostInstructionDigest: db.putEvidence("handoff", "fixture"), hostInstructionBytes: 7, providerInstructionAvailability: "unavailable", sourceCapture: "pending", startedAt: at };
  db.recordQaFailureHandoffPrepared({ handoffId: "fixture-handoff", operationId, runId: attempt.runId, ticketId: attempt.ticketId, reviewAttemptId: attempt.reviewAttemptId, reportDigest: review.reportDigest!, generation: attempt.generation, reviewedContentDigest: review.sourceDigest, reviewBasisDigest: "basis-1", handoffDigest: record.hostInstructionDigest, hostInstructionDigest: record.hostInstructionDigest });
  db.recordQaDeliveryTurn(record);
  const selection = fixturePolicy(remediationOutput, turnRecordId, operationId, session, "fixture");
  const turn = canonicalFixtureTurn(selection.policy, turnRecordId,
    { status: "done", reason: null, coverage: null, report: { version: 3, handoff_id: "fixture-handoff", summary: presentation.summary, findings: [{ finding_key: "fixture-finding", raw_id: "F1", disposition: "fixed", changes: ["Applied fix"], evidence: "Observed change", verification: [{ check: "test", outcome: "passed", evidence: "Observed pass" }] }], observations: [] } }, "codex");
  if (turn.structured?.state !== "candidate") throw new Error("Invalid native remediation fixture");
  const tuple = turn.selectedDispatch!, sealedDispatch = sealedDispatchRecord(tuple);
  db.planOperation({ runId: attempt.runId, idempotencyKey: turnRecordId, kind: "provider-dispatch", intent: { protocolVersion: 2, state: "preparing" } });
  db.sealPlannedOperationIntent(turnRecordId, { protocolVersion: 2, tuple, sealedDispatch, sessionRef: session });
  db.sealStructuredOwnerDispatch(turnRecordId, tuple, selection.instruction);
  db.updateOperation(turnRecordId, "in_progress");
  const { value, ...receipt } = turn.structured;
  const valueDigest = db.putEvidence("qa", JSON.stringify(value));
  const responseDigest = db.putEvidence("qa", JSON.stringify({ version: 2, tupleDigest: tuple.digest, hostTurnId: turn.turnId, receipt, valueDigest }));
  db.updateOperation(turnRecordId, "confirmed", { result: { validation: "accepted", responseDigest } });
  const rawResponseDigest = db.putEvidence("qa", presentation.response), summaryDigest = db.putEvidence("qa", presentation.summary);
  db.recordQaDeliveryTurn({ ...record, sealedDispatch, status: "completed", structuredResponseDigest: responseDigest, rawResponseDigest, providerTurnId: turnRecordId, completedAt: at });
  return { version: 3, operationId, runId: attempt.runId, ticketId: attempt.ticketId, reportDigest: review.reportDigest!, reportOccurrenceId: occurrence.reportOccurrenceId, turnRecordId, sourceStateDigest: review.sourceDigest, requestDigest: attempt.requestDigest, responseDigest: rawResponseDigest, summaryDigest, providerTurnId: turnRecordId, completedAt: at };
}

export function nativeQaFix(projectDir: string, runId: string, summary: string, response = summary, ticketId = "T1") {
  const db = new WorkflowDb(projectDir);
  try {
    const attempt = db.qaRemediationAttempts(runId, ticketId).at(-1)!;
    const receipt = seedRemediationReceipt(db, attempt.attemptId, { summary, response });
    return { ok: true as const, outcome: "remediation-reported" as const, summary, response, providerTurnId: receipt.providerTurnId };
  } finally { db.close(); }
}

function fixturePolicy(output: OutputContract, dispatchId: string, actionId: string, session: Pick<ProviderSessionRefV1, "provider" | "sessionId" | "generation">, text: string) {
  const wireContract = providerWireContract(output, session.provider), instruction = renderProviderWireInstruction(text, wireContract);
  const selectedDispatch = selectedDispatchTupleV2({ operation: output.operation, schemaVersion: output.schemaVersion, schemaDigest: output.schemaDigest,
    provider: session.provider, profile: wireContract.profile, variant: wireContract.variant, descriptorDigest: wireContract.descriptorDigest,
    wireSchemaDigest: wireContract.wireSchemaDigest, guidanceDigest: wireContract.guidanceDigest, normalizerId: wireContract.normalizerId,
    normalizerVersion: wireContract.normalizerVersion, maximumSchemaBytes: wireContract.maximumSchemaBytes, maximumResponseBytes: wireContract.maximumResponseBytes,
    maximumPageBytes: wireContract.maximumPageBytes ?? null, instructionDigest: structuredDigest(instruction), actionId, dispatchId, sessionId: session.sessionId, generation: session.generation });
  return { instruction, policy: { output, wireContract, renderedWireContractDigest: wireContract.descriptorDigest, dispatchId, logicalActionId: actionId, selectedDispatch } };
}
