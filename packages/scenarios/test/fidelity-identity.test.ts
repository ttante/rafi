// Milestone: M4
// Item 25 (M4 plan 3.3, P8 option C): the turn identity the process fakes read from rafi's log (identity.mjs) is,
// for every turn, the meta the in-process fake gets: a turn retried in the run (raised attempt) and a repair after
// a retry included (C166).
import { test } from "node:test";
import assert from "node:assert/strict";
import { B, on } from "../fakes/script/behaviors.js";
import type { MetaLike } from "../fakes/script/engine.js";
import { turnIdentity } from "../fakes/script/identity.mjs";
import { tempRoot } from "../fixtures/common.js";
import { fChain } from "../fixtures/f-chain.js";
import { newComputer, rafiRunner } from "../harness/rafi.js";

type Seen = { meta: MetaLike; read: MetaLike | null };

for (const runtime of ["claude", "codex"] as const) {
  test(`${runtime}: every turn's identity in the log equals the in-process meta, retries and repairs included`,
    async () => {
      const root = tempRoot();
      const project = fChain(root);
      const computer = newComputer(root);
      const seen: Seen[] = [];
      computer.script.onTurn = (meta, cwd) => {
        const read = turnIdentity(cwd);
        seen.push({ meta: { role: meta.role, ticket: meta.ticket, step: meta.step, attempt: meta.attempt },
          read: read && { role: read.role, ticket: read.ticket, step: read.step, attempt: read.attempt } });
      };
      // T1's build is malformed (repaired); T2's build fails once (retried at attempt 2), then is malformed and
      // repaired at that attempt.
      computer.script.rules.push(on("builder T1#1 @build", B.malformed(300)),
        on("builder T2#1 @build", B.error("transient")), on("builder T2 @build", B.malformed(300)));
      const r = await rafiRunner(computer, project)(`start . --steps 2 --agent ${runtime}`);
      assert.equal(r.code, 0, r.output);
      assert.ok(seen.length >= 10, `${seen.length} turns`);
      for (const s of seen) assert.deepEqual(s.read, s.meta);
      assert.ok(seen.some((s) => s.meta.ticket === "T2" && s.meta.attempt === 2), "the retry's raised attempt");
      assert.equal(seen.filter((s) => s.meta.ticket === "T2" && s.meta.step === "build" && s.meta.attempt === 2)
        .length, 2, "the retry and its repair, both at attempt 2");
    });
}

test("with no log, the identity is null (the fakes then apply rules in order)", () => {
  assert.equal(turnIdentity(tempRoot()), null);
});
