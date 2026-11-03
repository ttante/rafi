// M1 security (ARCH 1.2): secrets redacted on every write; imported events never folded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { append } from "../src/log/append.js";
import { getBlob, putBlob } from "../src/log/blobs.js";
import { escapeControl, redactor } from "../src/log/redact.js";
import { readEvents } from "../src/log/read.js";
import { decide } from "../src/state/decide.js";
import { fold, type FoldEvent } from "../src/state/fold.js";
import { standard } from "../src/workflow/standard.js";
import { testLog } from "./helpers.js";

const SECRETS = [
  "sk-ant-api03-abcdefghijklmnop1234", "sk-proj-ABCDEFGHIJKLMNOPQRST", "ghp_abcdefghijklmnopqrstuvwxyz0123",
  "github_pat_11ABCDEFG0123456789_abcdefghij", "glpat-abcdefghijklmnop1234", "xoxb-1234567890-abcdefghij",
  "AKIAABCDEFGHIJKLMNOP", "api_key=hunter2hunter2", "token: abc123secretvalue", "password=correct-horse",
  "secret='x9y8z7w6'", "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
  "https://user:pa55word@example.com/repo.git",
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
  "uses env value zq-ENV-SECRET-4242",
];
const LEAKS = [/abcdefghijklmnop1234/, /ABCDEFGHIJKLMNOPQRST/, /ghp_/, /github_pat_/, /glpat-/, /xoxb-/,
  /AKIAABCDEFGHIJKLMNOP/, /hunter2/, /abc123secretvalue/, /correct-horse/, /x9y8z7w6/, /eyJhbGci/, /pa55word/,
  /MIIEowIBAAKCAQEA/, /zq-ENV-SECRET-4242/];
const env = { STRIPE_API_KEY: "zq-ENV-SECRET-4242", PATH: "/usr/bin" };

test("redact() removes every covered secret form and names env secrets", () => {
  const r = redactor(env);
  for (const secret of SECRETS) {
    const out = r.text(`before ${secret} after`);
    for (const leak of LEAKS) assert.doesNotMatch(out, leak, `${secret} → ${out}`);
    assert.match(out, /^before /);
  }
  assert.match(r.text("zq-ENV-SECRET-4242"), /\[REDACTED:STRIPE_API_KEY\]/);
  assert.equal(r.text("/usr/bin is a path"), "/usr/bin is a path", "short or non-secret env values stay");
});

test("redacted on every write: one string field per event group, nested objects and arrays", async () => {
  const { ctx, log } = await testLog();
  const r = redactor(env);
  const c = { ...ctx, redact: r };
  const s = SECRETS.join(" | ");
  await append(c, [
    { type: "plan.rejected", actor: "user", data: { feedback: s } },
    { type: "build.failed", run_id: "r1", actor: "engine", data: { error: "bug", message: s } },
    { type: "step.failed", ticket_id: "T1", actor: "engine", data: { category: "c", reason: s, circling: false } },
    { type: "turn.activity", ticket_id: "T1", actor: "agent:builder", data: { key: "k", kind: "text", text: s } },
    { type: "builder.reported", ticket_id: "T1", actor: "agent:builder", data: { kind: "blocked", summary: null,
      runs: [], block: { type: "credential", need: null, reason: s }, question: null } },
    { type: "verdict.recorded", ticket_id: "T1", actor: "agent:qa", data: { attempt: 1, results: [{ req: 1,
      status: "unable", runs: [], needs: "other", note: s }], rejected: false, unverified: [], signature: "s",
      circling: false } },
    { type: "ticket.blocked", ticket_id: "T1", actor: "engine", data: { kind: "other", reason: s, question: null,
      waits: [s] } },
    { type: "question.answered", actor: "user", source: "terminal", data: { id: "q1", choice: null, text: s,
      note: s, save: "none" } },
    { type: "notify.sent", actor: "engine", data: { question: null, event: s, channel: "c", shown: [s], more: false,
      outcome: "ok" } },
  ]);
  const raw = JSON.stringify(log.db.prepare("SELECT data FROM events").all());
  for (const leak of LEAKS) assert.doesNotMatch(raw, leak);
  const read = JSON.stringify(readEvents(log.db).events);
  for (const leak of LEAKS) assert.doesNotMatch(read, leak, "a stats-style read returns no secret");
  const blob = await putBlob(log, r, s, { sensitive: true });
  for (const leak of LEAKS) assert.doesNotMatch(getBlob(log, blob.digest)!.data, leak);
});

test("identity fields aren't redacted", () => {
  const out = redactor(env).value({ key: "token=abcdef123456", path: "docs/token=abc123456.md", note: "token=abcdef123456" });
  assert.equal(out.key, "token=abcdef123456");
  assert.equal(out.path, "docs/token=abc123456.md");
  assert.equal(out.note, "token=[REDACTED]");
});

test("escapeControl() escapes terminal control characters", () => {
  assert.equal(escapeControl("a\u001b]0;evil\u0007b\nc\td\u009b"), "a\\u001b]0;evil\\u0007b\nc\td\\u009b");
});

test("imported events are never folded: fold and decide agree with or without them", () => {
  const ctx = { workflows: [standard], definitions: [{ id: "T1", dependsOn: [] }] };
  const base: FoldEvent[] = [
    { type: "project.created", data: { app_name: "a", rafi_version: "1" }, seq: 1 },
    { type: "tickets.populated", data: { plan_rev: 1, added: ["T1"], retired: [], group: null }, seq: 2 },
    { type: "build.started", run_id: "r1", seq: 3, data: { workflow: { id: "standard", version: 1, digest: "d" },
      scope: { kind: "all", value: null, skip: [] }, tickets: ["T1"], settings: {}, engine_version: "1", argv: [] } },
  ];
  const imported: FoldEvent[] = [
    { type: "ticket.status_set", ticket_id: "T1", origin: "imported", seq: 4, data: { status: "done",
      summary: null, validation: null, evidence: "e", by: "user" } },
    { type: "build.stop_requested", run_id: "r1", origin: "imported", seq: 5, data: { mode: "now", source: "gui" } },
  ];
  const live = { safePoint: true, stepInFlight: false };
  assert.deepEqual(fold([...base, ...imported], ctx), fold(base, ctx));
  assert.deepEqual(decide(fold([...base, ...imported], ctx), live), decide(fold(base, ctx), live));
});
