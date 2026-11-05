// One commit per ticket at its deliver step (C195, C196, C236; R11, R17). Looked for first by its trailers
// (`Rafi-Ticket`, `Rafi-Run`) on the branch. Staged with `git add -A` minus rafi's local files whatever `.gitignore`
// says, plus rafi's two views as the last safe point wrote them (Q3 a, C240); `write-tree`; that exact tree's changed
// blobs scanned for every declared value in each encoding; clean → `commit-tree` of that same tree on the tip the
// lookup saw, moved onto the branch only from that tip (`update-ref <ref> <new> <old>`). A refused update looks
// again: the same trailers → adopted; a foreign commit → merged on top of it and scanned again (at most 3 tries).
import path from "node:path";
import type { BuildContext } from "../build/context.js";
import { setting } from "../build/context.js";
import { declaredValues } from "../agents/env.js";
import { ignoredOnly } from "../facts/snapshot.js";
import { encodings } from "../log/redact.js";
import { conflictHit, mergeHead } from "./conflict.js";
import { effect, gitAt, logEvents, recordResult, recorded } from "./intent.js";
import { groupFor, type Group } from "./plan.js";
import { GitFailed, gitOut, gitTry, headFromFiles, revOf, type GitAt } from "./run.js";
import { DeliveryFailed, planOf } from "./worktree.js";
import { rafisView } from "../tickets/views.js";

/** Rafi's views, committed with every rafi commit on a branch it manages (ARCH 3.7, 3.8; C196, C240). */
export const VIEWS: readonly string[] = [".rafi/progress.yaml", "docs/ticket-progress.md"];
/** C196: never staged, whatever `.gitignore` says. */
const EXCLUDES: readonly string[] = [":(exclude).rafi", ":(exclude).foreman"];

export type Committed = { ok: true; sha: string } | { ok: false; held: string };

async function trailerCommit(at: GitAt, cwd: string, branch: string, ticket: string, run: string) {
  const r = await gitTry(at, cwd, ["log", "--format=%H", "--all-match", `--grep=^Rafi-Ticket: ${ticket}$`,
    `--grep=^Rafi-Run: ${run}$`, "-n", "1", `refs/heads/${branch}`, "--"]);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** The first declared value found in the tree's files changed since `parent`: "file contains the value of NAME". */
async function scan(ctx: BuildContext, at: GitAt, cwd: string, parent: string, tree: string): Promise<string | null> {
  const names = ["checks.env", "agents.env"].flatMap((k) => setting<string[] | undefined>(ctx, k) ?? []);
  const values = declaredValues(ctx.deps.env, names, ctx.deps.machine.platform);
  if (!values.length) return null;
  const changed = (await gitOut(at, cwd, ["diff-tree", "-r", "--name-only", "-z", "--no-renames", parent, tree]))
    .split("\0").filter(Boolean);
  if (!changed.length) return null;
  for (const [name, value] of values) {
    const forms = encodings(value).flatMap((f) => ["-e", f]);
    const r = await gitTry(at, cwd, ["grep", "-F", "-a", "-l", "-z", "--no-color", ...forms, tree, "--", ...changed]);
    const file = r.code === 0 ? r.stdout.split("\0").find(Boolean)?.replace(/^[^:]*:/, "") : undefined;
    if (file) return `${file} contains the value of ${name}; not committed`;
  }
  return null;
}

/** Copies the views the last safe point wrote into the worktree, then stages the ticket's work and them. */
async function stage(ctx: BuildContext, at: GitAt, cwd: string): Promise<string> {
  const main = ctx.engine.projectDir;
  const views: string[] = [];
  for (const rel of VIEWS) {
    const from = path.join(main, rel);
    if (!(await ctx.deps.fs.stat(from))) continue;
    // Part 6: a view outside `.rafi/` that isn't rafi's last write is your edit; rafi's commit doesn't carry it.
    if (!rel.startsWith(".rafi/") && !(await rafisView(ctx.deps.fs, main, from))) continue;
    if (cwd !== main) {
      await ctx.deps.fs.mkdir(path.dirname(path.join(cwd, rel)));
      await ctx.deps.fs.writeAtomic(path.join(cwd, rel), await ctx.deps.fs.readBytes(from));
    }
    views.push(rel);
  }
  const added = await gitTry(at, cwd, ["add", "-A", "--", ".", ...EXCLUDES]);
  if (added.code !== 0 && !ignoredOnly(added)) throw new GitFailed(["add"], added);
  if (views.length) await gitOut(at, cwd, ["add", "-f", "--", ...views]);
  return gitOut(at, cwd, ["write-tree"]);
}

function message(ctx: BuildContext, ticket: string, summary: string | null): string {
  const title = ctx.tickets.find((t) => t.id === ticket)?.title ?? ticket;
  return ctx.engine.redact([`${ticket}: ${title}`, ...(summary ? ["", summary] : []), "",
    `Rafi-Ticket: ${ticket}`, `Rafi-Run: ${ctx.run}`].join("\n"));
}

/** One try: commit `tree` on `parent` and move the branch from `parent`; null when the branch moved first. */
async function tryCommit(ctx: BuildContext, at: GitAt, g: Group, ticket: string, parent: string, tree: string,
  text: string): Promise<string | null> {
  // C237: a conflict fix ticket's commit is the merge rafi started (its second parent, MERGE_HEAD).
  const theirs = await mergeHead(at, g.worktree);
  const sha = await gitOut(at, g.worktree, ["commit-tree", tree, "-p", parent, ...(theirs ? ["-p", theirs] : []),
    "-m", text]);
  const ref = `refs/heads/${g.branch}`;
  const moved = await effect(ctx, { op: "commit", unit: g.unit, ticket, ref, old: parent, new: sha, tree },
    g.branch, () => gitTry(at, g.worktree, ["update-ref", "-m", `rafi: ${ticket}`, ref, sha, parent]));
  if (moved.code === 0 && theirs) await gitTry(at, g.worktree, ["merge", "--quit"]);
  return moved.code === 0 ? sha : null;
}

/**
 * The ticket's commit in its worktree, or null when git is left to you (current branch, completion none). Held: a
 * declared value is in a file to commit; nothing is committed and the line names the file and the variable.
 */
export async function commitTicket(ctx: BuildContext, ticket: string): Promise<Committed | null> {
  const plan = planOf(ctx);
  const hit = groupFor(plan, ticket) ?? await conflictHit(ctx, ticket);
  if (!hit || !hit.unit.managed || setting<string>(ctx, "git.managed_by") === "me") return null;
  const g = hit.group;
  const at = gitAt(ctx);
  const events = await logEvents(ctx);
  const done = recorded(events, "git.committed", (_d, e) => e.ticket_id === ticket && e.run_id === ctx.run);
  if (done) return { ok: true, sha: String(done.sha) };
  const adopt = async (sha: string) => {
    await recordResult(ctx, "git.committed", ticket, { sha, branch: g.branch, unit: g.unit });
    return { ok: true as const, sha };
  };
  // P51: a commit of this ticket in this run can exist only after its intent was recorded (a redo looks for it).
  const tried = recorded(events, "git.intent", (d, e) => d.op === "commit" && e.ticket_id === ticket &&
    e.run_id === ctx.run);
  const found = tried ? await trailerCommit(at, g.worktree, g.branch, ticket, ctx.run) : null;
  if (found) return adopt(found);
  const summary = events.filter((e) => e.type === "builder.reported" && e.ticket_id === ticket).at(-1)?.data as
    { summary?: string | null } | undefined;
  const text = message(ctx, ticket, summary?.summary ?? null);
  let tree = await stage(ctx, at, g.worktree);
  let parent = (await headFromFiles(ctx.deps.fs, g.worktree))?.sha ??
    await gitOut(at, g.worktree, ["rev-parse", "HEAD"]);
  for (let tries = 0; tries < 3; tries += 1) {
    const held = await scan(ctx, at, g.worktree, parent, tree);
    if (held) return { ok: false, held };
    const sha = await tryCommit(ctx, at, g, ticket, parent, tree, text);
    if (sha) return adopt(sha);
    const again = await trailerCommit(at, g.worktree, g.branch, ticket, ctx.run);
    if (again) return adopt(again);
    // R11 (b): a foreign commit landed on the branch; this ticket's work goes on top of it.
    const tip = await revOf(at, g.worktree, `refs/heads/${g.branch}`);
    if (!tip) throw new DeliveryFailed(g.unit, "rejected", `branch ${g.branch} was deleted while ${ticket} committed.`);
    const merged = await gitTry(at, g.worktree, ["merge-tree", "--write-tree", tip,
      await gitOut(at, g.worktree, ["commit-tree", tree, "-p", parent, "-m", text])]);
    if (merged.code === 1) throw new DeliveryFailed(g.unit, "conflict", `a commit on ${g.branch} conflicts with ` +
      `${ticket}'s work.`);
    if (merged.code !== 0) throw new GitFailed(["merge-tree"], merged);
    const next = merged.stdout.trim().split("\n")[0]!;
    await gitOut(at, g.worktree, ["read-tree", "-m", "-u", tree, next]);
    parent = tip;
    tree = next;
  }
  throw new DeliveryFailed(g.unit, "transient", `${g.branch} kept moving while ${ticket} committed.`);
}
