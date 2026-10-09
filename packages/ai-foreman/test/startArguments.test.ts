import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { buildStartCommand, savedStartArguments, validatePreparationArguments } from "../src/cli/start.js";

test("preparation persists actual parsed start options including repeatable tickets and negative flags", async () => {
  const command = buildStartCommand();
  let saved: string[] = [];
  command.action((_project, opts, cmd) => { saved = savedStartArguments(cmd, "/absolute/project", opts); });
  await command.parseAsync([".", "--steps", "9", "--no-qa", "--no-supervisor", "--ticket", "T001", "--ticket", "T002", "--model", "literal $(value)", "--tickets", "relative tickets.md"], { from: "user" });
  assert.deepEqual(saved.slice(0, 2), ["start", "/absolute/project"]);
  assert.equal(saved[saved.indexOf("--steps") + 1], "9");
  assert.equal(saved[saved.indexOf("--model") + 1], "literal $(value)");
  assert.ok(saved.includes("--no-qa"));
  assert.ok(saved.includes("--no-supervisor"));
  assert.equal(saved.filter(value => value === "--ticket").length, 2);
  assert.ok(!saved.includes("--qa"));
  assert.equal(saved[saved.indexOf("--tickets") + 1], resolve("relative tickets.md"));
});

for (const flags of [ ["--steps", "1", "--stacks", "1"], ["--steps", "1.5"], ["--steps", "1", "--effort", "invalid"], ["--steps", "1", "--autonomy", "invalid"], [], ["--stacks", "1", "--ticket", "T001"] ]) test(`saved preparation rejects invalid options ${flags.join(" ")}`, () => {
  assert.throws(() => validatePreparationArguments(["start", process.cwd(), ...flags], process.cwd()));
});

import { validateStartOptions, validateRecoveryArguments } from "../src/cli/start.js";
import { normalizeNestedLaunchArguments } from "../src/supervisedStart.js";
import { launchDigest } from "../src/buildAdmission.js";
test("established recovery accepts transferred token without preparation authority", () => {
  validateStartOptions({ steps: "1", recoverRun: "existing", launchToken: "token" }, true);
  validateStartOptions({ steps: "1", recoverRun: "existing" }, true);
  validateRecoveryArguments(["start", process.cwd(), "--steps", "1", "--recover-run", "existing"], process.cwd());
  for (const options of [{ launchToken: "orphan" }, { preparationRun: "missing-token" }, { preparationRun: "new", recoverRun: "existing", launchToken: "token" }]) {
    assert.throws(() => validateStartOptions({ steps: "1", ...options }, true));
  }
});
test("nested launch replaces outer capability without changing invocation digest", () => {
  const args = ["start", process.cwd(), "--steps", "1", "--recover-run", "existing", "--launch-token=outer"];
  const nested = normalizeNestedLaunchArguments(args, "inner");
  assert.deepEqual(nested.slice(-2), ["--launch-token", "inner"]);
  assert.ok(!nested.includes("--launch-token=outer"));
  const command = buildStartCommand(); command.parseOptions(nested.slice(2));
  validateStartOptions(command.opts(), true);
  assert.equal(launchDigest(savedStartArguments(command, process.cwd(), command.opts())), launchDigest(args.slice(0, -1)));
});
