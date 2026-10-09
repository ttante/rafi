import { formatRecoveryCommand, shellArgument } from "./recoveryGuidance.js";
import { createHash } from "node:crypto";
import { isCancel } from "@clack/prompts";
import { WorkflowDb } from "./workflowDb.js";
import { pauseActivityForInput } from "./activity.js";
import type { RunObserver } from "./observability.js";
import type { HumanDecisionChoice } from "rafi-spec";

export class HumanDecisionRequired extends Error {
  constructor(readonly decisionId: string, readonly runId: string, prompt: string, projectDir = process.cwd()) {
    super(`${prompt}\nRafi is waiting for input (${decisionId}). Answer with rafi build:decide ${shellArgument(projectDir)} --run ${runId} --decision ${decisionId} --choice <choice-id>. Resume with ${formatRecoveryCommand(projectDir, "rafi")}`);
    this.name = "HumanDecisionRequired";
  }
}
export async function durableHumanDecision<T>(input: {
  projectDir: string; runId: string; key: string; prompt: string; choices: HumanDecisionChoice[];
  ticketId?: string; defer?: boolean; observer?: RunObserver; operation: () => Promise<T>;
}): Promise<T> {
  const db = new WorkflowDb(input.projectDir);
  try {
    const key = `${input.runId}:${input.key}:${createHash("sha256").update(JSON.stringify([input.prompt, input.choices])).digest("hex")}`;
    const decision = db.ensureHumanDecision({ decisionKey: key, runId: input.runId, interruptionId: input.ticketId ? `ticket:${input.ticketId}` : input.key, prompt: input.prompt, choices: input.choices });
    if (decision.status === "answered") return (decision.answer ?? decision.selectedChoiceId) as T;
    console.error(`rafi: input required: ${input.prompt} [decision ${decision.decisionId}]`);
    const previous = db.getRun(input.runId)!;
    if (!input.defer) db.transition(input.runId, { status: "paused", checkpoint: "waiting-for-human", state: { ...previous.state, status: "recoverable", checkpoint: "waiting-for-human", phase: "waiting-for-human", pendingDecisionId: decision.decisionId } });
    if (input.defer || !process.stdin.isTTY || !process.stdout.isTTY) throw new HumanDecisionRequired(decision.decisionId, input.runId, input.prompt, input.projectDir);
    const wait = () => pauseActivityForInput(input.operation);
    const answer = await (input.observer ? input.observer.span("user_wait", input.prompt, wait) : wait());
    if (isCancel(answer) || answer === undefined) return answer;
    const selected = String(answer);
    const choice = input.choices.find(item => item.id === selected);
    if (!choice && !input.choices.some(item => item.id === "custom")) throw new Error("answer does not match the durable decision choices");
    db.answerHumanDecision(input.runId, decision.decisionId, choice?.id ?? "custom", undefined, choice ? undefined : selected);
    db.transition(input.runId, { status: previous.status, checkpoint: "decision-received", state: { ...previous.state, pendingDecisionId: undefined } });
    return answer;
  } finally { db.close(); }
}
