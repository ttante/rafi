// S-SCN-3 (SCN 4.1): resuming a batch keeps the whole batch. F-BIG34 (QA off, C159); a crash as T5's builder turn
// goes out; `rafi resume` finishes all 34, and `rafi status` from a second instance shows the scope "34 ticket(s)"
// right after the crash and at every step boundary of the resumed build. Speed (M4 part 4, as C160): two shards,
// each running the whole crash and resume and checking status at every other step boundary, so the two together
// check every one and neither job nears 10 s.
import assert from "node:assert/strict";
import { registry } from "../checks/registry.js";
import { fBig34 } from "../fixtures/f-big34.js";
import { scenario } from "../harness/scenario.js";
import { exported } from "./m3-helpers.js";

export function batchResume(shard: 0 | 1): void {
  scenario({
    id: "S-SCN-3", covers: registry.find((r) => r.id === "S-SCN-3")!.covers, modes: ["next"], fixture: "none",
    async run(ctx) {
      const { rafi, step, root } = ctx;
      const dir = fBig34(`${root}/big`);
      await step(`start . --steps 34; a crash as T5's builder turn goes out; resume finishes all 34 (status at ${
        shard ? "odd" : "even"} step boundaries)`, async () => {
        const crashed = await rafi("start . --steps 34", { cwd: dir, crashAt: "2: sent, before any reply (T5, build" });
        assert.ok(crashed.crashed, crashed.output);
        const scopes: string[] = [(await rafi("status", { cwd: dir })).output];
        let boundary = 0;
        const r = await rafi("resume", { cwd: dir, pauseAt: { at: (o) => o.startsWith("4:"), fn: async () => {
          if (boundary++ % 2 === shard) scopes.push((await rafi("status", { cwd: dir })).output);
        } } });
        assert.equal(r.code, 0, r.output);
        assert.ok(scopes.length > 17, `${scopes.length} status checks`);
        for (const s of scopes) assert.match(s, /scope: 34 ticket\(s\)/);
        const done = (await exported(ctx, dir)).events.filter((e) => e.type === "delivery.done");
        assert.equal(new Set(done.map((e) => e.ticket_id)).size, 34);
      });
    },
  });
}
