import type { BuilderAdapter } from "../adapters/types.js";
import { OperationDeadline } from "../util/deadline.js";
import { graphContext, sendGraphTurn } from "./turn.js";
import { WorkflowReader } from "../workflowReader.js";
import type { GraphExchangeV1 } from "rafi-spec";
import { inheritGraphDerivedAccess, type GraphDerivedAccess } from "./derived.js";
import { digest } from "./util.js";

/** One reserved preparation operation owns all optional evidence subturns. */
export async function sendPreparationGraphTurn(adapter: BuilderAdapter, instruction: string, input: {
  phase: "planner" | "prepare" | "assess" | "challenge" | "repair";
  projectDir: string; workspace: string; accessWorkspace?: string; sourceRef: string;
  runId: string; workId: string; operationId: string; remainingMs: number;
}) {
  const purpose = input.phase === "planner" ? "planning" : input.phase === "assess" ? "preparation-assessment"
    : input.phase === "challenge" ? "preparation-challenge" : "qa-preparation";
  const context = graphContext(input.projectDir, input.workspace, purpose, instruction, {
    runId: input.runId, workId: input.workId, operationId: input.operationId,
    logicalTaskId: input.operationId, sourceRef: input.sourceRef, accessWorkspace: input.accessWorkspace,
  });
  const policy = { purpose: input.phase === "repair" ? "response-repair" as const
    : input.phase === "planner" ? "planning" as const : "preparation" as const,
    responseOnly: input.phase === "repair" };
  const deadline = new OperationDeadline("QA preparation graph exchange", input.remainingMs);
  let expired = false;
  const result = await deadline.run(() => sendGraphTurn(adapter, instruction, context, policy, (text, turnPolicy) => {
    // A read already in flight may finish after timeout. It must not dispatch again.
    if (expired || deadline.remaining() <= 0) throw new Error("Preparation deadline expired; graph continuation cannot dispatch");
    return adapter.sendTurn(text, turnPolicy);
  }), () => { expired = true; void adapter.close().catch(() => {}); });
  const reader = new WorkflowReader(input.projectDir);
  try {
    const session = adapter.sessionId();
    if (session) inheritGraphDerivedAccess(reader.graphRecord<{ grants: GraphDerivedAccess[] }>("session-access", digest("session-access", { provider: adapter.agent, session }))?.value.grants ?? []);
    const exchange = reader.graphRecord<GraphExchangeV1>("exchange", input.operationId)?.value;
    const graphReceiptRefs: string[] = [];
    if (exchange) for (let round = 0; round <= exchange.rounds; round++) {
      const id = `${input.operationId}:${round}`;
      if (reader.graphRecord("receipt", id)) graphReceiptRefs.push(id);
    }
    return { ...result, graphReceiptRefs };
  } finally { reader.close(); }
}
