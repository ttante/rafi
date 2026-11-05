// Milestone: M5
// Part 6 (follow-up): file names are git's own bytes, never its C-quoted form. With git's default `core.quotePath`,
// `git diff --name-only` prints `"src/Caf\303\251.tsx"` for `src/Café.tsx`; read without `-z`, that reached QA's
// changed-file list, tag matching and QA's restore. A non-ASCII name and one with a control character (left out on
// Windows, which forbids them), both changed by the builder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import type { EventsExport } from "../checks/invariants.js";
import { B, on } from "../fakes/script/behaviors.js";
import { fUi } from "../fixtures/f-ui.js";
import { git, tempRoot } from "../fixtures/common.js";
import { newComputer, rafiRunner } from "../harness/rafi.js";

const CAFE = "src/Café.tsx";
const CTL = process.platform === "win32" ? "src/Tab Name.tsx" : "src/\u0001Ctl.tsx";
const shown = (f: string) => f.replace("\u0001", "\\u0001");

test("non-ASCII and control-character names: QA's changed-file list, the tag match and QA's restore use the real " +
  "names", async () => {
  const root = tempRoot();
  const dir = fUi(root);
  const config = path.join(dir, "rafi-config.yaml");
  writeFileSync(config, stringify({ ...parse(readFileSync(config, "utf8")), checks: { test_runner: "fake-test" } }));
  git(dir, ["commit", "-qam", "fake-test runner"]);
  const computer = newComputer(root, "a");
  const rafi = rafiRunner(computer, dir);
  computer.script.rules.push(on("builder T2#1 @build", B.also({ edit: CAFE, content: "export const C = 1;\n" },
    { edit: CTL, content: "export const D = 1;\n" })));
  computer.checks.tests["names.test"] = { outcomes: ["pass"], edits: CAFE };
  computer.script.rules.push(on("qa T2 @review", B.also({ runCheck: "fake-test names.test" })));
  const r = await rafi("start . --steps 2");
  assert.equal(r.code, 0, r.output);
  const e = (JSON.parse((await rafi("stats export")).out) as EventsExport).events;
  const tags = e.filter((x) => x.type === "ticket.tags_added" && x.ticket_id === "T2")
    .flatMap((x) => (x.data as { tags: { tag: string; reason: string }[] }).tags);
  const ui = tags.find((t) => t.tag === "ui");
  assert.ok(ui, `ui added from the builder's changes\n${r.output}`);
  assert.ok([CAFE, CTL].some((f) => ui.reason === `builder changed ${f} (matches **/*.tsx)`), ui.reason);
  const qa = computer.script.transcript.find((t) => t.ticket === "T2" && t.role === "qa" && /Changed files:/
    .test(t.message));
  assert.ok(qa, "QA's review message");
  const list = /Changed files: (.*)\./.exec(qa.message)![1]!;
  for (const f of [CAFE, CTL]) assert.ok(list.split(", ").includes(shown(f)), `${shown(f)} in: ${list}`);
  const run = e.find((x) => x.type === "check.run" && (x.data as { command: string }).command ===
    "fake-test names.test")?.data as { restored: string[]; outcome: string; asked_by: string } | undefined;
  assert.ok(run, JSON.stringify(e.filter((x) => x.type === "check.run").map((x) => x.data)));
  assert.equal(run.asked_by, "qa");
  assert.deepEqual(run.restored, [CAFE], `QA's run put the file back by its real name: ${JSON.stringify(run)}`);
  assert.equal(readFileSync(path.join(dir, CAFE), "utf8"), "export const C = 1;\n");
});
