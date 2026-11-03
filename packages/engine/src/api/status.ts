// `rafi status` (ARCH 8.10, C48): a read-only view of the fold. The build and its progress, one plain line per
// blocked ticket, and the current turn's liveness: waiting on the provider (retry n of m, next try) from the last
// turn.retry, else working or quiet from the last activity. Never JSON; only 1.0 command names.
import type { Engine } from "./engine.js";
import { loadTickets } from "../tickets/load.js";

type Data = Record<string, unknown>;
const hhmmss = (ms: number) => new Date(ms).toISOString().slice(11, 19);

export async function statusLines(engine: Engine): Promise<string[]> {
  const all = [];
  for await (const e of engine.events()) all.push(e);
  const loaded = await loadTickets(engine.deps.fs, engine.projectDir);
  const defs = loaded.ok ? loaded.tickets.map((t) => ({ id: t.id, dependsOn: t.depends_on })) : [];
  const view = engine.fold(defs);
  if (!view.run) return ["No build has run here yet. Start one with `rafi start . --steps 1`."];
  const build = view.builds[view.run]!;
  const mine = all.filter((e) => e.run_id === view.run);
  const done = view.doneInRun[view.run] ?? [];
  const kind = build.scope?.kind;
  const scope = kind === "steps" ? `${String(build.scope!.value)} ticket(s)` : kind === "ticket"
    ? `ticket ${String(build.scope!.value)}` : "every ticket";
  const doneText = `${done.length} done (${done.join(", ") || "none"})`;
  const lines = [`Build ${view.run}: ${build.state}; scope: ${scope}; ${doneText}.`];
  for (const t of Object.values(view.tickets)) {
    if (["building", "reviewing", "fixing"].includes(t.state)) lines.push(`${t.id}: ${t.state} (${t.node})`);
    if (t.state === "blocked" && t.block) lines.push(`${t.id} is blocked: ${t.block.reason}`);
  }
  const lastTurn = mine.filter((e) => ["turn.retry", "turn.intent", "turn.reply"].includes(e.type)).at(-1);
  if (lastTurn?.type === "turn.retry") {
    const d = lastTurn.data as Data;
    const retries = Number((build.settings["retries.turn"]?.value as number | undefined) ?? 3);
    const next = Date.parse(lastTurn.at) + Number(d.delay_ms);
    lines.push(`Waiting on the provider: retry ${String(d.attempt)} of ${retries} (${String(d.category)}); next try ` +
      `at ${hhmmss(next)}.`);
  } else if (lastTurn?.type === "turn.intent" && ["running"].includes(build.state)) {
    const last = mine.filter((e) => e.type === "turn.activity" || e.type === "turn.intent").at(-1)!;
    const quiet = engine.deps.clock.now().getTime() - Date.parse(last.at);
    lines.push(quiet >= 120_000 ? `The agent is active but quiet (${Math.round(quiet / 60_000)} min).`
      : "The agent is working.");
  }
  if (build.state === "running" || build.state === "waiting") {
    lines.push("Follow it here, or stop it with `rafi stop`.");
  }
  else if (Object.values(view.tickets).some((t) => t.state === "blocked")) lines.push("Continue with `rafi resume`.");
  return lines;
}
