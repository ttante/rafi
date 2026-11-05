// P48 (ARCH 1.2 row 1, 7.11; M5 plan section 4's first row): `rafi-config.yaml` is read-only for agents. Claude's
// sandbox denies writing it, and rafi's permission policy refuses an edit of it, as it does `.rafi/`, `.tickets/`
// and `.git/`. (Codex's profile entry waits on item 22's `codex sandbox -P` probe of a single-file `read` entry.)
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { queryOptions } from "../../src/agents/claude/options.js";
import { decidePermission } from "../../src/agents/permissions.js";

const root = path.resolve("/work/project");
const ctx = { root, writable: true, repair: false, grants: [] };
const edit = (file: string) => decidePermission({ tool: "Edit", command: null, path: file, reason: null }, ctx);

test("the builder's Claude sandbox denies writing rafi-config.yaml; src/ stays writable", () => {
  const first = { message: "x", meta: {}, grants: [] } as never;
  const o = queryOptions({ cwd: root, structured: false }, first, {}) as { sandbox: { filesystem: { denyWrite: string[];
    allowWrite: string[] } } };
  assert.ok(o.sandbox.filesystem.denyWrite.includes(path.join(root, "rafi-config.yaml")),
    JSON.stringify(o.sandbox.filesystem));
  assert.deepEqual(o.sandbox.filesystem.allowWrite, [root]);
});

test("rafi's policy refuses an agent's edit of rafi-config.yaml and allows src/", () => {
  assert.equal(edit("rafi-config.yaml").decision, "deny");
  assert.equal(edit(path.join(root, "rafi-config.yaml")).decision, "deny");
  assert.equal(edit("src/App.tsx").decision, "allow");
  assert.equal(edit("docs/rafi-config.yaml").decision, "allow", "only the project's own file");
});
