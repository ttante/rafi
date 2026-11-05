// Takeover and redo (ARCH 8.5, 4.5 rule 3): what `rafi resume` writes for a build, by its stored state and its
// owner's liveness. A live owner is attached to (C141); a dead or released one is taken over, with
// build.owner_lost when the old owner never released, then build.resumed (P32's ticket and overrides). A detached
// build's first owner writes neither (C152). The redo itself is the loop's rule 3; this names it (C135). The owner
// also removes temp files a torn atomic write left (C182).
import path from "node:path";
import type { Engine } from "../api/engine.js";
import { coveredFiles } from "../ask/blocked.js";
import { coveredDigest } from "../ask/keys.js";
import { openQuestions } from "../ask/questions.js";
import { snapshot } from "../facts/snapshot.js";
import { escapeControl } from "../log/redact.js";
import type { OwnerLiveness } from "../state/labels.js";
import type { BuildState, Folded } from "../state/types.js";
import { standard } from "../workflow/standard.js";
import { setting, type BuildContext } from "./context.js";

export type TakeoverPlan =
  | { kind: "attach" }
  | { kind: "takeover"; events: { type: string; data: unknown }[] }
  | { kind: "nothing"; why: string };

type Setting = { value: unknown; source: string };
export interface TakeoverOptions {
  readonly ticket: string | null;
  readonly settings: Readonly<Record<string, Setting>>;
  /** The old owner's last heartbeat (build.owner_lost's `last_heartbeat_at`). */
  readonly heartbeat: string;
}

const LIVE: ReadonlySet<string> = new Set(["running", "waiting", "paused", "stopping"]);

export function takeover(build: BuildState, owner: OwnerLiveness, o: TakeoverOptions): TakeoverPlan {
  if (build.state === "none") return { kind: "nothing", why: "Nothing to resume." };
  if (build.state === "stopped" && build.cause === "reset") return { kind: "nothing", why: "Nothing to resume." };
  if (build.state === "finished" && build.complete) return { kind: "nothing", why: "Nothing to resume." };
  if (owner === "alive" || owner === "not-responding") return { kind: "attach" };
  if (LIVE.has(build.state) && !build.everOwned) return { kind: "takeover", events: [] };
  const resumed = { type: "build.resumed", data: { from_state: build.state, ticket: o.ticket, settings: o.settings } };
  const lost = LIVE.has(build.state) && !(build.state === "waiting" && build.ownerReleased);
  return { kind: "takeover", events: lost ? [{ type: "build.owner_lost", data: { last_heartbeat_at: o.heartbeat } },
    resumed] : [resumed] };
}

const STEP_OF: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(standard.nodes
  .map((n) => [n.id, n.step])));

/** The step rule 3 redoes next: an active ticket whose step started and has no outcome (C135). */
export function interrupted(view: Folded, narrowed: string | null = null): { ticket: string; step: string } | null {
  const t = Object.values(view.tickets).find((x) => ["building", "reviewing", "fixing"].includes(x.state) && x.node &&
    (!narrowed || x.id === narrowed));
  return t ? { ticket: t.id, step: STEP_OF[t.node!] ?? t.node! } : null;
}

/** "Resuming r7: T2's build step was interrupted; redoing it (an earlier attempt may have left changes)." */
export function redoLine(view: Folded, run: string): string {
  const narrowed = view.builds[run]?.narrowed ?? null;
  const t = interrupted(view, narrowed);
  const only = narrowed ? ` Only ${narrowed} runs this time; the rest waits for a \`rafi resume\` without --ticket.`
    : "";
  if (!t) return `Resuming ${run}.${only}`;
  return `Resuming ${run}: ${t.ticket}'s ${t.step} step was interrupted; redoing it (an earlier attempt may have ` +
    `left changes).${only}`;
}

/**
 * C148 (NEW-QAM-3, S-QA-4 c): at takeover, an open "What next?" whose cited files changed since it was asked is out of
 * date: it's closed as stale and its ticket goes back to QA's review of the changed code. Returns the lines to show.
 */
export async function closeStale(engine: Engine, run: string): Promise<string[]> {
  const events = [];
  for await (const e of engine.events()) events.push(e);
  const said: string[] = [];
  for (const q of openQuestions(engine.fold()).filter((x) => x.kind === "what-next")) {
    const opened = events.find((e) => e.type === "question.opened" && (e.data as { id: string }).id === q.id);
    const key = (opened?.data as { key?: string | null } | undefined)?.key ?? "";
    const [, ticket, , fp] = key.split("|");
    if (!ticket || !fp) continue;
    const covered = coveredFiles(events, ticket);
    const now = await snapshot(engine.deps, engine.projectDir, `${ticket}-stale`, { files: false });
    if (!covered.tree || !now.ok) continue;
    if (await coveredDigest(engine.deps, engine.projectDir, now.tree, covered.files) === fp) continue;
    await engine.append([{ type: "question.closed", run_id: run, actor: "engine", data: { id: q.id, why: "stale" } },
      { type: "ticket.unblocked", run_id: run, ticket_id: ticket, actor: "engine",
        data: { resume_step: "review", by: "engine" } }]);
    said.push(`Question ${q.no} is out of date: ${ticket}'s files changed since it was asked ` +
      `(${covered.files.map((f) => escapeControl(f)).join(", ") || "its files"}); QA reviews the changed code.`);
  }
  return said;
}

/** writeAtomic's temp name (deps/real/fs.ts; pinned by engine/test/deps/fs.test.ts): `.<name>.<id>.tmp`. */
export const TORN_TEMP = /^\.(.+)\.[0-9A-Za-z-]+\.tmp$/;

/**
 * C182 (M4 follow-up 3): a crash between writeAtomic's temp write and its rename leaves the temp file. A build's owner
 * (one live build per checkout) removes rafi's own when its loop begins, so at every takeover and redo: writeAtomic's
 * names for the files rafi writes, in the folders it writes them in. `~/.rafi/` is every project's, so it stays.
 */
export async function removeTornTemps(ctx: BuildContext): Promise<void> {
  const own: readonly [string, RegExp][] = [[".rafi", /^(progress\.yaml|\.gitignore)$/],
    [path.join(".rafi", "cache"), /^(index-.+|run-.+\.json)$/],
    [path.join(setting<string>(ctx, "docs.root"), "requirements"), /\.md$/]];
  for (const [dir, names] of own) {
    const full = path.join(ctx.project, dir);
    if ((await ctx.deps.fs.stat(full))?.kind !== "dir") continue;
    for (const name of await ctx.deps.fs.list(full)) {
      const base = TORN_TEMP.exec(name)?.[1];
      if (base && names.test(base)) await ctx.deps.fs.remove(path.join(full, name));
    }
  }
}
