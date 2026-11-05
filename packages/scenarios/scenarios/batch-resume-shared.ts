// S-SCN-3 (SCN 4.1): resuming a batch keeps the whole batch. F-BIG34 (QA off, C159); a crash as T5's builder turn
// goes out; `rafi resume` finishes all 34, and `rafi status` from a second instance shows the scope "34 ticket(s)"
// right after the crash and at every step boundary of the resumed build. Speed: M4 part 4 split it into two shards
// (C160), but each shard ran the whole 34-ticket build again (5.4 s of its 6.1 s alone), so M5 part 4a-2 (plan 10.8)
// runs it once, checking status at every boundary: about 6.9 s alone instead of 12.2 s.
import assert from "node:assert/strict";
import { registry } from "../checks/registry.js";
import { fBig34 } from "../fixtures/f-big34.js";
import { scenario } from "../harness/scenario.js";
import { exported } from "./m3-helpers.js";

export function batchResume(): void {
  scenario({
    id: "S-SCN-3", covers: registry.find((r) => r.id === "S-SCN-3")!.covers, modes: ["next"], fixture: "none",
    async run(ctx) {
      const { rafi, step, root } = ctx;
      const dir = fBig34(`${root}/big`);
      await step("start . --steps 34; a crash as T5's builder turn goes out; resume finishes all 34 (status at "
        + "every step boundary)", async () => {
        const crashed = await rafi("start . --steps 34", { cwd: dir, crashAt: "2: sent, before any reply (T5, build" });
        assert.ok(crashed.crashed, crashed.output);
        const scopes: string[] = [(await rafi("status", { cwd: dir })).output];
        const r = await rafi("resume", { cwd: dir, pauseAt: { at: (o) => o.startsWith("4:"), fn: async () => {
          scopes.push((await rafi("status", { cwd: dir })).output);
        } } });
        assert.equal(r.code, 0, r.output);
        assert.ok(scopes.length > 34, `${scopes.length} status checks`);
        for (const s of scopes) assert.match(s, /scope: 34 ticket\(s\)/);
        const done = (await exported(ctx, dir)).events.filter((e) => e.type === "delivery.done");
        assert.equal(new Set(done.map((e) => e.ticket_id)).size, 34);
      });
    },
  });
}
