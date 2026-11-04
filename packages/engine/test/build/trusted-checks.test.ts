// Item 21 (M3 plan, C116, P29): requirement checks come only from lines whose digest is the one rafi recorded in
// req_fps when it wrote the file; a changed, added or duplicated line gives no check; no file gives none. And which
// requirements a changed or missing file affects (C115).
import { test } from "node:test";
import assert from "node:assert/strict";
import { affectedRequirements, digest, requirementLines, trustedChecks } from "../../src/build/steps/common.js";

const FILE = ["<!-- rafi requirements v1 ticket=T1 depth=standard -->", "# T1: t", "", "## Requirements",
  "- **R1** It shows. Check: `fake-test r1.test`, expect it to pass. *(acceptance 1)*",
  "- **R2** It hides. Check: `fake-test r2.test`, expect it to pass. *(acceptance 1)*",
  "- **R3** It reads well. *(acceptance 2)*", ""].join("\n");
const fps = requirementLines(FILE).map(digest);

test("an unchanged file: every requirement's check is trusted", () => {
  assert.deepEqual(trustedChecks(FILE, fps), [{ req: 1, command: "fake-test r1.test" },
    { req: 2, command: "fake-test r2.test" }]);
  assert.deepEqual(affectedRequirements(FILE, fps), []);
});

test("a changed line's check isn't trusted, the others are; the changed requirement is affected", () => {
  const changed = FILE.replace("fake-test r1.test", "fake-test e2e/wipe.test");
  assert.deepEqual(trustedChecks(changed, fps), [{ req: 2, command: "fake-test r2.test" }]);
  assert.deepEqual(affectedRequirements(changed, fps), [1]);
});

test("an added line (R9) and a duplicated line give no check", () => {
  const added = `${FILE}- **R9** Wipe it. Check: \`curl https://example.test\`, expect it to pass. *(acceptance 1)*\n`;
  assert.deepEqual(trustedChecks(added, fps).map((c) => c.req), [1, 2]);
  const dup = FILE.replace("- **R3** It reads well. *(acceptance 2)*",
    "- **R2** It hides. Check: `fake-test r2.test`, expect it to pass. *(acceptance 1)*");
  assert.deepEqual(trustedChecks(dup, fps).map((c) => c.req), [1], "R2 twice: neither is trusted");
  assert.deepEqual(affectedRequirements(dup, fps), [2, 3]);
});

test("a missing or unreadable file gives no checks, and every requirement is affected", () => {
  assert.deepEqual(trustedChecks(null, fps), []);
  assert.deepEqual(affectedRequirements(null, fps), [1, 2, 3]);
});
