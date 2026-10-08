import { WorkflowDb } from "./workflowDb.js";
import { durableHumanDecision } from "./humanDecision.js";

/** Reuse a completed read-only proposal while its exact inputs remain unchanged. */
export async function durableReadOnlyProposal<T>(input: {
  projectDir: string; runId: string; ticketId: string; digest: string; operation: () => Promise<T>;
}): Promise<T> {
  const db = new WorkflowDb(input.projectDir);
  try {
    db.ensureRun(input.runId);
    for (let attempt = 0; attempt < 3; attempt++) {
      const key = `read-only-proposal:${input.runId}:${input.digest}:${attempt}`;
      const previous = db.operation(key);
      if (previous?.status === "confirmed") return previous.result as T;
      if (previous && previous.status !== "planned") {
        if (attempt === 2) break;
        await durableHumanDecision({
          projectDir: input.projectDir, runId: input.runId, ticketId: input.ticketId,
          key: `${key}:retry`, prompt: "The read-only Planner proposal did not finish durably. Authorize one new attempt?",
          choices: [{ id: "retry", label: "Retry this read-only proposal" }], defer: true,
          operation: async () => "retry",
        });
        continue;
      }
      db.planOperation({ runId: input.runId, idempotencyKey: key, kind: "read-only-proposal", intent: { digest: input.digest, ticketId: input.ticketId } });
      db.updateOperation(key, "in_progress");
      try {
        const result = await input.operation();
        db.updateOperation(key, "confirmed", { result });
        return result;
      } catch (error) {
        db.updateOperation(key, "uncertain", { error: String(error) });
        throw error;
      }
    }
    throw new Error("Read-only Planner proposal retry budget exhausted; revise the scope before requesting another proposal");
  } finally { db.close(); }
}
