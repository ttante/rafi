// Milestone: M5
// M5 plan section 4 (ARCH 1.2 rows M5's code touches; P40), the rows security-m5-git, the race files, settings and
// tickets-b don't already hold: agents can't drive rafi's tracker and settings commands or edit their files; tools
// only from rafi-config.yaml; hostile delivery config refused before any turn; secrets out of every M5 output;
// damaged policy and delivery files; `rafi agents` and locked keys. (A held secret commit's retry and hostile CI
// text are in security-m5-data.test.ts.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import type { EventsExport } from "../checks/invariants.js";
import { B, on } from "../fakes/script/behaviors.js";
import { configure, git, setTickets, tempRoot } from "../fixtures/common.js";
import { fOne } from "../fixtures/f-one.js";
import { newComputer, rafiRunner } from "../harness/rafi.js";
import { setup as branchSetup } from "./git-race-helpers.js";

const NO_CI = { checks: { ci_tests: "none" } };
const SECRET = "s3cr3t-canary-0123456789";

function setup(env: Record<string, string> = {}) {
  const root = tempRoot();
  const project = fOne(root);
  const computer = newComputer(root, "a", env);
  const rafi = rafiRunner(computer, project);
  const exported = async () => JSON.parse((await rafi("stats export")).out) as EventsExport;
  return { root, project, computer, rafi, exported };
}

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const RAFI_FILES = ["rafi-config.yaml", ".tickets/tickets.yaml", ".tickets/delivery.yaml"];

const COMMANDS = ["rafi tickets update T1 --status done", "rafi tickets reorder T1 --order 2",
  "rafi tickets complete T1 --summary x", "npx rafi agents --agent-type builder --session-strategy compact",
  "rafi start . --set retries.fixes=9", "env FOO=1 rafi tickets block T1 --summary y"];

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: a builder can't run rafi tickets, rafi agents or --set, or edit rafi-config.yaml or the ` +
    "tracker files; no event with an agent actor, the files unchanged", async () => {
    const { project, computer, rafi, exported } = setup();
    const before = RAFI_FILES.map((f) => sha(path.join(project, f)));
    computer.script.rules.push(on("builder T1#1 @build", B.also(...COMMANDS.map((shell) => ({ shell })),
      ...RAFI_FILES.map((edit) => ({ edit, content: "version: 1\nhacked: true\n" })))));
    const r = await rafi(`start . --steps 1 --agent ${runtime}`);
    assert.equal(r.code, 0, r.output);
    const e = await exported();
    if (runtime === "claude") {
      // Claude asks rafi before each command and edit, so the policy refuses them (a Codex shell command runs
      // inside its sandbox, where the profile keeps .rafi/, .tickets/ and rafi-config.yaml read-only).
      const refused = e.events.filter((x) => x.type === "turn.tool" && x.data.outcome !== "completed");
      for (const c of COMMANDS) assert.ok(refused.some((x) => String(x.data.command).includes(c)), c);
      assert.match(r.output, /Agents never run rafi commands/);
    }
    assert.deepEqual(RAFI_FILES.map((f) => sha(path.join(project, f))), before, "rafi's files unchanged");
    assert.ok(!e.events.some((x) => String(x.actor).startsWith("agent")), "no event with an agent actor");
    const writes = ["ticket.status_set", "tickets.changed", "ticket.dropped"];
    const from = e.events.find((x) => x.type === "build.started")!.seq;
    assert.deepEqual(e.events.filter((x) => x.seq > from && writes.includes(x.type)), []);
    const started = e.events.find((x) => x.type === "build.started")!.data as { settings: Record<string,
      { value: unknown }> };
    assert.notEqual(started.settings["retries.fixes"]?.value, 9);
  });
}

test("tools reach sessions only from rafi-config.yaml: a ticket field naming or defining a tool is ignored",
  async () => {
    const { project, computer, rafi } = setup();
    setTickets(project, { T1: { tags: ["ai"], tools: ["model-evals", { kind: "command",
      start: { command: "scripts/evil.sh" }, roles: ["builder"], tags: ["ai"] }] } });
    const r = await rafi("start . --steps 1 --no-qa");
    assert.equal(r.code, 0, r.output);
    const builder = computer.script.transcript.find((t) => t.ticket === "T1" && t.role === "builder" &&
      t.session === "new")!;
    assert.doesNotMatch(builder.instructions, /Tools for this ticket|model-evals|evil\.sh/);
  });

for (const [name, change, key] of [
  ["branch_prefix --upload-pack=x", { build: { branch_strategy: "branch-per-ticket",
    branch_prefix: "--upload-pack=x" } }, /branch_prefix/],
  ["base_branch -x", { build: { branch_strategy: "branch-per-ticket", base_branch: "-x" } }, /base_branch/],
  ["a unit branch ../x", { units: [{ id: "U1", tickets: ["T1", "T2"], branch: "../x" }] }, /U1|branch/],
  ["a unit branch a..b", { units: [{ id: "U1", tickets: ["T1", "T2"], branch: "a..b" }] }, /U1|branch/],
] as const) {
  test(`hostile delivery config (${name}) is refused before any turn, naming the key`, async () => {
    const { rafi, exported, computer } = branchSetup({ config: NO_CI, ...change } as never);
    const r = await rafi("start . --steps 1");
    assert.equal(r.code, 1, r.output);
    assert.match(r.output, key);
    assert.equal(computer.script.transcript.length, 0, "no agent turn");
    assert.ok(!(await exported()).events.some((x) => x.type === "turn.intent" || x.type.startsWith("git.")));
  });
}

test("a canary in a ticket title and a builder summary is redacted in commit messages, branch names, PR bodies and " +
  "titles, docs/ticket-progress.md, tickets show and stats export", async () => {
  const tickets = [{ id: "T1", title: `Add ${SECRET} parser` }, { id: "T2", title: "Add the printer" },
    { id: "T3", title: "Add the store" }, { id: "T4", title: "Add the sync" }];
  const tracker = { ".tickets/config.yaml": stringify({ app_name: "fixture", implementation_limit: 500,
    view_limit: 20000, timezone: "UTC" }) };
  const { project, computer, rafi, exported } = branchSetup({ tickets, files: tracker,
    config: { ...NO_CI, checks: { ci_tests: "none", env: ["TEST_API_KEY"] } }, build: { completion: "pr" } },
  { TEST_API_KEY: SECRET });
  computer.script.rules.push(on("builder T1#1 @build", { steps: [{ edit: "src/T1.txt", content: "T1 done\n" }],
    reply: { kind: "done", summary: `Built it; the key is ${SECRET}.`, runs: [], block: null, question: null } }));
  const r = await rafi("start . --steps 1 --branch-per-ticket", { env: { TEST_API_KEY: SECRET } });
  assert.equal(r.code, 0, r.output);
  const branches = git(project, ["for-each-ref", "--format=%(refname)", "refs/heads"]);
  assert.ok(!branches.includes(SECRET), branches);
  const log = git(project, ["log", "--all", "--format=%B"]);
  assert.ok(!log.includes(SECRET), "a commit message has the canary");
  assert.match(log, /Rafi-Ticket: T1/);
  for (const pr of computer.gh.prs) assert.ok(!pr.title.includes(SECRET) && !pr.body.includes(SECRET), pr.title);
  assert.ok(computer.gh.prs.length === 1);
  for (const c of computer.gh.calls) assert.ok(!c.args.join(" ").includes(SECRET), c.args.join(" "));
  const doc = readFileSync(path.join(project, "docs", "ticket-progress.md"), "utf8");
  assert.ok(!doc.includes(SECRET) && doc.includes("T1"), doc);
  const show = await rafi("tickets show T1 --json", { env: { TEST_API_KEY: SECRET } });
  assert.equal(show.code, 0, show.output);
  assert.ok(!show.raw.includes(SECRET), "tickets show has the canary");
  const status = await rafi("status", { env: { TEST_API_KEY: SECRET } });
  assert.ok(!status.raw.includes(SECRET));
  assert.ok(!JSON.stringify(await exported()).includes(SECRET), "stats export has the canary");
  assert.ok(!r.raw.includes(SECRET));
});

test("--set values that are declared secrets are redacted in build.started.settings; setup keeps only the " +
  "token's variable name in rafi-config.yaml", async () => {
  const { project, computer, rafi, exported } = setup({ TEST_API_KEY: SECRET, LINEAR_API_KEY: "lin-tok-987654321" });
  configure(project, { checks: { env: ["TEST_API_KEY"] } });
  const r = await rafi(`start . --steps 1 --no-qa --set tickets.build.branch_prefix=${SECRET}`,
    { env: { TEST_API_KEY: SECRET } });
  assert.equal(r.code, 0, r.output);
  const started = (await exported()).events.find((x) => x.type === "build.started")!;
  assert.ok(!JSON.stringify(started).includes(SECRET), JSON.stringify(started.data));
  assert.ok(!r.raw.includes(SECRET));
  computer.http.routes.set("https://api.linear.app/graphql", { status: 200, body: "{}" });
  const s = await rafi("tickets setup:update -y --defaults --linear --linear-team-key ENG",
    { env: { LINEAR_API_KEY: "lin-tok-987654321" } });
  assert.equal(s.code, 0, s.output);
  const text = readFileSync(path.join(project, "rafi-config.yaml"), "utf8");
  assert.doesNotMatch(text, /lin-tok-987654321/);
  assert.match(text, /LINEAR_API_KEY/, "the variable's name is saved");
  const auth = computer.http.log.map((x) => JSON.stringify(x.headers));
  assert.ok(auth.some((h) => h.includes("lin-tok-987654321")), "the token went to its own host");
});

test("a damaged ~/.rafi/policy.yaml refuses to start (fail closed), before any turn", async () => {
  const { computer, rafi, exported } = setup();
  mkdirSync(computer.stateDir, { recursive: true });
  writeFileSync(path.join(computer.stateDir, "policy.yaml"), "version: 1\nlocked: [not: a map\n");
  const r = await rafi("start . --steps 1");
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /policy\.yaml/);
  assert.equal(computer.script.transcript.length, 0);
  assert.ok(!(await exported()).events.some((x) => x.type === "build.started"));
});

test("rafi agents can't change a locked key; a build shows its source as policy", async () => {
  const { project, computer, rafi, exported } = setup();
  mkdirSync(computer.stateDir, { recursive: true });
  writeFileSync(path.join(computer.stateDir, "policy.yaml"), stringify({ version: 1,
    locked: { "agent_defaults.roles.builder.session_strategy": "fresh" } }));
  const before = sha(path.join(project, "rafi-config.yaml"));
  const r = await rafi("agents --agent-type builder --session-strategy compact");
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /locked by your organization's policy/);
  assert.equal(sha(path.join(project, "rafi-config.yaml")), before);
  const b = await rafi("start . --steps 1 --no-qa");
  assert.equal(b.code, 0, b.output);
  const started = (await exported()).events.find((x) => x.type === "build.started")!.data as
    { settings: Record<string, { source: string }> };
  assert.equal(started.settings["agent_defaults.roles.builder.session_strategy"]?.source, "policy");
});

test("tickets setup:init and setup:update can't change a locked key, with rafi agents's message (part 6)",
  async () => {
    const { project, computer, rafi } = setup();
    mkdirSync(computer.stateDir, { recursive: true });
    writeFileSync(path.join(computer.stateDir, "policy.yaml"), stringify({ version: 1,
      locked: { "tickets.build.completion": "none" } }));
    const before = sha(path.join(project, "rafi-config.yaml"));
    for (const cmd of ["tickets setup:update -y --skip-access-check --completion pr",
      "tickets setup:init -y --defaults --skip-access-check --completion pr"]) {
      const r = await rafi(cmd);
      assert.equal(r.code, 1, `${cmd}\n${r.output}`);
      assert.match(r.output,
        /tickets\.build\.completion is locked by your organization's policy \(~\/\.rafi\/policy\.yaml\)/, cmd);
      assert.equal(sha(path.join(project, "rafi-config.yaml")), before, cmd);
    }
  });

test("an invalid delivery.yaml at a safe point keeps the last good definitions, said once; the build goes on",
  async () => {
    const { project, computer, rafi, exported } = branchSetup({ config: NO_CI });
    const file = path.join(project, ".tickets", "delivery.yaml");
    computer.script.rules.push(on("builder T1#1 @build", B.slow(2)));
    computer.clock.whenTimer("agent", () => writeFileSync(file, "version: 1\nunits: [{ id: U1, nonsense: 3 }]\n"));
    const r = await rafi("start . --steps 2 --branch-per-ticket");
    assert.equal(r.code, 0, r.output);
    assert.equal(r.output.match(/keeps building from the last good definitions/g)?.length, 1, r.output);
    assert.match(r.output, /delivery\.yaml/);
    const e = await exported();
    assert.deepEqual(e.events.filter((x) => x.type === "delivery.done").map((x) => x.ticket_id), ["T1", "T2"]);
    const from = e.events.find((x) => x.type === "build.started")!.seq;
    assert.equal(e.events.filter((x) => x.seq > from && x.type === "tickets.changed").length, 0,
      "nothing recorded from it");
  });

test("another program calling rafi: tickets writes record their actor and source (flag without a terminal, " +
  "terminal with one)", async () => {
  const { rafi, exported } = setup();
  assert.equal((await rafi("tickets block T1 --summary waiting --actor manager")).code, 0);
  assert.equal((await rafi("tickets unblock T1", { tty: true })).code, 0);
  const writes = (await exported()).events.filter((x) => x.type === "ticket.status_set");
  assert.deepEqual(writes.map((x) => [x.actor, x.source]), [["manager", "flag"], ["user", "terminal"]]);
});
