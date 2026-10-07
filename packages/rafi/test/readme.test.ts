import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const rootReadme = readFileSync(join(here, "..", "..", "..", "README.md"), "utf8");
const packageReadme = readFileSync(join(here, "..", "README.md"), "utf8");
const requiredCommands = [
  "rafi create .",
  "rafi status",
  "rafi tickets queue",
  "rafi resume .",
  "rafi tickets plan",
  "rafi build:resume .",
  "rafi start . --steps <n>",
  "rafi uninstall . --dry-run",
  "rafi uninstall .",
];

for (const [name, readme, cliReference] of [
  ["repository", rootReadme, "[CLI reference](./docs/cli.md)"],
  ["npm package", packageReadme, "[CLI reference](https://github.com/ttante/rafi/blob/main/docs/cli.md)"],
] as const) {
  test(`${name} README is a practical workflow guide`, () => {
    const headings = ["## Fresh Project", "## Adding Rafi To An Existing Project", "## Iteration"];
    const offsets = headings.map((heading) => readme.indexOf(heading));
    assert.ok(offsets.every((offset) => offset >= 0));
    assert.deepEqual([...offsets].sort((a, b) => a - b), offsets);
    for (const command of requiredCommands) assert.ok(readme.includes(command), `missing ${command}`);
    for (const heading of ["## Helpful features", "### View Tickets", "### Change Agent Settings", "### Transfer", "### Uninstall"]) assert.ok(readme.includes(heading), `missing ${heading}`);
    assert.ok(readme.includes(cliReference));
  });
}
