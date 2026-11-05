// Milestone: M5
// M5 C212: rafi-owned tickets (FIX-<n>) are defined only by `ticket.added`, never in tickets.yaml, and `rafi tickets
// show` lists them: by id, in the full list (first, as the queue puts them), readable and as JSON with `owned`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { git, tempRoot } from "../fixtures/common.js";
import { fOne } from "../fixtures/f-one.js";
import { newComputer, rafiRunner } from "../harness/rafi.js";

const OWNED = { source: "ci", requirements: ["suite/x.test"], hint: "T1", unit: null };

test("C212: rafi tickets show FIX-1 shows a rafi-owned ticket; the full list has it first, with its owned fields",
  async () => {
    const root = tempRoot();
    const project = fOne(root);
    const computer = newComputer(root);
    const rafi = rafiRunner(computer, project);
    // A fix ticket from another computer's progress file (P49): the start imports it, rafi-owned.
    mkdirSync(path.join(project, ".rafi"), { recursive: true });
    writeFileSync(path.join(project, ".rafi", "progress.yaml"), stringify({ version: 1, tickets: {
      "FIX-1": { status: "blocked", at: "2099-01-01T00:00:00.000Z", reason: "waiting", owned: OWNED } },
    questions: {}, answers: {} }));
    git(project, ["add", "-f", ".rafi/progress.yaml"]);
    git(project, ["commit", "-qm", "progress"]);
    const started = await rafi("start . --steps 1 --no-qa");
    assert.match(started.output, /Rebuilt build state/, started.output);
    const one = await rafi("tickets show FIX-1");
    assert.equal(one.code, 0, one.output);
    assert.match(one.out, /FIX-1/);
    assert.match(one.out, /Fix 1 failing test/);
    const json = await rafi("tickets show --json");
    assert.equal(json.code, 0, json.output);
    const tickets = (JSON.parse(json.out) as { tickets: { id: string; owned?: unknown; status: string }[] }).tickets;
    assert.deepEqual(tickets.map((t) => t.id), ["FIX-1", "T1"]);
    assert.deepEqual(tickets[0]!.owned, OWNED);
    assert.equal(tickets[1]!.owned, undefined, "an ordinary ticket has no owned field");
  });
