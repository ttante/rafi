// What every step of one build shares (ARCH 4.8 "every step has the same shape"), and the agent turn every agent
// step runs through: its session (C35), its tools, the permission policy, the turn runner and the activity feed.
import type { DeliveryUnit, ReplyName, Settings, TicketV1 } from "rafi-spec/v1";
import type { Engine } from "../api/engine.js";
import { decidePermission } from "../agents/permissions.js";
import type { AgentEvent, ToolRun } from "../agents/types.js";
import type { Deps, Grants, SandboxTool } from "../deps/types.js";
import { runsOf, type RunRecord } from "../facts/runs.js";
import type { NewEvent } from "../log/types.js";
import { toolSession, type CheckRules } from "../tools/session.js";
import { runTurn, type TurnOutcome } from "../turns/runner.js";
import { standingInstructions } from "../instructions/assemble.js";
import { executeCheck, refuseCheck, untrusted, type CheckEnv } from "./checks.js";
import { agentEnv } from "./env.js";
import { openSession, type Session } from "./session.js";
import type { UiAnswer, UiQuestion } from "../ask/blocked.js";

export interface RoleAgent {
  readonly runtime: "codex" | "claude";
  readonly model: string | null;
  readonly effort: string | null;
  readonly fast: boolean;
  readonly structured: boolean;
  readonly executable: string;
}

/** What the CLI layer renders (the engine has no terminal code, ARCH 2.1). */
export interface BuildUI {
  activity(row: { at: Date; role: string; ticket: string | null; event: AgentEvent }): void;
  turn(phase: "start" | "end", o: { role: string; ticket: string | null; step: string }): void;
  line(text: string): void;
  ask?(kind: "auth" | "quota", text: string): Promise<"retry" | "switch" | "cancel">;
  /** A question in the terminal (C100): null when there's no terminal or the input ended. */
  question?(q: UiQuestion): Promise<UiAnswer>;
}

export interface BuildContext {
  readonly engine: Engine;
  readonly deps: Deps;
  readonly project: string;
  readonly run: string;
  readonly tickets: readonly TicketV1[];
  readonly units: readonly DeliveryUnit[];
  readonly settings: Settings;
  /** Per role; a runtime switch (C46) changes it for this build only. */
  readonly agents: Record<"builder" | "qa", RoleAgent>;
  readonly sandbox: SandboxTool | null;
  readonly grants: Grants;
  readonly runner: readonly string[] | null;
  readonly testScripts: readonly string[];
  readonly ui: BuildUI;
  readonly sessions: Map<string, Session>;
}

export const setting = <T>(ctx: BuildContext, key: string): T => ctx.settings[key]?.value as T;

export function ticketOf(ctx: BuildContext, id: string): TicketV1 {
  const ticket = ctx.tickets.find((t) => t.id === id);
  if (!ticket) throw new Error(`ticket ${id} isn't in tickets.yaml`);
  return ticket;
}

export async function allEvents(engine: Engine) {
  const out: { type: string; ticket_id: string | null; run_id: string | null; data: unknown; seq: number }[] = [];
  for await (const e of engine.events()) out.push(e);
  return out;
}

/** The ticket's run numbers rafi recorded and ran (refusals left out), for exact reference checks. */
export async function knownRuns(ctx: BuildContext, ticket: string): Promise<Set<number>> {
  return new Set((await ticketRuns(ctx, ticket)).filter((r) => r.outcome !== "refused").map((r) => r.run));
}

export async function ticketRuns(ctx: BuildContext, ticket: string): Promise<RunRecord[]> {
  return runsOf(await allEvents(ctx.engine), ticket);
}

/** `root`: the folder the checks run in, the project unless it's a QA copy (C128). */
export function checkEnvFor(ctx: BuildContext, ticket: string, root = ctx.project): CheckEnv {
  return { deps: ctx.deps, engine: ctx.engine, project: root, run: ctx.run, ticket, grants: ctx.grants,
    sandbox: ctx.sandbox, runner: ctx.runner, quietMs: setting<number>(ctx, "timeouts.check_quiet_minutes") * 60_000,
    limitMs: setting<number>(ctx, "timeouts.check_minutes") * 60_000,
    outputPaths: setting<string[]>(ctx, "checks.output_paths"),
    checksEnv: setting<string[]>(ctx, "checks.env") ?? [] };
}

export function rulesFor(ctx: BuildContext, requirementChecks: readonly string[], root = ctx.project): CheckRules {
  return { root, runner: ctx.runner, requirementChecks, setupScript: "scripts/rafi-setup.sh",
    testScripts: ctx.testScripts };
}

export function append(ctx: BuildContext, ticket: string | null, ...events: { type: string; data: unknown }[]) {
  return ctx.engine.append(events.map((e): NewEvent => ({ ...e, run_id: ctx.run, ticket_id: ticket,
    actor: "engine" })));
}

/** C128: sessions are cached by ticket, role, reply and root; a QA copy's review is its own session. */
const sessionKey = (ticket: string, role: string, reply: string, root: string) =>
  `${ticket}|${role}|${reply}|${root}`;

async function session(ctx: BuildContext, ticket: string, role: "builder" | "qa", reply: ReplyName,
  requirementChecks: readonly string[], root: string): Promise<Session> {
  const key = sessionKey(ticket, role, reply, root);
  const found = ctx.sessions.get(key);
  if (found) return found;
  const env = checkEnvFor(ctx, ticket, root);
  const tools = toolSession({ role, rules: rulesFor(ctx, requirementChecks, root),
    execute: async (argv) => (await executeCheck(env, argv, role)).text,
    refuse: (command, reason) => refuseCheck(env, command, reason, role),
    output: async (n) => {
      const run = (await ticketRuns(ctx, ticket)).find((r) => r.run === n);
      const text = run?.output ? ctx.engine.readBlob(run.output) : null;
      return text === null ? null : `Run ${n}'s full output, as the test run printed it:\n` +
        untrusted(text, (t) => ctx.engine.redact(t));
    } });
  const a = ctx.agents[role];
  const shell = agentEnv(ctx.deps.env, a.runtime, setting<string[]>(ctx, "agents.env") ?? [],
    ctx.deps.machine.platform, role);
  const opened = await openSession(ctx.deps, { ...a, role, reply, project: root, tools, env: shell },
    (t) => ctx.engine.secret(t));
  ctx.sessions.set(key, opened);
  return opened;
}

/** The session a step would use has already had a turn (C108: a re-review in it gets only what changed). */
export function sessionUsed(ctx: BuildContext, ticket: string, role: "builder" | "qa", reply: ReplyName,
  root = ctx.project): boolean {
  return (ctx.sessions.get(sessionKey(ticket, role, reply, root))?.turns ?? 0) > 0;
}

/** Closes one session (C128: the in-place review before a copy review; the copy's before cleanup). */
export async function closeSession(ctx: BuildContext, ticket: string, role: "builder" | "qa", reply: ReplyName,
  root = ctx.project): Promise<void> {
  const key = sessionKey(ticket, role, reply, root);
  const found = ctx.sessions.get(key);
  ctx.sessions.delete(key);
  await found?.close();
}

export interface AgentStep {
  readonly ticket: string;
  readonly step: string;
  readonly role: "builder" | "qa";
  readonly reply: ReplyName;
  readonly attempt: number;
  readonly message: string;
  readonly redo: boolean;
  readonly requirementChecks?: readonly string[];
  /** The session's root: the project, or a QA copy (C128). */
  readonly root?: string;
  validate?(value: unknown): string[] | Promise<string[]>;
}

/** Agent text and tool details go to the terminal through the engine's redactor, which knows the tokens. */
function redacted(ctx: BuildContext, event: AgentEvent): AgentEvent {
  const r = (t: string | null) => (t === null ? null : ctx.engine.redact(t));
  if (event.kind === "activity" || event.kind === "question") return { ...event, text: r(event.text)! };
  if (event.kind === "tool") {
    return { ...event, run: { ...event.run, command: r(event.run.command), error: r(event.run.error) } };
  }
  return event;
}

/** C46: the runtime question in a terminal, recorded as question.opened and question.answered (kind runtime). */
function askRuntime(ctx: BuildContext, ticket: string) {
  const ask = ctx.ui.ask;
  if (!ask) return undefined;
  return async (kind: "auth" | "quota", text: string) => {
    const id = ctx.deps.random.id();
    const no = (await allEvents(ctx.engine)).filter((e) => e.type === "question.opened").length + 1;
    await ctx.engine.append([{ type: "question.opened", run_id: ctx.run, actor: "engine", data: { id, no,
      kind: "runtime", tickets: [ticket], text, options: [{ id: "retry", label: "Retry" }, { id: "switch",
        label: "Switch runtime" }, { id: "cancel", label: "Cancel" }], recommended: "retry", context: kind,
      urgency: "high", key: null } }]);
    const answer = await ask(kind, text);
    await ctx.engine.append([{ type: "question.answered", run_id: ctx.run, actor: "user", source: "terminal",
      data: { id, choice: answer, text: null, note: null, save: "none" } }]);
    return answer;
  };
}

const NAMES = Object.freeze({ codex: "Codex", claude: "Claude" });

/** "Switch runtime": this agent, from the next turn, this build only; a new session (GUI-R13, S-TIME-2). */
async function switchRuntime(ctx: BuildContext, s: AgentStep): Promise<void> {
  const a = ctx.agents[s.role];
  const runtime = a.runtime === "claude" ? "codex" : "claude";
  ctx.agents[s.role] = { ...a, runtime, model: null, effort: null, fast: false, executable: runtime };
  await closeSessions(ctx, s.ticket);
  ctx.ui.line(`The ${s.role} now uses ${NAMES[runtime]} for this build, from the next turn; the project default is ` +
    "unchanged. It starts a new session, which loses continuity with the earlier one, and the cost may change.");
}

/** A turn's outcome and the tool runs it made (C111: the files a builder read come from them). */
export type AgentOutcome = TurnOutcome & { readonly tools: readonly ToolRun[] };

/** One agent step's turn, with retries, on the step's session; a runtime switch reruns it once on the other. */
export async function agentTurn(ctx: BuildContext, s: AgentStep): Promise<AgentOutcome> {
  const out = await oneTurn(ctx, s);
  if (out.ok || out.category !== "switch") return out;
  await switchRuntime(ctx, s);
  return oneTurn(ctx, { ...s, redo: true });
}

async function oneTurn(ctx: BuildContext, s: AgentStep): Promise<AgentOutcome> {
  const root = s.root ?? ctx.project;
  const sess = await session(ctx, s.ticket, s.role, s.reply, s.requirementChecks ?? [], root);
  const a = ctx.agents[s.role];
  const writable = s.role === "builder";
  // C130: the compiled core is rafi's own file under the project's .rafi/, which a QA copy doesn't have.
  const instructions = await standingInstructions(ctx.deps.fs, ctx.project, { role: s.role, schema: s.reply,
    network: ctx.grants.needs.includes("internet"), writable, textSchema: a.structured ? null : sess.schema.json });
  const grants = [...ctx.grants.needs];
  const tools: ToolRun[] = [];
  ctx.ui.turn("start", { role: s.role, ticket: s.ticket, step: s.step });
  const outcome = await runTurn(ctx.deps, sess.agent, { run: ctx.run, ticket: s.ticket, meta: { key:
    `${s.ticket}:${s.step}:${s.attempt}`, role: s.role, ticket: s.ticket, step: s.step, attempt: s.attempt },
  instructions, message: s.message, schema: a.structured ? sess.schema : { ...sess.schema, name: `${s.reply}+text` },
  reply: s.reply, grants, runtime: a.runtime, model: a.model, effort: a.effort, fast: a.fast,
  session: sess.turns++ === 0 ? "new" : "reused", tools: ["run_check", "check_output"], redo: s.redo }, {
    record: (events) => ctx.engine.append(events).then(() => undefined),
    blob: (text) => ctx.engine.blob(text),
    onEvent: (event) => {
      if (event.kind === "tool") tools.push(event.run);
      ctx.ui.activity({ at: ctx.deps.clock.now(), role: s.role, ticket: s.ticket, event: redacted(ctx, event) });
    },
    decide: (request, repair) => {
      const answer = decidePermission(request, { root, writable, repair, grants });
      if (answer.decision === "deny" && !repair) ctx.ui.line(`${s.ticket}: refused ${request.tool}: ${answer.reason}`);
      return answer.decision;
    },
    validate: s.validate, ask: askRuntime(ctx, s.ticket),
  }, { retries: setting<number>(ctx, "retries.turn"), idleMs: setting<number>(ctx, "timeouts.idle_minutes") * 60_000,
    quotaWaitHours: setting<number>(ctx, "retries.quota_wait_hours"),
    circlingRepeats: setting<number>(ctx, "retries.circling_repeats") });
  ctx.ui.turn("end", { role: s.role, ticket: s.ticket, step: s.step });
  return { ...outcome, tools };
}

export async function closeSessions(ctx: BuildContext, ticket?: string): Promise<void> {
  for (const [key, s] of ctx.sessions) {
    if (ticket && !key.startsWith(`${ticket}|`)) continue;
    await s.close();
    ctx.sessions.delete(key);
  }
}
