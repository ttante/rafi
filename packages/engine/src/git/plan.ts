// The delivery plan of one build (M5 slice 5, C193): which branch and worktree each ticket is built in, how each
// unit completes, and what the plan refuses before any turn. Pure: from the tickets, `delivery.yaml`'s units and the
// settings. Branch modes: a flag (`--branch-per-ticket`, `--no-branch-per-ticket`) wins for every unit; else the
// unit's `branch_mode`, else `tickets.build.branch_strategy`. `current` with a completion other than `none` builds
// per ticket, as today's `--create-pr` implied (C241). Automatic branches are `<prefix>/<id>-<title-slug>`; a
// unit's `branch` is exact. A stacked group is based on the branch it stacks on (a ticket it depends on in the same
// unit, or the last group of a unit it stacks on with `dependency_mode: stack`). The size policy (P42, C285): with
// `tickets.build.branch_policy.mode: size`, a per-ticket unit's independent tickets whose size `by_size` marks
// `shared` share one branch and one review (`<prefix>/<unit>-size-<ids>`); never a session, never a stack edge.
import path from "node:path";
import type { DeliveryUnit, Settings, TicketV1 } from "rafi-spec/v1";

export type Completion = "pr" | "pr-ready" | "auto-merge" | "direct-merge" | "none";
type Mode = "current" | "per-ticket" | "shared" | "batch";

export interface Group {
  readonly id: string;
  readonly unit: string;
  readonly tickets: readonly string[];
  readonly branch: string;
  /** The group whose branch this one is based on, or null for the build's base. */
  readonly stackOn: string | null;
  readonly worktree: string;
}

export interface UnitPlan {
  readonly id: string;
  readonly tickets: readonly string[];
  readonly completion: Completion;
  readonly provider: "auto" | "github" | "gitlab" | "local";
  readonly mergeMethod: "squash" | "merge" | "rebase";
  readonly cleanup: boolean;
  readonly dependsOn: readonly string[];
  readonly dependencyMode: "combine" | "wait" | "stack";
  /** False: current branch, completion none (git is left to you, C45). */
  readonly managed: boolean;
  readonly groups: readonly Group[];
}

export interface Plan {
  readonly units: readonly UnitPlan[];
  /** `--base`, else `tickets.build.base_branch`, else null (the main checkout's branch, or HEAD). */
  readonly base: string | null;
  readonly keepWorktrees: boolean;
  readonly autoMergeWait: boolean;
  readonly timeoutMinutes: number | null;
  /** Hostile or impossible settings, each one line naming the key; the build refuses them before any turn. */
  readonly problems: readonly string[];
}

export interface PlanInput {
  readonly tickets: readonly TicketV1[];
  readonly units: readonly DeliveryUnit[];
  readonly settings: Settings;
  readonly project: string;
  readonly run: string;
  /** The engine's redactor: a declared value in a title never reaches a branch name (P40; C361). */
  readonly redact?: (text: string) => string;
}

const value = <T>(s: Settings, key: string): T => s[key]?.value as T;

/** A branch name or prefix git and rafi both accept (today's `prefix.ts` rules, plus no leading `-` anywhere). */
export function badRef(name: string): boolean {
  if (!name || name === "@" || name.startsWith("-") || name.startsWith("/") || name.endsWith("/")) return true;
  if (name.includes("//") || name.includes("..") || name.includes("@{") || /[\x00-\x20\x7f~^:?*[\\]/.test(name)) {
    return true;
  }
  return name.split("/").some((s) => !s || s.startsWith(".") || s.startsWith("-") || s.endsWith(".") ||
    s.endsWith(".lock"));
}

export const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  .slice(0, 40).replace(/-+$/, "") || "ticket";

function modeOf(s: Settings, u: DeliveryUnit, completion: Completion): Mode {
  const strategy = s["tickets.build.branch_strategy"];
  const flag = strategy?.source === "flag" ? String(strategy.value) : null;
  const chosen: Mode = flag ? (flag === "branch-per-ticket" ? "per-ticket" : flag as Mode)
    : u.branch_mode ?? (String(strategy?.value ?? "current") === "branch-per-ticket" ? "per-ticket"
      : String(strategy?.value ?? "current") as Mode);
  const mode = chosen === "current" && completion !== "none" ? "per-ticket" : chosen;
  return u.branch && mode !== "current" ? "shared" : mode;
}

/** The units of the build: delivery.yaml's, plus one unit of its own for each ticket no unit lists. */
function unitsOf(i: PlanInput): DeliveryUnit[] {
  const listed = new Set(i.units.flatMap((u) => u.tickets));
  return [...i.units, ...i.tickets.filter((t) => !listed.has(t.id)).map((t) => ({ id: `U-${t.id}`, tickets: [t.id] }))];
}

type SizePolicy = { mode: string; by_size: Record<string, string> } | undefined;

/** P42: the unit's tickets that share one branch by size (at least two, none depending on a ticket here). */
function sharedBySize(s: Settings, tickets: readonly TicketV1[]): string[] {
  const policy = value<SizePolicy>(s, "tickets.build.branch_policy");
  if (policy?.mode !== "size") return [];
  const here = new Set(tickets.map((t) => t.id));
  const small = tickets.filter((t) => policy.by_size[t.size ?? ""] === "shared" &&
    !(t.depends_on ?? []).some((d) => here.has(d)) && !tickets.some((x) => (x.depends_on ?? []).includes(t.id)));
  return small.length >= 2 ? small.map((t) => t.id) : [];
}

function prefixOf(s: Settings, problems: string[]): string {
  const raw = String(value<string>(s, "tickets.build.branch_prefix") ?? "feature").trim().replace(/\/$/, "");
  if (badRef(raw)) { problems.push(`tickets.build.branch_prefix ${JSON.stringify(raw)} isn't a valid branch prefix.`); }
  return raw;
}

export function deliveryPlan(i: PlanInput): Plan {
  const s = i.settings;
  const problems: string[] = [];
  const prefix = prefixOf(s, problems);
  const base = (value<string | undefined>(s, "tickets.build.base_branch") ?? null) || null;
  if (base !== null && badRef(base)) problems.push(`tickets.build.base_branch ${JSON.stringify(base)} isn't a valid ` +
    "branch name.");
  const managedByMe = value<string>(s, "git.managed_by") === "me";
  const flagCompletion = s["tickets.build.completion"]?.source === "flag";
  const shown = i.redact ?? ((t: string) => t);
  const titles = new Map(i.tickets.map((t) => [t.id, { ...t, title: shown(t.title) }]));
  const used = new Set<string>();
  const unique = (name: string) => {
    let n = 1;
    let out = name;
    while (used.has(out)) out = `${name}-${++n}`;
    used.add(out);
    return out;
  };
  const worktree = (branch: string) => path.join(i.project, ".foreman", "worktrees", branch.replace(/\//g, "-"));
  const groupOf = new Map<string, string>();
  const lastGroup = new Map<string, string>();
  const plans: UnitPlan[] = [];
  let batch: Group | null = null;
  for (const u of unitsOf(i)) {
    const completion = (managedByMe ? "none" : flagCompletion ? value<Completion>(s, "tickets.build.completion")
      : u.completion ?? value<Completion>(s, "tickets.build.completion") ?? "none") as Completion;
    const mode: Mode = managedByMe ? "current" : modeOf(s, u, completion);
    if (u.branch && badRef(u.branch)) problems.push(`delivery.yaml: unit ${u.id}: branch ${JSON.stringify(u.branch)} ` +
      "isn't a valid branch name.");
    const dependencyMode = u.dependency_mode ?? "wait";
    const stackUnit = dependencyMode === "stack" ? (u.depends_on ?? []).at(-1) ?? null : null;
    const groups: Group[] = [];
    const add = (id: string, tickets: string[], branch: string, stackOn: string | null) => {
      const g = { id, unit: u.id, tickets, branch, stackOn, worktree: worktree(branch) };
      groups.push(g);
      for (const t of tickets) groupOf.set(t, id);
      return g;
    };
    if (mode === "per-ticket") {
      const small = sharedBySize(s, u.tickets.map((t) => titles.get(t)).filter((t) => t !== undefined));
      for (const t of u.tickets) {
        if (small.includes(t)) {
          if (t === small[0]) {
            add(`${u.id}/size`, small, unique(`${prefix}/${u.id}-size-${small.join("-").toLowerCase()}`),
              groups.length === 0 && stackUnit ? lastGroup.get(stackUnit) ?? null : null);
          }
          continue;
        }
        const dep = (titles.get(t)?.depends_on ?? []).map((d) => groupOf.get(d)).filter((g) => g &&
          groups.some((x) => x.id === g)).at(-1);
        const stackOn = dep ?? (groups.length === 0 && stackUnit ? lastGroup.get(stackUnit) ?? null : null);
        add(`${u.id}/${t}`, [t], unique(`${prefix}/${t}-${slug(titles.get(t)?.title ?? t)}`), stackOn);
      }
    } else if (mode === "shared") {
      const name = u.branch ?? unique(`${prefix}/${u.id}-${slug(titles.get(u.tickets[0]!)?.title ?? u.id)}`);
      add(u.id, [...u.tickets], name, stackUnit ? lastGroup.get(stackUnit) ?? null : null);
    } else if (mode === "batch") {
      batch ??= { id: "batch", unit: u.id, tickets: [], branch: unique(`${prefix}/batch-${i.run}`), stackOn: null,
        worktree: worktree(`${prefix}/batch-${i.run}`) };
      batch = { ...batch, tickets: [...batch.tickets, ...u.tickets] };
      for (const t of u.tickets) groupOf.set(t, "batch");
      groups.push(batch);
    }
    if (groups.length) lastGroup.set(u.id, groups.at(-1)!.id);
    plans.push({ id: u.id, tickets: [...u.tickets], completion,
      provider: u.provider ?? value(s, "tickets.build.provider") ?? "auto",
      mergeMethod: u.merge_method ?? value(s, "tickets.build.merge_method") ?? "merge",
      cleanup: u.cleanup ?? value(s, "tickets.build.cleanup") ?? true, dependsOn: u.depends_on ?? [],
      dependencyMode, managed: mode !== "current", groups });
  }
  const all = plans.flatMap((p) => p.groups);
  const depth = (g: Group): number => (g.stackOn ? 1 + depth(all.find((x) => x.id === g.stackOn)!) : 1);
  const max = value<number>(s, "tickets.build.max_branch_depth") ?? 5;
  const deep = all.find((g) => depth(g) > max);
  if (deep) problems.push(`${deep.branch} would be ${depth(deep)} branches deep; tickets.build.max_branch_depth is ` +
    `${max}.`);
  return { units: plans.map((p) => (p.groups.some((g) => g.id === "batch")
    ? { ...p, groups: p.groups.map((g) => (g.id === "batch" ? batch! : g)) } : p)), base,
  keepWorktrees: value<boolean>(s, "tickets.build.keep_worktrees") ?? false,
  autoMergeWait: value<boolean>(s, "tickets.build.auto_merge_wait") ?? true,
  timeoutMinutes: value<number | null>(s, "tickets.build.auto_merge_timeout_minutes") ?? 60, problems };
}

/** The group a ticket is built in (null: the main checkout, git left to you). */
export function groupFor(plan: Plan, ticket: string): { unit: UnitPlan; group: Group } | null {
  for (const unit of plan.units) {
    const group = unit.groups.find((g) => g.tickets.includes(ticket));
    if (group) return { unit, group };
  }
  return null;
}

export const unitOf = (plan: Plan, ticket: string) => plan.units.find((u) => u.tickets.includes(ticket)) ?? null;
