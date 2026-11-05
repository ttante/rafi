// A read-only agent turn outside a build (C231, C260): today only the Ticket Maker's risk-note repair. Its agent is
// the role's (`agent_defaults.roles.ticket-maker`, the `-a/-m/--effort/--fast` flags), opened read-only with the
// read-only role's environment and no rafi tools; the turn runs through the same runner (intent, validation, the
// one repair, retries), and its events carry no run (`run_id` null). One fresh session per turn.
import type { ReplyName, Settings } from "rafi-spec/v1";
import type { Engine } from "../api/engine.js";
import { agentEnv } from "../agents/env.js";
import { findOnPath } from "../agents/readiness.js";
import { openSession } from "../agents/session.js";
import { optionalBlob } from "../log/blobs.js";
import { runTurn, type TurnOutcome } from "./runner.js";

export interface OneOff {
  readonly role: "ticket-maker";
  readonly ticket: string;
  readonly step: string;
  readonly reply: ReplyName;
  readonly instructions: string;
  readonly message: string;
}

const value = <T>(settings: Settings, key: string): T | undefined => settings[key]?.value as T | undefined;

/** The role's agent: a flag, else the role's project settings, else the single target, else Claude (4.8). */
async function agentFor(engine: Engine, settings: Settings, role: string) {
  const own = (value<Record<string, Record<string, unknown>>>(settings, "agent_defaults.roles") ?? {})[role] ?? {};
  const pick = <T>(key: string, flag: string): T | null =>
    (value<T>(settings, flag) ?? value<T>(settings, `agent_defaults.roles.${role}.${key}`) ?? own[key] ?? null) as
      T | null;
  const targets = value<string[]>(settings, "harness.targets") ?? [];
  const runtime = (value<string>(settings, "agent.runtime") ?? own.make ??
    (targets.length === 1 ? targets[0] : "claude")) as "codex" | "claude";
  const executable = (await findOnPath(engine.deps.fs, engine.deps.env, runtime)) ?? runtime;
  return { runtime, model: pick<string>("model", "agent.model"), effort: pick<string>("reasoning", "agent.effort"),
    fast: pick<boolean>("fast", "agent.fast") ?? false, executable };
}

export async function oneOffTurn(engine: Engine, settings: Settings, t: OneOff): Promise<TurnOutcome> {
  const a = await agentFor(engine, settings, t.role);
  const { deps } = engine;
  const env = agentEnv(deps.env, a.runtime, value<string[]>(settings, "agents.env") ?? [], deps.machine.platform,
    "qa");
  const session = await openSession(deps, { ...a, role: "qa", reply: t.reply, project: engine.projectDir,
    structured: true, tools: { call: async () => ({ text: "This session has no rafi tools.", isError: true }) },
    env }, (token) => engine.secret(token));
  const key = `${t.ticket}:${t.step}:1`;
  try {
    return await runTurn(deps, session.agent, { run: null, ticket: t.ticket, meta: { key, role: t.role,
      ticket: t.ticket, step: t.step, attempt: 1 }, instructions: t.instructions, message: t.message,
    schema: session.schema, reply: t.reply, grants: [], runtime: a.runtime, model: a.model, effort: a.effort,
    fast: a.fast, session: "new", tools: [], redo: false }, {
      record: async (events) => { await engine.append(events); },
      blob: (text) => optionalBlob(engine, text, { what: "the reply's raw text", run: null, ticket: t.ticket, key }),
      decide: () => "deny",
    }, { retries: value<number>(settings, "retries.turn") ?? 3,
      idleMs: (value<number>(settings, "timeouts.idle_minutes") ?? 30) * 60_000,
      quotaWaitHours: value<number>(settings, "retries.quota_wait_hours") ?? 0 });
  } finally {
    await session.close();
  }
}
