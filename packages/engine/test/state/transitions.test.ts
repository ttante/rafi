// Every (state·step, event variant) pair for the ticket, walked from standard's nodes and the registry's
// ticket events (ARCH 4.1, 4.8); every (state and flags, event) pair for the build and the project.
import { test } from "node:test";
import assert from "node:assert/strict";
import { eventRegistry } from "rafi-spec/v1";
import { initialTicket, nextTicket } from "../../src/state/ticket.js";
import { isTicketEvent } from "../../src/state/fold.js";
import { InvalidTransition, type TicketRules, type TicketState } from "../../src/state/types.js";
import { standard } from "../../src/workflow/standard.js";
import { checkEventData } from "rafi-spec/v1";
import { ticketRows, variants } from "./ticketTable.js";

const rules: TicketRules = { qa: true, fixes: 3, manualChecks: "wait", rafiOwned: false, workflow: standard };

function fromStates(): { name: string; ticket: TicketState }[] {
  const base = initialTicket("T1");
  const list = [{ name: "queued", ticket: base }];
  for (const node of standard.nodes) {
    list.push({ name: `${node.state}·${node.id}`, ticket: { ...base, state: node.state, node: node.id } });
  }
  const blocked = (kind: "install" | "confirm", resume: string) => ({ ...base, state: "blocked" as const,
    resumeNode: resume, block: { kind, reason: "r", question: null } });
  list.push({ name: "blocked(install)", ticket: blocked("install", "build") });
  list.push({ name: "blocked(confirm)", ticket: blocked("confirm", "deliver") });
  list.push({ name: "done", ticket: { ...base, state: "done" } });
  list.push({ name: "dropped", ticket: { ...base, state: "dropped", dropped: "wont-do" } });
  return list;
}

function matches(pattern: string, name: string, t: TicketState): boolean {
  if (pattern === "any") return true;
  if (pattern === "active") return ["building", "reviewing", "fixing"].includes(t.state);
  if (pattern === "check") return t.node === "build-check" || t.node === "fix-check";
  if (pattern === "building·*") return t.state === "building";
  if (pattern === "blocked") return t.state === "blocked";
  return pattern === name;
}

function expected(name: string, t: TicketState, variant: string): string {
  let result: string | undefined;
  for (const [patterns, v, to] of ticketRows) {
    if (v === variant && patterns.some((p) => matches(p, name, t))) result = to;
  }
  return result ?? (t.state === "done" || t.state === "dropped" ? "same" : "invalid");
}

function label(t: TicketState): string {
  if (t.state === "blocked") return `blocked(${t.block?.kind})->${t.resumeNode}`;
  return t.node ? `${t.state}·${t.node}` : t.state;
}

function satisfies(t: TicketState, before: TicketState, spec: string): boolean {
  if (spec === "same") {
    return t.state === before.state && t.node === before.node && t.resumeNode === before.resumeNode &&
      JSON.stringify(t.block) === JSON.stringify(before.block);
  }
  const blocked = /^blocked\(([a-z-]+)\)(?:->(.+))?$/.exec(spec);
  if (blocked) {
    const resume = blocked[2] === "self" ? before.node : blocked[2];
    return t.state === "blocked" && t.block?.kind === blocked[1] && (resume === undefined || t.resumeNode === resume);
  }
  const [state, node] = spec.split("·");
  return t.state === state && t.node === (node ?? null);
}

test("the variants cover every ticket event in the registry, and each variant's data validates", () => {
  const ticketTypes = [...eventRegistry.values()].filter((e) => e.class === "state" && isTicketEvent(e.type));
  const covered = new Set(variants.map((v) => v.type));
  assert.deepEqual(ticketTypes.map((e) => e.type).filter((t) => !covered.has(t)), []);
  assert.equal(isTicketEvent("ticket.done"), false, "delivery.done marks the end of delivery (review finding 3)");
  for (const v of variants) {
    const checked = checkEventData(v.type, eventRegistry.get(v.type)!.v, v.data(initialTicket("T1")));
    assert.ok(checked.ok, `${v.name}: ${checked.ok ? "" : checked.reason}`);
  }
});

test("every (state·step, event) pair of the ticket matches ARCH 4.2", () => {
  const failures: string[] = [];
  let pairs = 0;
  for (const { name, ticket } of fromStates()) {
    for (const variant of variants) {
      pairs += 1;
      const want = expected(name, ticket, variant.name);
      let ok: boolean;
      let got: string;
      try {
        const after = nextTicket(ticket, { type: variant.type, ticket_id: "T1", data: variant.data(ticket) }, rules);
        ok = want !== "invalid" && satisfies(after, ticket, want);
        got = label(after);
      } catch (error) {
        if (!(error instanceof InvalidTransition)) throw error;
        ok = want === "invalid";
        got = "invalid";
      }
      if (!ok) failures.push(`${name} + ${variant.name}: want ${want}, got ${got}`);
    }
  }
  assert.ok(pairs >= 500, `only ${pairs} pairs`);
  assert.deepEqual(failures, []);
});

function apply(t: TicketState, variant: string, r: TicketRules = rules): TicketState {
  const v = variants.find((x) => x.name === variant)!;
  return nextTicket(t, { type: v.type, ticket_id: "T1", data: v.data(t) }, r);
}

const at = (node: string, extra: Partial<TicketState> = {}): TicketState => {
  const n = standard.nodes.find((x) => x.id === node)!;
  return { ...initialTicket("T1"), state: n.state, node: n.id, ...extra };
};

test("context rows: fixes used up, rafi-owned, QA off, requirements current, person-only checks", () => {
  const spent = { fixesUsed: 3 };
  assert.equal(label(apply(at("build-check", spent), "checks failed")), "blocked(what-next)->fix");
  assert.equal(apply(at("review", spent), "verdict rejected").block?.kind, "what-next");
  assert.equal(apply(at("review", spent), "verdict rejected", { ...rules, rafiOwned: true }).block?.kind, "unfixed");
  assert.equal(apply(at("fix-check", { ...spent, rafiOwned: true }), "checks failed").block?.kind, "unfixed");
  const granted = apply(at("fix-check", spent), "fix granted");
  assert.equal(apply(granted, "checks failed").node, "fix");
  const qaOff = { ...rules, qa: false };
  assert.equal(apply(at("build-check"), "checks passed", qaOff).node, "deliver");
  assert.equal(apply(initialTicket("T1"), "started", qaOff).node, "build");
  assert.equal(apply({ ...initialTicket("T1"), requirementsCurrent: true }, "started").node, "build");
  const personOnly = at("review", { personOnly: 1 });
  assert.equal(apply(personOnly, "verdict pass").block?.kind, "confirm");
  assert.equal(apply(personOnly, "verdict pass").resumeNode, "deliver");
  assert.equal(apply(personOnly, "verdict pass", { ...rules, manualChecks: "track" }).node, "deliver");
  assert.equal(apply(personOnly, "verdict pass", { ...rules, manualChecks: "none" }).node, "deliver");
  const fixed = apply(at("build-check"), "checks failed");
  assert.equal(fixed.attempt, 2);
  assert.equal(fixed.fixesUsed, 1);
  const added = nextTicket(null, { type: "ticket.added", ticket_id: "T9", data: {} }, rules);
  assert.equal(added.state, "queued");
  assert.equal(added.rafiOwned, true);
  assert.equal(apply(at("review"), "changed material").requirementsCurrent, false);
});

test("C104: a retry from blocked(what-next) is the next attempt and uses the grant; exactly one fix, then ask", () => {
  const asked = apply(at("review", { attempt: 4, fixesUsed: 3 }), "verdict rejected");
  assert.equal(label(asked), "blocked(what-next)->fix");
  const granted = apply(asked, "fix granted");
  const retried = apply(granted, "unblocked resume fix");
  assert.equal(retried.state, "queued");
  assert.equal(retried.resumeNode, "fix");
  assert.equal(retried.attempt, 5, "the next attempt");
  assert.equal(retried.fixesUsed, 4, "the grant is used");
  const fixing = apply(retried, "started resume fix");
  assert.equal(label(fixing), "fixing·fix");
  assert.equal(apply(at("review", { ...fixing, node: "review", state: "reviewing" }), "verdict rejected").block?.kind,
    "what-next", "the next rejection asks again");
  const early = apply(at("review", { attempt: 3, fixesUsed: 2 }), "verdict rejected circling");
  const once = apply(apply(early, "fix granted"), "unblocked resume fix");
  assert.equal(once.fixesUsed, 4, "after an early circling question, the grant still allows exactly one fix");
  assert.equal(apply(at("review", { ...once, node: "review", state: "reviewing" }), "verdict rejected").block?.kind,
    "what-next");
});

test("C104: blocked(other) back into the fix step doesn't count as an attempt or a fix", () => {
  const failed = apply(at("fix", { attempt: 2, fixesUsed: 1 }), "step failed");
  assert.equal(failed.block?.kind, "other");
  const back = apply(failed, "unblocked resume fix");
  assert.deepEqual([back.attempt, back.fixesUsed], [2, 1]);
});
