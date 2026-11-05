// What every step of one build shares (ARCH 4.8 "every step has the same shape"): the build's context, its
// settings and tickets, its check environment and run records. The agent turn itself is turns/agent.ts.
import type { DeliveryUnit, Settings, TicketV1 } from "rafi-spec/v1";
import type { Engine } from "../api/engine.js";
import type { SandboxTool } from "../ask/grants.js";
import type { Deps, Grants } from "../deps/types.js";
import { runsOf, type RunRecord } from "../facts/runs.js";
import type { NewEvent } from "../log/types.js";
import type { UiAnswer, UiQuestion } from "../ask/blocked.js";
import type { AgentEvent } from "../agents/types.js";
import type { Session } from "../agents/session.js";
import type { CheckRules } from "../tools/session.js";
import type { Digests } from "../tickets/load.js";
import { ownedTicket, type Owned } from "../tickets/owned.js";
import type { CheckEnv } from "./checks.js";
import type { StopControl } from "./stop.js";

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
  /** A question in the terminal (C100): null when there's no terminal, the input ended, or `signal` closed it
   * because the question was answered elsewhere (C146) or the build is stopping. */
  question?(q: UiQuestion, signal?: AbortSignal): Promise<UiAnswer>;
  /** Ctrl+C in the build's terminal (C137); the CLI wires it to deps.terminal. */
  onInterrupt?(fn: () => void): () => void;
  /** SIGHUP (the terminal closed) or SIGTERM to rafi (C183); the CLI wires it to deps.terminal too. */
  onHangup?(fn: () => void): () => void;
}

export interface BuildContext {
  readonly engine: Engine;
  readonly deps: Deps;
  readonly project: string;
  readonly run: string;
  readonly tickets: readonly TicketV1[];
  readonly units: readonly DeliveryUnit[];
  /** P41: the digests of the files `tickets` and `units` were read from (the safe point compares them, C211). */
  readonly digests?: Digests;
  /** A unit's delivery in progress: its first git.intent compared delivery.yaml (C238, C283). */
  readonly delivering?: { checked: boolean };
  readonly settings: Settings;
  /** Per role; a runtime switch (C46) changes it for this build only. */
  readonly agents: Record<"builder" | "qa", RoleAgent>;
  readonly sandbox: SandboxTool | null;
  readonly grants: Grants;
  readonly runner: readonly string[] | null;
  readonly testScripts: readonly string[];
  readonly ui: BuildUI;
  readonly sessions: Map<string, Session>;
  /** C137: stop now (cancel the turn and test runs) and kill (a second Ctrl+C). */
  readonly control?: StopControl;
  /** M4 (speed): HEAD commit → tree, so a snapshot asks git for HEAD's tree once per commit. */
  readonly heads?: Map<string, string>;
  /** Rafi-owned tickets with their run details and unit (tickets/owned.ts, M5 C272), loaded by the loop. */
  readonly owned?: Map<string, Owned>;
}

export const setting = <T>(ctx: BuildContext, key: string): T => ctx.settings[key]?.value as T;

export function ticketOf(ctx: BuildContext, id: string): TicketV1 {
  const ticket = ctx.tickets.find((t) => t.id === id) ?? ctx.owned?.get(id)?.ticket ??
    ownedTicket(ctx.engine.fold().tickets[id]);
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
    checksEnv: setting<string[]>(ctx, "checks.env") ?? [], control: ctx.control };
}

export function rulesFor(ctx: BuildContext, requirementChecks: readonly string[], root = ctx.project): CheckRules {
  return { root, runner: ctx.runner, requirementChecks, setupScript: "scripts/rafi-setup.sh",
    testScripts: ctx.testScripts };
}

export function append(ctx: BuildContext, ticket: string | null, ...events: { type: string; data: unknown }[]) {
  return ctx.engine.append(events.map((e): NewEvent => ({ ...e, run_id: ctx.run, ticket_id: ticket,
    actor: "engine" })));
}
