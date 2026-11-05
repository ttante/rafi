// Every agent step's turn (ARCH 2.2 turns/: "every agent turn"): its session per ticket, role and reply (C35, C128),
// rafi's tools in it, the permission policy, the runtime question and switch (C46), the turn runner and the
// activity feed; a turn cancelled by a stop keeps the files it changed (C137).
import type { ReplyName } from "rafi-spec/v1";
import { openQuestion, type QuestionLog } from "../ask/questions.js";
import { decidePermission } from "../agents/permissions.js";
import { openSession, type Session } from "../agents/session.js";
import type { AgentEvent, ToolRun } from "../agents/types.js";
import { agentEnv } from "../agents/env.js";
import { executeCheck, refuseCheck, untrusted } from "../build/checks.js";
import {
  allEvents, append, checkEnvFor, rulesFor, setting, ticketRuns, type BuildContext,
} from "../build/context.js";
import { throwIfStopped } from "../build/stop.js";
import { snapshot } from "../facts/snapshot.js";
import { optionalBlob } from "../log/blobs.js";
import { standingInstructions } from "../instructions/assemble.js";
import { ticketContext } from "../instructions/packs.js";
import { ticketTags } from "../instructions/tags.js";
import { toolsFor } from "../tools/registry.js";
import { definition, firstContext, recheck, reuses } from "./reuse.js";
import { toolSession } from "../tools/session.js";
import { runTurn, type TurnOutcome } from "./runner.js";

/** A fresh session's context: its ticket's tags now and what they pick (C221, C222). */
async function ownContext(ctx: BuildContext, ticket: string, role: "builder" | "qa") {
  const tags = await ticketTags(ctx.engine, definition(ctx, ticket));
  return { tags, context: await ticketContext(ctx.deps.fs, tags, role, ctx.settings) };
}

/** C128: sessions are cached by ticket, role, reply and root; a QA copy's review is its own session. C223: a reused
 * role's session is the build's (`*`), so a safe point's per-ticket close leaves it open. */
const sessionKey = (ctx: BuildContext, ticket: string, role: string, reply: string, root: string) =>
  `${reuses(ctx, role) ? "*" : ticket}|${role}|${reply}|${root}`;

async function session(ctx: BuildContext, ticket: string, role: "builder" | "qa", reply: ReplyName,
  requirementChecks: readonly string[], root: string): Promise<Session> {
  const key = sessionKey(ctx, ticket, role, reply, root);
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
  const external = Object.fromEntries(toolsFor(ctx.settings.tools?.value, role, await ticketTags(ctx.engine,
    definition(ctx, ticket))).flatMap((t) => (t.mcp ? [[t.name, t.mcp]] : [])));
  const opened = await openSession(ctx.deps, { ...a, role, reply, project: root, tools, env: shell, external },
    (t) => ctx.engine.secret(t));
  ctx.sessions.set(key, opened);
  return opened;
}

/** The session a step would use has already had a turn (C108: a re-review in it gets only what changed). */
export function sessionUsed(ctx: BuildContext, ticket: string, role: "builder" | "qa", reply: ReplyName,
  root = ctx.project): boolean {
  return (ctx.sessions.get(sessionKey(ctx, ticket, role, reply, root))?.turns ?? 0) > 0;
}

/** Closes one session (C128: the in-place review before a copy review; the copy's before cleanup). */
export async function closeSession(ctx: BuildContext, ticket: string, role: "builder" | "qa", reply: ReplyName,
  root = ctx.project): Promise<void> {
  const key = sessionKey(ctx, ticket, role, reply, root);
  const found = ctx.sessions.get(key);
  ctx.sessions.delete(key);
  await found?.close();
}

export interface AgentStep {
  readonly ticket: string;
  readonly step: string;
  readonly role: "builder" | "qa";
  /** A build's replies (C231's `risk` is a turn outside a build, turns/oneoff.ts). */
  readonly reply: Exclude<ReplyName, "risk">;
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

/** C137: a builder turn cancelled by a stop keeps its evidence: the files it changed so far. */
async function stoppedEvidence(ctx: BuildContext, s: AgentStep, root: string): Promise<void> {
  if (s.role !== "builder") return;
  const snap = await snapshot(ctx.deps, root, `${s.ticket}-stopped`, { heads: ctx.heads });
  if (!snap.ok) return;
  await append(ctx, s.ticket, { type: "facts.snapshot", data: { key: `${s.ticket}:${s.step}:${s.attempt}:stopped`,
    tree: snap.tree, base: snap.base, files: snap.files } });
}

/** C46: the runtime question in a terminal, recorded as question.opened and question.answered (kind runtime). */
function askRuntime(ctx: BuildContext, ticket: string) {
  const ask = ctx.ui.ask;
  return ask ? runtimeQuestion(ctx.engine, ctx.run, ticket, (kind, text) => ask(kind, text)) : undefined;
}

type Answer = "retry" | "switch" | "cancel";

/** Threat 9: the number comes from openQuestion, checked again inside the append's transaction. */
export function runtimeQuestion(log: QuestionLog, run: string, ticket: string,
  ask: (kind: "auth" | "quota", text: string) => Promise<Answer>) {
  return async (kind: "auth" | "quota", text: string) => {
    const { id } = await openQuestion(log, run, { kind: "runtime", tickets: [ticket], text, options: [
      { id: "retry", label: "Retry" }, { id: "switch", label: "Switch runtime" }, { id: "cancel", label: "Cancel" }],
    recommended: "retry", context: kind, urgency: "high", key: null });
    const answer = await ask(kind, text);
    await log.append([{ type: "question.answered", run_id: run, actor: "user", source: "terminal",
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

/** C148: QA broke (no verdict), and the review runs again on the same requirements file and changed files. */
export function qaBroke(ticket: string, reason: string): string {
  return `${ticket}: QA broke (no verdict): ${reason.split("\n")[0]!.slice(0, 200)}; reviewing again with the same ` +
    "requirements file and changed files.";
}

/** A turn's outcome and the tool runs it made (C111: the files a builder read come from them). */
export type AgentOutcome = TurnOutcome & { readonly tools: readonly ToolRun[] };

/** One agent step's turn, with retries, on the step's session; a runtime switch reruns it once on the other. */
export async function agentTurn(ctx: BuildContext, s: AgentStep): Promise<AgentOutcome> {
  throwIfStopped(ctx.control);
  const out = await oneTurn(ctx, s);
  if (ctx.control?.now.signal.aborted) {
    await stoppedEvidence(ctx, s, s.root ?? ctx.project);
    throwIfStopped(ctx.control);
  }
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
  let prefix = "";
  if (!sess.standing) {
    const { tags, context } = reuses(ctx, s.role) ? await firstContext(ctx, s.ticket, s.role)
      : await ownContext(ctx, s.ticket, s.role);
    sess.standing = { packs: context.packNames, tags: [...tags], lines: [...context.skills.map((k) => `skill:${
      k.name}`), ...context.tools.map((t) => `tool:${t}`)], text: await standingInstructions(ctx.deps.fs,
      ctx.project, { role: s.role, schema: s.reply, network: ctx.grants.needs.includes("internet"), writable,
      context, textSchema: a.structured ? null : sess.schema.json }) };
  } else if (reuses(ctx, s.role) && sess.ticket !== s.ticket) {
    prefix = await recheck(ctx, sess, s.ticket, s.role);
  }
  sess.ticket = s.ticket;
  const instructions = sess.standing.text;
  const grants = [...ctx.grants.needs];
  const tools: ToolRun[] = [];
  ctx.ui.turn("start", { role: s.role, ticket: s.ticket, step: s.step });
  const outcome = await runTurn(ctx.deps, sess.agent, { run: ctx.run, ticket: s.ticket, meta: { key:
    `${s.ticket}:${s.step}:${s.attempt}`, role: s.role, ticket: s.ticket, step: s.step, attempt: s.attempt },
  instructions, message: prefix ? `${prefix}\n\n${s.message}` : s.message,
  schema: a.structured ? sess.schema : { ...sess.schema, name: `${s.reply}+text` },
  reply: s.reply, grants, runtime: a.runtime, model: a.model, effort: a.effort, fast: a.fast,
  session: sess.turns++ === 0 ? "new" : "reused", tools: ["run_check", "check_output"], redo: s.redo }, {
    record: async (events) => {
      await ctx.engine.append(events);
      const retry = events.find((e) => e.type === "turn.retry")?.data as { reason?: string } | undefined;
      // C148: a review retried in the run is QA breaking, never QA rejecting.
      if (retry && s.role === "qa" && s.step === "review") ctx.ui.line(qaBroke(s.ticket, retry.reason ?? "no reply"));
    },
    // A provider that exited or lost its session gets a fresh session for the retry (5.2).
    fresh: async () => {
      await closeSession(ctx, s.ticket, s.role, s.reply, root);
      return (await session(ctx, s.ticket, s.role, s.reply, s.requirementChecks ?? [], root)).agent;
    },
    blob: (text) => optionalBlob(ctx.engine, text, { what: "the reply's raw text", run: ctx.run, ticket: s.ticket,
      key: `${s.ticket}:${s.step}:${s.attempt}` }),
    onEvent: (event) => {
      if (event.kind === "tool") tools.push(event.run);
      if (event.kind === "usage") sess.sample = { last: event.last?.total ?? null, window: event.window ?? null };
      ctx.ui.activity({ at: ctx.deps.clock.now(), role: s.role, ticket: s.ticket, event: redacted(ctx, event) });
    },
    decide: (request, repair) => {
      const answer = decidePermission(request, { root, writable, repair, grants });
      if (answer.decision === "deny" && !repair) ctx.ui.line(`${s.ticket}: refused ${request.tool}: ${answer.reason}`);
      return answer.decision;
    },
    validate: s.validate, ask: askRuntime(ctx, s.ticket), stop: ctx.control?.now.signal,
    kill: ctx.control?.kill.signal,
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
