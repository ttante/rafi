// Every agent turn (ARCH 4.6, 5.1–5.4): intent → send → read and validate → the one repair try → retry. Provider
// errors and timeouts back off on deps.clock; content errors are redone with the errors in plain words; every
// retry's message differs (NEW-RTY-1). The idle timeout cancels the turn, waits up to 30 s for the provider to
// confirm, then ends it. Crash boundaries 1–3 are named here. The runner records; it never prompts by itself.
import { createHash } from "node:crypto";
import { checkReply, type ReplyName } from "rafi-spec/v1";
import type {
  Agent, AgentEvent, Decision, PermissionRequest, ReplySchema, TurnMeta, TurnRequest,
} from "../agents/types.js";
import type { Clock, Hooks, Random } from "../deps/types.js";
import type { NewEvent } from "../log/types.js";
import { escapeControl } from "../log/redact.js";
import { quoted } from "../instructions/assemble.js";
import { backoffMs } from "./backoff.js";
import { classify, harmless, type Category } from "./classify.js";
import { replySignature, turnCircling } from "./circling.js";
import { acceptRepair, readReply, repairMessage } from "./repair.js";

export interface TurnSpec {
  readonly run: string;
  readonly ticket: string | null;
  readonly meta: TurnMeta;
  readonly instructions?: string;
  readonly message: string;
  readonly schema: ReplySchema;
  readonly reply: ReplyName;
  readonly grants: readonly string[];
  readonly runtime: "codex" | "claude";
  readonly model: string | null;
  readonly effort: string | null;
  readonly fast: boolean;
  readonly session: "new" | "reused";
  readonly tools: readonly string[];
  readonly redo: boolean;
}

export interface TurnIO {
  record(events: readonly NewEvent[]): Promise<void>;
  blob(text: string): Promise<string>;
  onEvent?(event: AgentEvent, key: string): void | Promise<void>;
  decide?(request: PermissionRequest, repair: boolean): Decision;
  /** rafi's own rules on a schema-valid reply (references, scope); returns errors in plain words. */
  validate?(value: unknown): string[] | Promise<string[]>;
  /** A fresh session after the provider exited or lost the session. */
  fresh?(): Promise<Agent>;
  /** The runtime question (C46) for auth and an unknown-reset quota; without one, the turn fails. */
  ask?(kind: "auth" | "quota", message: string): Promise<"retry" | "switch" | "cancel">;
}

export interface TurnLimits {
  readonly retries: number;
  readonly idleMs: number;
  readonly quotaWaitHours: number;
  /** C112: no-progress tries in a row that stop a turn's retries (`retries.circling_repeats`). */
  readonly circlingRepeats?: number;
}

export type TurnOutcome =
  | { ok: true; value: unknown; attempts: number }
  | { ok: false; category: Category | "switch"; reason: string; attempts: number; circling?: boolean };

type Deps = { clock: Clock; hooks: Hooks; random: Pick<Random, "jitter"> };

interface Sent {
  terminal: AgentEvent | null;
  timedOut: boolean;
  usage: { input: number; output: number; cost: number | null; measured: boolean };
  ms: number;
  /** What the turn's tools did (`tool command`), for turn-level circling (C112). */
  touched: string[];
}

const CONFIRM_MS = 30_000;

function label(spec: TurnSpec, attempt: number): string {
  return `${spec.ticket ?? "-"}, ${spec.meta.step ?? spec.meta.role}, attempt ${attempt}`;
}

function event(spec: TurnSpec, type: string, data: unknown): NewEvent {
  return { type, run_id: spec.run, ticket_id: spec.ticket, actor: "engine", data };
}

async function consume(deps: Deps, agent: Agent, request: TurnRequest, spec: TurnSpec, io: TurnIO,
  limits: TurnLimits): Promise<Sent> {
  const started = deps.clock.now().getTime();
  const controller = new AbortController();
  const sent: Sent = { terminal: null, timedOut: false, usage: { input: 0, output: 0, cost: null, measured: false },
    ms: 0, touched: [] };
  let forced: () => void = () => undefined;
  const ended = new Promise<"forced">((resolve) => { forced = () => resolve("forced"); });
  const cancels: (() => void)[] = [];
  let idle: () => void = () => undefined;
  const arm = () => {
    idle();
    idle = deps.clock.timer(limits.idleMs, () => {
      sent.timedOut = true;
      controller.abort();
      cancels.push(deps.clock.timer(CONFIRM_MS, () => { void agent.close(); forced(); }, "timeout"));
    }, "timeout");
  };
  arm();
  const it = agent.turn(request, controller.signal)[Symbol.asyncIterator]();
  await io.record([event(spec, "turn.sent", { key: spec.meta.key, native_session: null, native_turn: null })]);
  deps.hooks.crash(`2: sent, before any reply (${label(spec, request.meta.attempt ?? 1)})`);
  try {
    for (;;) {
      const next = await Promise.race([it.next(), ended]);
      if (next === "forced" || next.done) break;
      const e = next.value;
      if (!sent.timedOut) arm();
      if (e.kind === "permission") e.decide(io.decide?.(e.request, Boolean(request.repair)) ??
        (request.repair ? "deny" : "allow"));
      else if (e.kind === "usage") sent.usage = { input: e.input, output: e.output, cost: e.cost ?? null,
        measured: e.measured };
      if (e.kind === "tool") sent.touched.push(`${e.run.tool} ${e.run.command ?? ""}`);
      if (e.kind === "tool") await io.record([event(spec, "turn.tool", { key: spec.meta.key, run: null,
        tool: e.run.tool, command: e.run.command, outcome: e.run.outcome, exit_code: e.run.exitCode,
        duration_ms: e.run.durationMs, output_digest: null, harmless: harmless(e.run) })]);
      else if (e.kind === "activity") await io.record([event(spec, "turn.activity", { key: spec.meta.key,
        kind: e.compaction ? "compaction" : "text", text: e.text.slice(0, 10_000) })]);
      await io.onEvent?.(e, spec.meta.key);
      if (["reply", "error", "exit", "cancelled", "idle-timeout"].includes(e.kind)) { sent.terminal = e; break; }
    }
  } finally {
    idle();
    for (const cancel of cancels) cancel();
  }
  if (sent.timedOut) {
    const confirmed = sent.terminal?.kind === "cancelled" && sent.terminal.confirmed;
    await io.record([event(spec, "turn.cancelled", { key: spec.meta.key, cause: "timeout", confirmed })]);
    sent.terminal = { kind: "idle-timeout" };
  }
  sent.ms = deps.clock.now().getTime() - started;
  deps.hooks.crash(`3: reply arrived, before it's recorded (${label(spec, request.meta.attempt ?? 1)})`);
  return sent;
}

interface Judged {
  category: Category;
  errors: string[];
  value?: unknown;
  text: string;
  format?: { error: string; atByte: number | null; recovered: unknown };
}

async function judge(spec: TurnSpec, io: TurnIO, terminal: AgentEvent | null): Promise<Judged> {
  if (!terminal || terminal.kind !== "reply") {
    const message = terminal && "message" in terminal ? String(terminal.message) : terminal?.kind ?? "no reply";
    return { category: classify(terminal), errors: [message], text: "" };
  }
  if ((terminal.finals ?? 1) > 1) return { category: "content", errors: ["the turn sent two final replies"],
    text: terminal.text };
  const read = readReply(terminal.text, terminal.structured);
  if (read.kind === "format") return { category: "format", errors: [read.error], text: terminal.text, format: read };
  if (read.kind === "content") return { category: "content", errors: [read.error], text: terminal.text };
  const checked = checkReply(spec.reply, read.value);
  const errors = checked.ok ? ((await io.validate?.(read.value)) ?? []) : checked.errors;
  return errors.length ? { category: "content", errors, text: terminal.text, value: read.value }
    : { category: "ok", errors: [], text: terminal.text, value: read.value };
}

function retryNote(category: Category, attempt: number, retries: number, errors: readonly string[]): string {
  const of = `Retry ${attempt} of ${retries}`;
  if (category === "timeout") {
    return `${of}: the earlier attempt timed out and may have left changes in the working tree; check git status ` +
      "first.";
  }
  if (category === "content" || category === "format") {
    // The errors quote the reply's own text and commands (ARCH 1.2): only as quoted data.
    return `${of}: your last reply wasn't accepted, for the reasons quoted below. Send a corrected reply in the same ` +
      `format.\n${quoted(escapeControl(errors.join("\n")))}`;
  }
  return `${of} after a provider error.`;
}

export async function runTurn(deps: Deps, first: Agent, spec: TurnSpec, io: TurnIO,
  limits: TurnLimits): Promise<TurnOutcome> {
  let agent = first;
  let note: string | null = null;
  let instructions = spec.session === "new";
  let quotaWaited = false;
  const tries: { signature: string | null; touched: string[]; format: boolean }[] = [];
  for (let attempt = 1; ; attempt += 1) {
    const request: TurnRequest = { meta: { ...spec.meta, attempt: (spec.meta.attempt ?? 1) + attempt - 1 },
      ...(instructions && spec.instructions ? { instructions: spec.instructions } : {}),
      message: note ? `${note}\n\n${spec.message}` : spec.message, schema: spec.schema, grants: spec.grants,
      tools: spec.tools };
    await io.record([intent(spec, request, attempt)]);
    deps.hooks.crash(`1: intent, before sending (${label(spec, attempt)})`);
    instructions = false;
    const sent = await consume(deps, agent, request, spec, io, limits);
    let judged = await judge(spec, io, sent.terminal);
    await io.record([await replyEvent(spec, io, judged, sent)]);
    const format = judged.category === "format";
    if (judged.category === "format" && judged.format) judged = await repair(deps, agent, spec, io, limits, judged);
    if (judged.category === "ok") return { ok: true, value: judged.value, attempts: attempt };
    const reason = judged.errors[0] ?? judged.category;
    tries.push({ signature: replySignature(judged.category, judged.errors), touched: sent.touched, format });
    if (limits.circlingRepeats && turnCircling(tries, limits.circlingRepeats)) {
      const what = tries.every((t) => t.format) ? "malformed reply" : "invalid reply";
      return { ok: false, category: judged.category, attempts: attempt, circling: true,
        reason: `${what} ${attempt} times (the same change repeated): ${reason}` };
    }
    if (judged.category === "cancelled" || judged.category === "environment") {
      return { ok: false, category: judged.category, reason, attempts: attempt };
    }
    if (judged.category === "quota" || judged.category === "auth") {
      const resetAt = sent.terminal?.kind === "error" ? sent.terminal.resetAt : undefined;
      const wait = resetAt ? Date.parse(resetAt) - deps.clock.now().getTime() : NaN;
      if (judged.category === "quota" && !quotaWaited && wait > 0 && wait <= limits.quotaWaitHours * 3_600_000) {
        quotaWaited = true;
        await io.record([event(spec, "turn.retry", { key: spec.meta.key, category: "quota", attempt,
          delay_ms: wait, reason })]);
        await deps.clock.sleep(wait, "backoff");
        attempt -= 1;
        continue;
      }
      const answer = await io.ask?.(judged.category, reason) ?? "cancel";
      if (answer === "retry") { attempt -= 1; continue; }
      return { ok: false, category: answer === "switch" ? "switch" : judged.category, reason, attempts: attempt };
    }
    if (attempt > limits.retries) return { ok: false, category: judged.category, reason, attempts: attempt };
    const delay = judged.category === "provider" || judged.category === "timeout"
      ? backoffMs(attempt, deps.random.jitter()) : 0;
    await io.record([event(spec, "turn.retry", { key: spec.meta.key, category: judged.category, attempt,
      delay_ms: delay, reason })]);
    if (delay) await deps.clock.sleep(delay, "backoff");
    note = retryNote(judged.category, attempt, limits.retries, judged.errors);
    if (judged.category === "provider" && sent.terminal?.kind !== "error" && io.fresh) {
      agent = await io.fresh();
      instructions = true;
    }
  }
}

function intent(spec: TurnSpec, request: TurnRequest, attempt: number): NewEvent {
  const text = request.instructions ?? "";
  return event(spec, "turn.intent", { key: spec.meta.key, role: spec.meta.role, runtime: spec.runtime,
    model: spec.model, effort: spec.effort, fast: spec.fast, session: attempt === 1 ? spec.session : "reused",
    schema: spec.schema.name, instruction_chars: text.length,
    instruction_digest: `sha256:${createHash("sha256").update(text).digest("hex")}`, tools: [...spec.tools],
    grants: [...spec.grants], redo: spec.redo });
}

async function replyEvent(spec: TurnSpec, io: TurnIO, judged: Judged, sent: Sent): Promise<NewEvent> {
  const raw = judged.category === "ok" || !judged.text ? null : await io.blob(judged.text);
  return event(spec, "turn.reply", { key: spec.meta.key, outcome: judged.category === "environment" ? "provider"
    : judged.category, errors: judged.errors, raw, usage: sent.usage,
  timing: { first_output_ms: null, agent_ms: sent.ms, tools_ms: 0, rafi_ms: 0 } });
}

/** The one repair try, in the same session, tools refused (5.3). A rejected resend becomes a content error. */
async function repair(deps: Deps, agent: Agent, spec: TurnSpec, io: TurnIO, limits: TurnLimits,
  judged: Judged): Promise<Judged> {
  const format = judged.format!;
  const request: TurnRequest = { meta: spec.meta, message: repairMessage(format.error, format.atByte),
    schema: spec.schema, grants: spec.grants, tools: spec.tools, repair: true };
  const sent = await consume(deps, agent, request, spec, io, limits);
  const resend = await judge(spec, io, sent.terminal);
  const kept = resend.category === "ok" ? acceptRepair(format.recovered, resend.value)
    : { accepted: false, why: `the resend wasn't valid: ${resend.errors.join("; ")}` };
  await io.record([event(spec, "turn.repair", { key: spec.meta.key, error: format.error, at_byte: format.atByte,
    accepted: kept.accepted, why: kept.why })]);
  if (kept.accepted) return { ...resend, category: "ok" };
  if (resend.text) await io.blob(resend.text);
  return { category: "content", errors: [`${format.error}; the repair was rejected: ${kept.why}`], text: judged.text };
}
