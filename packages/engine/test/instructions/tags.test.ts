// M5 plan item 29 and R18 (C220, C239): pattern matching on POSIX and Windows-style paths, one reason per tag,
// only adds; and the additions decided inside the append's transaction, so a tag someone else records between
// rafi's look and its write is never added twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { TicketV1 } from "rafi-spec/v1";
import { openEngine, type Engine } from "../../src/api/engine.js";
import type { Deps } from "../../src/deps/types.js";
import { openRealDb } from "../../src/deps/real/db.js";
import { realFs } from "../../src/deps/real/fs.js";
import { fixedTags } from "../../src/instructions/packs.js";
import { addTags, tagAdditions, tagPatterns, ticketTags } from "../../src/instructions/tags.js";
import { manualClock, tempDir } from "../helpers.js";

const patterns = tagPatterns({ tags: { value: { payments: { patterns: ["src/pay/**"] } }, source: "project" } },
  await fixedTags(realFs({ id: () => "x", jitter: () => 0 })));

test("patterns match POSIX and Windows-style paths, one reason per tag, never a tag already there", () => {
  assert.deepEqual(tagAdditions(new Set(), ["src/App.tsx", "src/app.css"], patterns, "likely"),
    [{ tag: "ui", reason: "src/App.tsx matches **/*.tsx" }]);
  assert.deepEqual(tagAdditions(new Set(), ["src\\pay\\card.ts"], patterns, "changed"),
    [{ tag: "payments", reason: "builder changed src/pay/card.ts (matches src/pay/**)" }]);
  assert.deepEqual(tagAdditions(new Set(["ui"]), ["src/App.tsx"], patterns, "likely"), [], "only adds");
  assert.deepEqual(tagAdditions(new Set(), ["README.md", "src/T1.txt"], patterns, "likely"), []);
});

async function engine(): Promise<Engine> {
  let n = 0;
  const random = { id: () => `id-${++n}`, jitter: () => 0 };
  const deps = { fs: realFs(random), db: { open: (f: string, o?: { readonly?: boolean }) => openRealDb(f, o) },
    clock: manualClock(), random, env: {}, hooks: { crash() {}, pause() {} },
    processes: { self: () => ({ instance: "m", host: "h", pid: 1, startedAt: null }), isAlive: async () => false },
  } as unknown as Deps;
  return openEngine({ projectDir: tempDir(), deps });
}

const T1 = { id: "T1", tags: ["backend"], likely_files: ["src/App.tsx"] } as unknown as TicketV1;

test("R18: a tag recorded by someone else between rafi's look and its write is added once", async () => {
  const e = await engine();
  const real = e.append.bind(e);
  let raced = false;
  const racing: Engine = { ...e, append: async (events, o) => {
    if (!raced) {
      raced = true;
      // Another writer records `ui` for T1 first (your edit, "set by you"), after rafi computed its additions.
      await real([{ type: "ticket.tags_added", ticket_id: "T1", actor: "user", data: { tags: [{ tag: "ui",
        reason: "set by you" }] } }]);
    }
    return real(events, o);
  } };
  const lines: string[] = [];
  const added = await addTags(racing, "run-1", T1, T1.likely_files, { patterns, why: "likely",
    line: (t) => lines.push(t) });
  assert.deepEqual(added, [], "the retry found ui already there");
  const all: string[] = [];
  for await (const ev of e.events()) if (ev.type === "ticket.tags_added") all.push(JSON.stringify(ev.data));
  assert.deepEqual(all, [JSON.stringify({ tags: [{ tag: "ui", reason: "set by you" }] })], "ui recorded once");
  assert.deepEqual([...await ticketTags(e, T1)].sort(), ["backend", "ui"]);
  assert.deepEqual(lines, []);
  e.close();
});
