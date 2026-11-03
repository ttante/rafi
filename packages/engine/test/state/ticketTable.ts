// ARCH 4.2's ticket table as test data. Each row: where it applies, the event variant, and the result.
// "same" = no change; "invalid" = the pair is refused. Unlisted pairs: done/dropped "same", else "invalid".
import type { TicketState } from "../../src/state/types.js";

export interface Variant {
  readonly name: string;
  readonly type: string;
  data(t: TicketState): unknown;
}

const git = { sha: null, branch: null, url: null, unit: null };
const delivered = { unit: null, validation: { result: "passed", runs: [], unverified: [] } };
const verdict = (rejected: boolean, circling = false, tool: string | null = null) => () => ({
  attempt: 1, results: [{ req: 1, status: rejected ? "not-satisfied" : "satisfied", runs: [], needs: null, note: null }],
  rejected, unverified: tool ? [{ req: 2, tool }] : [], signature: "s", circling,
});

export const variants: readonly Variant[] = [
  { name: "status planned", type: "ticket.status_set", data: () => status("planned") },
  { name: "status blocked", type: "ticket.status_set", data: () => status("blocked") },
  { name: "status done", type: "ticket.status_set", data: () => status("done") },
  { name: "status canceled", type: "ticket.status_set", data: () => status("canceled") },
  { name: "tags", type: "ticket.tags_added", data: () => ({ tags: [{ tag: "ui", reason: "you" }] }) },
  { name: "risk waiver", type: "ticket.risk_waiver_recorded", data: () => ({ note: "n", by: "user" }) },
  { name: "started", type: "ticket.started", data: () => ({ resume_step: null }) },
  { name: "started resume fix", type: "ticket.started", data: () => ({ resume_step: "fix" }) },
  { name: "step matching", type: "step.started", data: (t) => ({ step: stepOf(t), attempt: 1 }) },
  { name: "step other", type: "step.started", data: () => ({ step: "nonsense", attempt: 1 }) },
  { name: "step failed", type: "step.failed", data: () => ({ category: "content", reason: "r", circling: false }) },
  { name: "step failed circling", type: "step.failed", data: () => ({ category: "c", reason: "r", circling: true }) },
  { name: "turn retry", type: "turn.retry",
    data: () => ({ key: "k", category: "provider", attempt: 1, delay_ms: 10, reason: "r" }) },
  { name: "requirements", type: "requirements.written",
    data: () => ({ path: "p", fp: "f", depth: "standard", depth_raised_from: null, count: 1, person_only: [] }) },
  { name: "builder done", type: "builder.reported", data: () => builder("done") },
  { name: "builder blocked", type: "builder.reported", data: () => builder("blocked") },
  { name: "builder needs-input", type: "builder.reported", data: () => builder("needs-input") },
  { name: "check run", type: "check.run", data: () => checkRun() },
  { name: "checks passed", type: "checks.passed", data: () => ({ runs: [1], reused: [] }) },
  { name: "checks failed", type: "checks.failed", data: () => ({ failing: [{ req: 1, run: 1 }], signature: "s",
    circling: false }) },
  { name: "checks failed circling", type: "checks.failed", data: () => ({ failing: [], signature: "s",
    circling: true }) },
  { name: "attempt summary", type: "attempt.summary", data: () => ({ attempt: 1, tree: "t", files_read: [], runs: [] }) },
  { name: "snapshot", type: "facts.snapshot", data: () => ({ key: "k", tree: "t", base: "b", files: [] }) },
  { name: "verdict pass", type: "verdict.recorded", data: verdict(false) },
  { name: "verdict rejected", type: "verdict.recorded", data: verdict(true) },
  { name: "verdict rejected circling", type: "verdict.recorded", data: verdict(true, true) },
  { name: "verdict unverified tool", type: "verdict.recorded", data: verdict(false, false, "playwright") },
  { name: "fix granted", type: "fix.granted", data: () => ({ by: "user", reason: "r" }) },
  { name: "waiver", type: "waiver.recorded", data: () => ({ kind: "waive-qa", note: "n", findings: [], fp: "f" }) },
  { name: "recheck requested", type: "recheck.requested", data: () => ({ ticket: "T1", revision: 2 }) },
  { name: "recheck recorded", type: "recheck.recorded", data: () => ({ passed: true, fix_ticket: null }) },
  { name: "blocked held", type: "ticket.blocked", data: () => blocked("held") },
  { name: "blocked build-wide", type: "ticket.blocked", data: () => blocked("build-wide") },
  { name: "blocked limit", type: "ticket.blocked", data: () => blocked("limit") },
  { name: "unblocked", type: "ticket.unblocked", data: () => ({ resume_step: null, by: "user" }) },
  { name: "unblocked resume fix", type: "ticket.unblocked", data: () => ({ resume_step: "fix", by: "user" }) },
  { name: "dropped", type: "ticket.dropped", data: () => ({ why: "wont-do" }) },
  { name: "reopened", type: "ticket.reopened", data: () => ({ why: "stale waiver" }) },
  { name: "git committed", type: "git.committed", data: () => git },
  { name: "git branch", type: "git.branch_created", data: () => git },
  { name: "delivery done", type: "delivery.done", data: () => delivered },
  { name: "scan gap", type: "scan.gap", data: () => ({ question: "q", kind: "permission" }) },
  { name: "recording saved", type: "recording.saved",
    data: () => ({ ticket: "T1", req: null, kind: "screenshot", path: "p", bytes: 1 }) },
  { name: "recording removed", type: "recording.removed", data: () => ({ path: "p", why: "retention" }) },
  { name: "changed material", type: "tickets.changed",
    data: () => ({ by: "user", items: [{ ticket: "T1", field: "acceptance" }], material: true }) },
  { name: "changed other", type: "tickets.changed",
    data: () => ({ by: "user", items: [{ ticket: "T1", field: "title" }], material: false }) },
  { name: "imported done", type: "progress.imported",
    data: () => ({ entry: { kind: "ticket", key: "T1", status: "done", at: "2026-11-01T14:00:00.000Z" },
      chose: "theirs" }) },
  { name: "added", type: "ticket.added", data: () => ({ ticket: "T1", source: "ci", requirements: [], hint: null }) },
];

function status(value: string) {
  return { status: value, summary: null, validation: null, evidence: value === "done" ? "e" : null, by: "user" };
}
function builder(kind: string) {
  return { kind, summary: kind === "done" ? "s" : null, runs: [],
    block: kind === "blocked" ? { type: "install", need: null, reason: "needs postgres" } : null,
    question: kind === "needs-input" ? { text: "Which?", choices: [] } : null };
}
function checkRun() {
  return { run: 1, ticket: "T1", command: "npm test", asked_by: "builder", tree: "t", exit_code: 0,
    outcome: "passed", tests: [], duration_ms: 1, output: null, changed_tracked: [], restored: [], refused: null,
    sandbox: "os" };
}
function blocked(kind: string) {
  return { kind, reason: "r", question: null, waits: [] };
}
const STEPS: Readonly<Record<string, string>> = Object.freeze({ "build-check": "check", "fix-check": "check" });
function stepOf(t: TicketState): string {
  return t.node ? (STEPS[t.node] ?? t.node) : "build";
}

/** [from patterns, variant, result]. Patterns: a state, "state·node", "building·*", "check", "active", "any". */
export const ticketRows: readonly (readonly [string[], string, string])[] = [
  [["any"], "status planned", "queued"],
  [["any"], "status blocked", "blocked(manual)"],
  [["any"], "status done", "done"],
  [["any"], "status canceled", "dropped"],
  [["any"], "imported done", "done"],
  [["any"], "added", "invalid"],
  ...["tags", "risk waiver", "turn retry", "check run", "attempt summary", "snapshot", "fix granted", "waiver",
    "scan gap", "recording saved", "recording removed", "git committed", "git branch"]
    .map((name) => [["any"], name, "same"] as [string[], string, string]),
  [["queued"], "started", "building·prepare"],
  [["queued"], "started resume fix", "fixing·fix"],
  [["queued"], "blocked held", "blocked(held)"],
  [["queued"], "blocked build-wide", "blocked(build-wide)"],
  [["queued", "blocked"], "dropped", "dropped"],
  [["queued", "blocked"], "changed material", "same"],
  [["queued", "blocked"], "changed other", "same"],
  [["blocked"], "unblocked", "queued"],
  [["blocked"], "unblocked resume fix", "queued"],
  [["blocked(confirm)"], "unblocked resume fix", "fixing·fix"],
  [["active"], "step matching", "same"],
  [["building·prepare"], "requirements", "building·build"],
  [["building·build"], "builder done", "building·build-check"],
  [["building·build"], "builder blocked", "blocked(install)->build"],
  [["building·build"], "builder needs-input", "blocked(decision)->build"],
  [["check"], "checks passed", "reviewing·review"],
  [["check"], "checks failed", "fixing·fix"],
  [["check"], "checks failed circling", "blocked(what-next)->fix"],
  [["check"], "blocked limit", "blocked(limit)->self"],
  [["building·*", "reviewing·review", "fixing·fix"], "step failed", "blocked(other)->self"],
  [["building·*", "reviewing·review"], "step failed circling", "blocked(other)->self"],
  [["fixing·fix"], "step failed circling", "blocked(what-next)->self"],
  [["building·*", "reviewing·review", "fixing·fix"], "changed material", "building·prepare"],
  [["active"], "changed other", "same"],
  [["reviewing·review"], "verdict pass", "building·deliver"],
  [["reviewing·review"], "verdict rejected", "fixing·fix"],
  [["reviewing·review"], "verdict rejected circling", "blocked(what-next)->fix"],
  [["reviewing·review"], "verdict unverified tool", "blocked(unverified)->review"],
  [["fixing·fix"], "builder done", "fixing·fix-check"],
  [["fixing·fix"], "builder blocked", "blocked(install)->fix"],
  [["fixing·fix"], "builder needs-input", "blocked(decision)->fix"],
  [["building·deliver"], "delivery done", "done"],
  [["done"], "reopened", "reviewing·review"],
];
