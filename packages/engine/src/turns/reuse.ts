// The reused-agent override (ARCH 10.1, 11.2; NEW-TAG-6, NEW-ADP-2, Q-ADP-2; M5 plan C223). With a role's
// `session_strategy: compact`, one session of that role serves the build, in this process. It gets the tags of every
// ticket in the build's scope, recorded on the session as `turn.activity {kind: "session-tags"}` (never as
// `ticket.tags_added`), re-checked before each new ticket, since the scope can change (a reorder, a skip): tags are
// only added, and the next ticket's first message carries only the packs, skills and tools that are new. At a
// ticket boundary rafi asks the provider to compact only when the latest usage sample is above the role's
// `auto_compact_threshold_percent` of the model's window; Codex's session total isn't occupancy (NEW-ADP-2).
import type { TicketV1 } from "rafi-spec/v1";
import type { Session } from "../agents/session.js";
import type { BuildContext } from "../build/context.js";
import { contextSections } from "../instructions/assemble.js";
import { ticketContext } from "../instructions/packs.js";
import { ticketTags } from "../instructions/tags.js";

/** A role's setting: a `--set` or policy key for it, else its entry under `agent_defaults.roles`. */
export function roleSetting(ctx: BuildContext, role: string, key: string): unknown {
  const exact = ctx.settings[`agent_defaults.roles.${role}.${key}`];
  if (exact) return exact.value;
  return ((ctx.settings["agent_defaults.roles"]?.value ?? {}) as Record<string, Record<string, unknown>>)[role]?.[key];
}

export const reuses = (ctx: BuildContext, role: string) => roleSetting(ctx, role, "session_strategy") === "compact";

/** A rafi-owned fix ticket isn't in tickets.yaml: only the tags recorded for it count. */
export const definition = (ctx: BuildContext, id: string): TicketV1 => ctx.tickets.find((t) => t.id === id) ??
  ctx.owned?.get(id)?.ticket ?? ({ id, tags: [] } as unknown as TicketV1);

const CLOSED: ReadonlySet<string> = new Set(["done", "dropped"]);

/** The tickets the build's scope holds now: its listed tickets, else the open queue; `--steps N` the next N open. */
export function scopeIds(ctx: BuildContext, current: string): string[] {
  const view = ctx.engine.fold(ctx.tickets.map((t) => ({ id: t.id, dependsOn: t.depends_on })));
  const build = view.builds[ctx.run];
  const skip = new Set(build?.scope?.skip ?? []);
  const open = view.queue.map((d) => d.id).filter((id) => !CLOSED.has(view.tickets[id]?.state ?? "queued") &&
    !skip.has(id));
  let ids = build?.tickets.length ? open.filter((id) => build.tickets.includes(id)) : open;
  if (build?.scope?.kind === "steps") {
    const done = (view.doneInRun[ctx.run] ?? []).filter((id) => !view.tickets[id]?.rafiOwned).length;
    ids = ids.slice(0, Math.max(0, Number(build.scope.value) - done));
  }
  return [...new Set([current, ...ids])];
}

/** The union of the scope's tickets' tags with what the session already has (only adds). */
export async function unionTags(ctx: BuildContext, current: string, had: readonly string[]): Promise<Set<string>> {
  const out = new Set(had);
  for (const id of scopeIds(ctx, current)) {
    for (const t of await ticketTags(ctx.engine, definition(ctx, id))) out.add(t);
  }
  return out;
}

/** Q-ADP-2 and NEW-ADP-2: compact only when the latest sample is above the threshold's share of the window. */
export function compactionDue(sample: Session["sample"], thresholdPercent: unknown): boolean {
  if (typeof thresholdPercent !== "number" || !sample?.window || sample.last === null) return false;
  return (sample.last / sample.window) * 100 > thresholdPercent;
}

function activity(ctx: BuildContext, ticket: string, kind: string, text: string) {
  return ctx.engine.append([{ type: "turn.activity", run_id: ctx.run, ticket_id: ticket, actor: "engine",
    data: { key: `${ticket}:session`, kind, text } }]);
}

const listed = (tags: Iterable<string>) => [...tags].sort().join(", ");

/** The session's first context, for a reused session: the scope's union, recorded on the session. */
export async function firstContext(ctx: BuildContext, ticket: string, role: "builder" | "qa") {
  const tags = await unionTags(ctx, ticket, []);
  await activity(ctx, ticket, "session-tags", listed(tags));
  return { tags, context: await ticketContext(ctx.deps.fs, tags, role, ctx.settings) };
}

/**
 * Before a reused session's first turn on a new ticket: re-check the union, record what it added, ask for a
 * compaction when it's due, and return what the message carries first (only the new packs, skills and tools).
 */
export async function recheck(ctx: BuildContext, sess: Session, ticket: string, role: "builder" | "qa"):
  Promise<string> {
  const standing = sess.standing!;
  const tags = await unionTags(ctx, ticket, standing.tags);
  const added = [...tags].filter((t) => !standing.tags.includes(t)).sort();
  if (compactionDue(sess.sample, roleSetting(ctx, role, "auto_compact_threshold_percent")) && sess.agent.compact) {
    await sess.agent.compact();
    await activity(ctx, ticket, "compaction", `rafi asked the provider to compact: the latest sample is ${
      sess.sample!.last} of a ${sess.sample!.window}-token window, above the threshold`);
  }
  if (!added.length) return "";
  await activity(ctx, ticket, "session-tags", `${listed(tags)} (added: ${added.join(", ")})`);
  const context = await ticketContext(ctx.deps.fs, tags, role, ctx.settings);
  const packs = context.packs.filter((_, i) => !standing.packs.includes(context.packNames[i]!));
  const skills = context.skills.filter((s) => !standing.lines.includes(`skill:${s.name}`));
  const tools = context.tools.filter((t) => !standing.lines.includes(`tool:${t}`));
  sess.standing = { ...standing, tags: [...tags], packs: [...new Set([...standing.packs, ...context.packNames])],
    lines: [...standing.lines, ...skills.map((s) => `skill:${s.name}`), ...tools.map((t) => `tool:${t}`)] };
  const sections = contextSections({ packs, skills, tools });
  return sections.length ? `This ticket adds tags ${added.join(", ")}; what they add for you:\n\n${
    sections.join("\n\n")}` : "";
}
