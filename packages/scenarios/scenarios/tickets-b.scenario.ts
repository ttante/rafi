// S-CLI-4, the subcommands M5 part 4a-2 builds (plan 10.8): setup:init and setup:update with PRM-50–54 and the
// source fakes (P47: one request each), waive-risk-notes (PRM-56) and repair --risk-notes, groups list and repair
// (PRM-59), discover, accept-future-work, review, reset (scopes, groups, restore, PRM-57, PRM-58), archive, and show
// (OUT-4, OUT-30, --output), and repair --risk-notes --apply (C231: a read-only Ticket Maker turn per ticket, PRM-56).
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openEngine } from "@rafi-ai/engine";
import { parse, stringify } from "yaml";
import { registry } from "../checks/registry.js";
import { setTickets } from "../fixtures/common.js";
import { fakeTerminal } from "../fakes/terminal.js";
import { harnessDeps } from "../harness/deps.js";
import { scenario, type ScenarioContext } from "../harness/scenario.js";
import { exported } from "./m3-helpers.js";

const covers = (id: string) => registry.find((r) => r.id === id)!.covers;
const config = (project: string) => parse(readFileSync(path.join(project, "rafi-config.yaml"), "utf8"));
const order = (out: string, texts: readonly string[]) => texts.map((t) => out.indexOf(t));

async function seed(ctx: ScenarioContext, events: { type: string; data: unknown }[]): Promise<void> {
  const { deps } = harnessDeps(ctx.computer, fakeTerminal({ tty: false }), { cwd: ctx.project, instance: "seed" });
  const engine = await openEngine({ projectDir: ctx.project, deps });
  try { await engine.append(events.map((e) => ({ ...e, actor: "engine" }))); } finally { engine.close(); }
}

const PRM_50_54 = ["Initialize the ticket tracker now?", "Keep both default limits?",
  "Use the recommended population settings?", "How should saved sources be handled?",
  "Base branch:", "Branch prefix:", "Use one global branch strategy or choose by inferred ticket size?",
  "PR/MR title standard:", "Project-wide checks for QA to verify on every ticket", "Where do tickets come from?"];

async function setupSteps(ctx: ScenarioContext): Promise<void> {
  const { rafi, step, project, computer } = ctx;
  await step("setup:init in a terminal: PRM-50–54 in order; the answers saved under tickets.*", async () => {
    const r = await rafi("tickets setup:init --completion pr-ready", { tty: true, input: ["1", "1", "2", "1", "2",
      "1", "main", "work", "1", "3", "1", "lint passes, no console errors", "1", ".tickets"] });
    assert.equal(r.code, 0, r.output);
    const at = order(r.output, PRM_50_54);
    assert.ok(at.every((n) => n >= 0), JSON.stringify(at));
    assert.deepEqual([...at].sort((a, b) => a - b), at, "in order");
    const t = config(project).tickets;
    assert.deepEqual(t.sources, [{ type: "local", paths: [".tickets"] }]);
    assert.equal(t.populate.agent_preference, "claude");
    assert.deepEqual([t.build.completion, t.build.branch_prefix, t.build.branch_strategy, t.build.base_branch],
      ["pr-ready", "work", "branch-per-ticket", "main"]);
    assert.deepEqual(t.build.validation_checklist, ["lint passes", "no console errors"]);
    assert.ok(existsSync(path.join(project, ".tickets", "config.yaml")), "the tracker was initialized");
  });
  await step("setup:update -y --defaults with Linear, Jira and URL sources: no prompt, each fake gets one request, "
    + "the sources replace the saved ones, and no token value is saved", async () => {
    for (const url of ["https://api.linear.app/graphql", "https://acme.atlassian.net/rest/api/3/myself",
      "https://docs.example/spec"]) computer.http.routes.set(url, { status: 200, body: "{}" });
    const r = await rafi("tickets setup:update -y --defaults --linear --linear-team-key ENG --jira-site " +
      "https://acme.atlassian.net --jira-jql 'project = X' --url-source https://docs.example/spec --provider github",
    { tty: true, env: { LINEAR_API_KEY: "lin-secret-1", JIRA_EMAIL: "a@b.c", JIRA_API_TOKEN: "jira-secret-2" } });
    assert.equal(r.code, 0, r.output);
    assert.equal(order(r.output, PRM_50_54).filter((n) => n >= 0).length, 0, "no prompt");
    assert.deepEqual(computer.http.log.map((x) => new URL(x.url).host).sort(), ["acme.atlassian.net",
      "api.linear.app", "docs.example"]);
    const text = readFileSync(path.join(project, "rafi-config.yaml"), "utf8");
    assert.doesNotMatch(text, /lin-secret-1|jira-secret-2/);
    assert.deepEqual(config(project).tickets.sources.map((s: { type: string }) => s.type).sort(), ["jira", "linear",
      "url"]);
    assert.equal(config(project).tickets.build.provider, "github");
  });
  await step("with git.managed_by: me, setup skips PRM-52 and the delivery question, and refuses a completion",
    async () => {
      writeFileSync(path.join(project, "rafi-config.yaml"), stringify({ ...config(project),
        git: { managed_by: "me" } }));
      const r = await rafi("tickets setup:update --skip-access-check", { tty: true, input: ["1", ""] });
      assert.equal(r.code, 0, r.output);
      for (const q of ["Base branch:", "Branch prefix:", "How should finished work be delivered?"]) {
        assert.ok(!r.output.includes(q), q);
      }
      const no = await rafi("tickets setup:update -y --completion pr");
      assert.equal(no.code, 1, no.output);
      assert.match(no.output, /git\.managed_by is me/);
    });
}

async function trackerSteps(ctx: ScenarioContext): Promise<void> {
  const { rafi, step, project } = ctx;
  await step("waive-risk-notes: validate names a Medium ticket with no plan; PRM-56 asks for the reason; then clean",
    async () => {
      setTickets(project, { T3: { risk: "Medium" } });
      const bad = await rafi("tickets validate");
      assert.equal(bad.code, 1, bad.output);
      assert.match(bad.output, /T3 is Medium risk with no rollback plan or waiver/);
      const r = await rafi("tickets waive-risk-notes --tickets T3", { tty: true, input: ["rolled back by hand"] });
      assert.equal(r.code, 0, r.output);
      assert.match(r.output, /Reason for waiving rollback plans for T3:/);
      assert.equal((await exported(ctx)).events.filter((e) => e.type === "ticket.risk_waiver_recorded").length, 1);
      assert.equal((await rafi("tickets validate")).code, 0);
      setTickets(project, { T4: { risk: "High" } });
      const listed = await rafi("tickets repair --risk-notes");
      assert.match(listed.output, /T4 \(High\) has no rollback plan/);
      assert.doesNotMatch(listed.output, /T3 \(/, "waived");
    });
  await step("groups: repair asks PRM-59 and makes TG-1 for exactly the tickets outside a group; list --json",
    async () => {
      const help = await rafi("tickets groups repair --help");
      assert.doesNotMatch(help.output, /legacy migration/i);
      const r = await rafi("tickets groups repair", { tty: true, input: ["1"] });
      assert.equal(r.code, 0, r.output);
      assert.match(r.output, /Create one repair group for exactly 7 ticket\(s\)\?/);
      const list = JSON.parse((await rafi("tickets groups list --json")).out);
      assert.equal(list.version, 1);
      assert.deepEqual(list.groups.map((g: { id: string; tickets: string[] }) => [g.id, g.tickets.length]),
        [["TG-1", 7]]);
      assert.match((await rafi("tickets groups repair -y")).output, /already in a group/);
    });
  await step("discover needs --summary; then an inbox item; accept-future-work needs both flags, then a ticket "
    + "at that order", async () => {
    assert.equal((await rafi("tickets discover")).code, 1);
    const d = await rafi("tickets discover --summary 'Export to CSV' --source-ticket T2 --priority-guess P2");
    assert.equal(d.code, 0, d.output);
    assert.match(readFileSync(path.join(project, "docs", "ticket-progress.md"), "utf8"), /FW-1 \| Export to CSV/);
    assert.equal((await rafi("tickets accept-future-work FW-1 --order 2")).code, 1, "--ticket-id is required");
    assert.equal((await rafi("tickets accept-future-work FW-1 --ticket-id T8")).code, 1, "--order is required");
    const a = await rafi("tickets accept-future-work FW-1 --ticket-id T8 --order 2");
    assert.equal(a.code, 0, a.output);
    const tickets = parse(readFileSync(path.join(project, ".tickets", "tickets.yaml"), "utf8")).tickets as
      { id: string; order: number; title: string }[];
    assert.deepEqual([tickets.find((t) => t.id === "T8")?.order, tickets.find((t) => t.id === "T8")?.title],
      [2, "Export to CSV"]);
    assert.match((await rafi("tickets queue --limit 2")).out, /2\.\s+T8/);
    const groups = JSON.parse((await rafi("tickets groups list --json")).out).groups as
      { id: string; tickets: string[] }[];
    assert.deepEqual(groups.at(-1), { ...groups.at(-1), id: "TG-2", tickets: ["T8"] });
    assert.doesNotMatch(readFileSync(path.join(project, "docs", "ticket-progress.md"), "utf8"), /FW-1 \|/,
      "accepted: out of the inbox");
  });
}

async function reviewStep(ctx: ScenarioContext): Promise<void> {
  const { rafi, step, project } = ctx;
  await step("review: --accept, --dismiss and --defer act on one recommendation by --id; -all forms on every open "
    + "one", async () => {
    const rec = (id: string, title: string) => ({ type: "recommendation.recorded", data: { id, kind: "split",
      text: `Retitle T6 (${id})`, ticket: "T6", patch: { update: [{ id: "T6", set: { title } }] } } });
    await seed(ctx, [rec("REC-1", "Ticket six, retitled"), rec("REC-2", "x"), rec("REC-3", "y"), rec("REC-4", "z"),
      rec("REC-5", "w")]);
    assert.match((await rafi("tickets review")).out, /REC-1\s+split/);
    assert.equal((await rafi("tickets review --accept --id REC-1")).code, 0);
    const t6 = (parse(readFileSync(path.join(project, ".tickets", "tickets.yaml"), "utf8")).tickets as
      { id: string; title: string }[]).find((t) => t.id === "T6")!;
    assert.equal(t6.title, "Ticket six, retitled");
    assert.equal((await rafi("tickets review --dismiss --id REC-2")).code, 0);
    assert.equal((await rafi("tickets review --defer --id REC-3")).code, 0);
    assert.equal((await rafi("tickets review --dismiss-all")).code, 0);
    const resolved = (await exported(ctx)).events.filter((e) => e.type === "recommendation.resolved")
      .map((e) => [(e.data as { id: string }).id, (e.data as { resolution: string }).resolution]);
    assert.deepEqual(resolved, [["REC-1", "accepted"], ["REC-2", "dismissed"], ["REC-3", "deferred"],
      ["REC-4", "dismissed"], ["REC-5", "dismissed"]]);
    assert.match((await rafi("tickets review --accept-all")).output, /No open recommendations/);
  });
}

const statuses = async (ctx: ScenarioContext) => Object.fromEntries((JSON.parse((await ctx.rafi(
  "tickets show --json")).out).tickets as { id: string; status: string }[]).map((t) => [t.id, t.status]));
const resetOf = async (ctx: ScenarioContext) => (await exported(ctx)).events.filter((e) => e.type ===
  "ticket.status_set" && (e.data as { summary: string }).summary === "Reset with rafi tickets reset")
  .map((e) => e.ticket_id);

async function resetSteps(ctx: ScenarioContext): Promise<void> {
  const { rafi, step, project } = ctx;
  await step("reset: one ticket, each --scope, a group, and --deleted-tickets restore change only those tickets; "
    + "PRM-57 asks without --yes; history stays readable", async () => {
    assert.equal((await rafi("start . --steps 2 --no-qa")).code, 0);
    assert.equal((await rafi("tickets cancel T7 --summary 'not now'")).code, 0);
    const asked = await rafi("tickets reset T1", { tty: true, input: ["1"] });
    assert.match(asked.output, /Reset 1 ticket\(s\)\? Historical events and validation remain available\./);
    assert.deepEqual(await resetOf(ctx), ["T1"]);
    const s = await statuses(ctx);
    const unfinished = Object.keys(s).filter((id) => !["done", "canceled"].includes(s[id]!));
    let before = (await resetOf(ctx)).length;
    const scoped = async (scope: string) => {
      assert.equal((await rafi(`tickets reset --scope ${scope} --yes`)).code, 0);
      const now = await resetOf(ctx);
      const these = now.slice(before);
      before = now.length;
      return these;
    };
    assert.deepEqual((await scoped("unfinished")).sort(), unfinished.sort());
    assert.ok(!(await scoped("completed-and-unfinished")).includes("T7"), "canceled stays out");
    assert.ok((await scoped("all")).includes("T7"));
    assert.deepEqual(await (async () => {
      assert.equal((await rafi("tickets reset --group TG-2 --yes")).code, 0);
      return (await resetOf(ctx)).slice(before);
    })(), ["T8"]);
    before += 1;
    const file = path.join(project, ".tickets", "tickets.yaml");
    const doc = parse(readFileSync(file, "utf8")) as { tickets: { id: string }[] };
    writeFileSync(file, stringify({ ...doc, tickets: doc.tickets.filter((t) => t.id !== "T8") }));
    const r = await rafi("tickets reset --group TG-2 --deleted-tickets restore --yes");
    assert.equal(r.code, 0, r.output);
    assert.match(readFileSync(file, "utf8"), /id: T8/);
    const shown = JSON.parse((await rafi("tickets show T1 --json")).out).tickets[0];
    assert.ok(shown.validation && shown.events.some((e: { type: string }) => e.type === "delivery.done"));
  });
  await step("PRM-58: tickets of an interrupted build; the choice points to rafi reset and changes nothing",
    async () => {
      const crashed = await rafi("start . --steps 1 --no-qa", { crashAt: "2: sent, before any reply (" });
      assert.ok(crashed.crashed);
      const building = (JSON.parse((await rafi("tickets show --json")).out).tickets as { id: string; state: string }[])
        .find((t) => t.state === "building")!.id;
      const before = (await resetOf(ctx)).length;
      const r = await rafi(`tickets reset ${building}`, { tty: true, input: ["1"] });
      assert.equal(r.code, 0, r.output);
      assert.match(r.output, /These tickets belong to an interrupted build\. What should rafi do\?/);
      assert.match(r.output, /Run `rafi reset`/);
      assert.equal((await resetOf(ctx)).length, before, "nothing changed");
    });
}

async function viewSteps(ctx: ScenarioContext): Promise<void> {
  const { rafi, step, project, computer } = ctx;
  await step("archive --older-than-days 1 after two days moves the done rows to the archive doc", async () => {
    assert.equal((await rafi("tickets complete T5 --evidence 'by hand'")).code, 0);
    computer.clock.advance(2 * 86_400_000);
    const r = await rafi("tickets archive --older-than-days 1");
    assert.equal(r.code, 0, r.output);
    const archive = readFileSync(path.join(project, "docs", "ticket-archive.md"), "utf8");
    assert.match(archive, /\| T5 \| Ticket 5 \|/);
    assert.doesNotMatch(readFileSync(path.join(project, "docs", "ticket-progress.md"), "utf8"), /\| T5 \|/);
  });
  await step("show: the readable record, --json's versioned envelope with unknown fields, --output twice",
    async () => {
      setTickets(project, { T2: { documentation: "docs/t2.md", rollback: "revert", notes: "n",
        external_refs: [{ kind: "linear", id: "ENG-1" }], source_refs: ["src_1"], supersedes: ["T0"],
        x_custom: { a: 1 } } });
      const one = await rafi("tickets show T2");
      for (const label of ["State:", "Blockers:", "Acceptance:", "Validation:", "Delivery:", "Events ("]) {
        assert.ok(one.out.includes(label), label);
      }
      assert.match((await rafi("tickets show --all")).out, /T7: Ticket 7/);
      const json = JSON.parse((await rafi("tickets show T2 --json")).out);
      assert.equal(json.version, 1);
      assert.deepEqual(json.tickets[0].x_custom, { a: 1 });
      assert.equal(json.tickets[0].documentation, "docs/t2.md");
      for (let n = 0; n < 2; n += 1) assert.equal((await rafi("tickets show T2 --json --output out/a/b.json")).code, 0);
      const text = readFileSync(path.join(project, "out", "a", "b.json"), "utf8");
      assert.equal(text.match(/^\{$/gm)?.length, 2, "two pretty-printed blocks");
    });
}

/** C231: one read-only Ticket Maker turn per Medium or High ticket missing a rollback; PRM-56; only `rollback`. */
async function repairApply(ctx: ScenarioContext): Promise<void> {
  const { rafi, step, project, computer } = ctx;
  const file = path.join(project, ".tickets", "tickets.yaml");
  const tickets = () => parse(readFileSync(file, "utf8")).tickets as Record<string, unknown>[];
  await step("repair --risk-notes --apply: a read-only Ticket Maker turn per ticket; PRM-56; only rollback changes",
    async () => {
      setTickets(project, { T5: { risk: "High" }, T6: { risk: "Medium" } });
      const gaps = (await rafi("tickets repair --risk-notes")).output;
      const targets = ["T4", "T5", "T6"].filter((id) => gaps.includes(`${id} (`));
      assert.ok(targets.includes("T5") && targets.includes("T6"), gaps);
      const before = tickets();
      const turns = computer.script.transcript.length;
      const no = await rafi("tickets repair --risk-notes --apply", { tty: true, input: ["2"] });
      assert.equal(no.code, 0, no.output);
      assert.match(no.output, new RegExp(`Apply rollback-only repairs to ${targets.join(", ")}\\?`));
      assert.deepEqual(tickets(), before, "declined: nothing written");
      const made = computer.script.transcript.slice(turns);
      assert.deepEqual(made.map((t) => [t.role, t.ticket, t.step]), targets.map((id) => ["ticket-maker", id,
        "risk-notes"]), "one turn per ticket");
      const readOnly = (t: (typeof made)[number]) => (t.runtime === "claude"
        ? ((t.sandbox as { filesystem?: { allowWrite?: string[] } } | null)?.filesystem?.allowWrite ?? [1]).length === 0
        : t.writable === false);
      assert.ok(made.every((t) => readOnly(t) && t.session === "new"), "read-only, fresh sessions");
      assert.equal((await rafi("tickets repair --risk-notes --apply")).code, 1, "no terminal, no -y");
      const r = await rafi("tickets repair --risk-notes --apply", { tty: true, input: ["1"] });
      assert.equal(r.code, 0, r.output);
      const after = tickets();
      for (const t of after) {
        const was = before.find((b) => b.id === t.id)!;
        if (!targets.includes(String(t.id))) { assert.deepEqual(t, was); continue; }
        assert.match(String(t.rollback), new RegExp(`^Revert ${String(t.id)}'s`));
        assert.deepEqual({ ...t, rollback: undefined }, { ...was, rollback: undefined },
          `${String(t.id)}: only rollback`);
      }
      const changed = (await exported(ctx)).events.filter((e) => e.type === "tickets.changed").at(-1)!;
      assert.deepEqual((changed.data as { items: unknown[] }).items, targets.map((ticket) => ({ ticket,
        field: "rollback" })));
      assert.equal((await rafi("tickets validate")).code, 0);
      assert.match((await rafi("tickets repair --risk-notes")).output, /Every Medium and High ticket has a rollback/);
    });
}

scenario({
  id: "S-CLI-4", covers: covers("S-CLI-4"), modes: ["next"], fixture: "F-CHAIN",
  async run(ctx) {
    await setupSteps(ctx);
    await trackerSteps(ctx);
    await reviewStep(ctx);
    await resetSteps(ctx);
    await viewSteps(ctx);
    await repairApply(ctx);
  },
});
