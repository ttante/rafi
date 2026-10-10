import { formatDecisionCommands, formatExactRunRecovery } from "./recoveryGuidance.js";
import { createHash } from "node:crypto";
import { isCancel } from "@clack/prompts";
import { WorkflowDb } from "./workflowDb.js";
import { pauseActivityForInput } from "./activity.js";
import type { RunObserver } from "./observability.js";
import type { HumanDecisionChoice } from "rafi-spec";

export class HumanDecisionCancelled extends Error { constructor() { super("Build cancelled at an input prompt"); this.name = "HumanDecisionCancelled"; } }

export class HumanDecisionRequired extends Error {
  constructor(readonly decisionId: string, readonly runId: string, prompt: string, projectDir = process.cwd(), choices: HumanDecisionChoice[] = []) {
    super(`${prompt}\nRafi is waiting for input (${decisionId}).\n${formatDecisionCommands(projectDir, runId, { decisionId, choices }).join("\n")}\nResume with ${formatExactRunRecovery(projectDir, runId)}`);
    this.name = "HumanDecisionRequired";
  }
}
export async function durableHumanDecision<T>(input: {
  projectDir: string; runId: string; key: string; prompt: string; choices: HumanDecisionChoice[];
  ticketId?: string; defer?: boolean; observer?: RunObserver; operation: (signal?: AbortSignal) => Promise<T>;
}): Promise<T> {
  const db = new WorkflowDb(input.projectDir);
  try {
    const key = `${input.runId}:${input.key}:${createHash("sha256").update(JSON.stringify([input.prompt, input.choices])).digest("hex")}`;
    const legacy = db.pendingHumanDecisions(input.runId).find(item => item.interruptionId === (input.ticketId ? `ticket:${input.ticketId}` : input.key) && item.prompt === input.prompt && JSON.stringify(item.choices.map(choice => choice.label)) === JSON.stringify(input.choices.map(choice => choice.label)) && db.humanDecisionKey(item.decisionId)?.startsWith(`${input.runId}:${input.key}:`));
    const decision = legacy ?? db.ensureHumanDecision({ decisionKey: key, runId: input.runId, interruptionId: input.ticketId ? `ticket:${input.ticketId}` : input.key, prompt: input.prompt, choices: input.choices });
    if (decision.status === "answered") {
      if (input.ticketId && !db.decisionContinuationAvailable(input.runId, decision.decisionId)) throw new Error("Answered ticket decision has already been dispatched or is uncertain; reconcile before reusing its answer");
      return decisionResponse(decision) as T;
    }
    console.error(`rafi: input required: ${input.prompt} [decision ${decision.decisionId}]`);
    const previous = db.getRun(input.runId)!;
    if (!input.defer) db.transition(input.runId, { status: "paused", checkpoint: "waiting-for-human", state: { ...previous.state, status: "recoverable", checkpoint: "waiting-for-human", phase: "waiting-for-human", pendingDecisionId: decision.decisionId } });
    if (input.defer || !process.stdin.isTTY || !process.stdout.isTTY) throw new HumanDecisionRequired(decision.decisionId, input.runId, input.prompt, input.projectDir, decision.choices);
    const controller=new AbortController();
    let poll:ReturnType<typeof setInterval>|undefined;
    let remoteAnswered=false;
    const remote=new Promise<T>((resolve,reject)=>{
      poll=setInterval(()=>{
        try {
          if(input.ticketId)db.consumeInstructionControls(input.runId,input.ticketId);
          if(input.ticketId&&input.key.startsWith("qa-nonconvergence:"))db.consumeInstructionControls(input.runId,input.ticketId,"attempts");
          const current=db.humanDecision(decision.decisionId);
          if(current?.status==="answered") {remoteAnswered=true;resolve(decisionResponse(current) as T);controller.abort();}
          else if(!current||current.status!=="pending") {controller.abort();reject(new Error("Pending decision was superseded; resume the durable scoped recovery before continuing"));}
        } catch(error) {reject(error);}
      },250);
    });
    const wait = () => pauseActivityForInput(()=>Promise.race([input.operation(controller.signal),remote]));
    let answer:T;
    try {answer = await (input.observer ? input.observer.span("user_wait", input.prompt, wait) : wait());} finally {if(poll)clearInterval(poll);controller.abort();}
    if(remoteAnswered) {const current=db.getRun(input.runId)!;db.transition(input.runId,{status:previous.status,checkpoint:"decision-received",state:{...current.state,pendingDecisionId:undefined}});return answer;}
    if (isCancel(answer) || answer === undefined) return answer;
    const selected = String(answer);
    const choice = decision.choices.find(item => item.id === selected || item.label === selected);
    if (!choice && !input.choices.some(item => item.id === "custom")) throw new Error("answer does not match the durable decision choices");
    db.answerHumanDecision(input.runId, decision.decisionId, choice?.id ?? "custom", undefined, choice ? undefined : selected);
    db.transition(input.runId, { status: previous.status, checkpoint: "decision-received", state: { ...previous.state, pendingDecisionId: undefined } });
    return answer;
  } finally { db.close(); }
}

/** Fixed choices deliver their meaning, rather than a generated menu identifier. */
export function decisionResponse(decision: { answer?: string; selectedChoiceId?: string; choices: HumanDecisionChoice[] }): string | undefined {
  return decision.answer ?? (decision.selectedChoiceId?.startsWith("option-") ? decision.choices.find(choice => choice.id === decision.selectedChoiceId)?.label : decision.selectedChoiceId);
}

/** Returns false on safe pause/EOF. Never launches a provider or grants capabilities. */
export async function servicePendingHumanDecisions(input: {
  projectDir: string; runId: string; tickets?: readonly string[]; scopeRevision?: string; observer?: RunObserver;
  prompt?: (decision: import("rafi-spec").PendingHumanDecision, signal?: AbortSignal) => Promise<string | undefined>;
}): Promise<boolean> {
  const db = new WorkflowDb(input.projectDir);
  try {
    if (input.scopeRevision) db.refreshStaleTicketDecisions(input.runId, input.scopeRevision, input.tickets);
    for (const work of db.workDefinitions(input.runId)) if (!input.tickets || input.tickets.includes(work.workId)) {
      db.consumeInstructionControls(input.runId,work.workId);
      db.consumeInstructionControls(input.runId,work.workId,"attempts");
    }
    const applicable = () => db.pendingHumanDecisions(input.runId).filter(decision => !input.tickets || !db.decisionWorkId(decision) || input.tickets.includes(db.decisionWorkId(decision)!));
    for (const decision of applicable()) {
      if(db.humanDecision(decision.decisionId)?.status!=="pending")continue;
      const run = db.getRun(input.runId)!;
      db.transition(input.runId, { status: "paused", checkpoint: "waiting-for-human", state: { ...run.state, status: "recoverable", phase: "waiting-for-human", checkpoint: "waiting-for-human", pendingDecisionId: decision.decisionId } });
      if (!input.prompt && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new HumanDecisionRequired(decision.decisionId, input.runId, decision.prompt, input.projectDir, decision.choices);
      const controller=new AbortController();
      const ask = async () => {
        if (input.prompt) return input.prompt(decision,controller.signal);
        const { select, text } = await import("@clack/prompts");
        const choice = await select({ message: decision.prompt, signal:controller.signal, options: [...decision.choices.map(item => ({ value: item.id, label: item.label })), { value: "__rafi_pause__", label: "Pause safely" }, { value: "__rafi_cancel__", label: "Cancel build" }] });
        if (isCancel(choice) || choice === "__rafi_pause__") return undefined;
        if (choice !== "custom") return choice;
        const answer = await text({ message: "Custom response:", signal:controller.signal, validate: value => value?.trim() ? undefined : "Enter a response" });
        return isCancel(answer) ? undefined : String(answer);
      };
      let remoteAnswered=false;
      let poll:ReturnType<typeof setInterval>|undefined;
      const remote=new Promise<string|undefined>((resolve,reject)=>{
        poll=setInterval(()=>{
          try {
            const workId=db.decisionWorkId(decision);if(workId)db.consumeInstructionControls(input.runId,workId);
            if(workId)db.consumeInstructionControls(input.runId,workId,"attempts");
            const current=db.humanDecision(decision.decisionId);
            if(current?.status==="answered") {remoteAnswered=true;resolve(decisionResponse(current));controller.abort();}
            else if(current?.status==="cancelled"&&db.humanDecisionKey(decision.decisionId)?.startsWith(`${input.runId}:qa-nonconvergence:`)) {remoteAnswered=true;resolve(undefined);controller.abort();}
            else if(!current||current.status!=="pending")reject(new Error("Pending decision changed; refresh before continuing"));
          }catch(error){reject(error);}
        },250);
      });
      const wait = () => pauseActivityForInput(()=>Promise.race([ask(),remote]));
      const lease = db.currentLease();
      const heartbeat = lease?.runId === input.runId ? setInterval(() => { try { db.heartbeatLease(lease); } catch { /* fenced mutation rechecks authority after input */ } }, 10_000) : undefined;
      heartbeat?.unref();
      let answer: string | undefined;
      try { answer = await (input.observer ? input.observer.span("user_wait", decision.prompt, wait) : wait()); }
      finally { if (heartbeat) clearInterval(heartbeat);if(poll)clearInterval(poll);controller.abort(); }
      if(remoteAnswered) {const current=db.getRun(input.runId)!;db.transition(input.runId,{status:run.status,checkpoint:"decision-received",state:{...current.state,pendingDecisionId:undefined}});continue;}
      if (answer === "__rafi_cancel__") {
        db.atomic(() => {
          db.cancelPendingHumanDecisions(input.runId, "User cancelled build; pending questions superseded");
          const current = db.getRun(input.runId)!;
          db.transition(input.runId, { status: "cancelled", checkpoint: "cancelled", state: { ...current.state, status: "cancelled", checkpoint: "cancelled", pendingDecisionId: undefined }, event: "user_cancelled", payload: { source: "question-menu" } });
        });
        throw new HumanDecisionCancelled();
      }
      if (answer === undefined) return false;
      const choice = decision.choices.find(item => item.id === answer);
      db.answerHumanDecision(input.runId, decision.decisionId, choice?.id ?? "custom", undefined, choice ? undefined : answer);
      const current = db.getRun(input.runId)!;
      db.transition(input.runId, { status: run.status, checkpoint: "decision-received", state: { ...current.state, pendingDecisionId: undefined } });
    }
    return applicable().length === 0;
  } finally { db.close(); }
}
