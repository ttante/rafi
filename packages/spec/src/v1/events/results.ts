// Group D of ARCH 3.4: results of steps.
import { z } from "zod";
import { def, digest, nullableText, runNumbers, ticketId, type EventDef } from "./envelope.js";

const key = z.string().min(1);
const blockType = z.enum(["permission", "install", "service", "credential", "decision", "other"]);
const reqStatus = z.enum(["satisfied", "not-satisfied", "not-applicable", "unable"]);
const needs = z.enum(["browser", "device", "person", "service", "file", "other"]);
const checkOutcome = z.enum(["passed", "failed", "timed-out", "too-slow", "changed-code", "refused"]);

export const resultEvents: readonly EventDef[] = [
  def("requirements.written", "state", "ticket", {
    path: z.string(), fp: digest, depth: z.string(), depth_raised_from: nullableText,
    count: z.number().int().nonnegative(), person_only: runNumbers,
  }),
  def("requirements.receipt", "detail", "none", {
    key, path: z.string(), fp_supplied: digest.nullable(), fp_observed: digest.nullable(),
    status: z.enum(["delivered", "missing", "unreadable", "changed"]), read: z.boolean(),
  }),
  def("builder.reported", "state", "ticket", {
    kind: z.enum(["done", "blocked", "needs-input"]), summary: nullableText, runs: runNumbers,
    block: z.object({ type: blockType, need: nullableText, reason: z.string() }).strict().nullable(),
    question: z.object({ text: z.string(), choices: z.array(z.string()) }).strict().nullable(),
  }),
  def("check.run", "state", "ticket", {
    run: z.number().int().positive(), ticket: ticketId, command: z.string(),
    asked_by: z.enum(["builder", "qa", "rafi"]), tree: digest, exit_code: z.number().int().nullable(),
    outcome: checkOutcome,
    tests: z.array(z.object({ name: z.string(), file: nullableText, outcome: z.string() }).strict()),
    duration_ms: z.number().nonnegative(), output: digest.nullable(), changed_tracked: z.array(z.string()),
    restored: z.array(z.string()),
  }),
  def("checks.passed", "state", "ticket", { runs: runNumbers, reused: runNumbers }),
  def("checks.failed", "state", "ticket", {
    failing: z.array(z.object({ req: z.number().int().positive(), run: z.number().int().positive() }).strict()),
    signature: z.string(), circling: z.boolean(),
  }),
  def("attempt.summary", "state", "ticket", {
    attempt: z.number().int().positive(), tree: digest, files_read: z.array(z.string()), runs: runNumbers,
  }),
  def("facts.snapshot", "state", "ticket", { key, tree: digest, base: digest, files: z.array(z.string()) }),
  def("facts.mismatch", "detail", "none", { key, claim: z.string(), record: z.string() }),
  // unverified[].tool names a known, unconfigured tool that would let QA verify it (plan choice C27).
  def("verdict.recorded", "state", "ticket", {
    attempt: z.number().int().positive(),
    results: z.array(z.object({
      req: z.number().int().positive(), status: reqStatus, runs: runNumbers, needs: needs.nullable(),
      note: nullableText,
    }).strict()),
    rejected: z.boolean(),
    unverified: z.array(z.object({ req: z.number().int().positive(), tool: nullableText }).strict()),
    signature: z.string(), circling: z.boolean(),
  }),
  def("qa.isolation", "detail", "none", {
    mode: z.enum(["in-place", "copy"]), why: z.string(), files: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(), ms: z.record(z.string(), z.number()),
  }),
  def("fix.granted", "state", "ticket", { by: z.string(), reason: z.string() }),
  def("waiver.recorded", "state", "ticket", {
    kind: z.enum(["verified-myself", "waive-qa"]), note: z.string(), findings: z.array(z.string()), fp: digest,
  }),
  def("recheck.requested", "state", "ticket", { ticket: ticketId, revision: z.number().int().nonnegative() }),
  def("recheck.recorded", "state", "ticket", { passed: z.boolean(), fix_ticket: ticketId.nullable() }),
  def("suite.run", "state", "build", {
    unit: z.string(), commit: z.string(), tests: z.enum(["full", "light"]),
    outcome: z.enum(["passed", "failed", "too-slow"]), failing: z.array(z.string()),
    preexisting: z.array(z.string()), flaky: z.array(z.string()), reused: z.array(z.string()),
    duration_ms: z.number().nonnegative(),
  }),
  def("ci.result", "state", "build", {
    unit: z.string(), outcome: z.enum(["passed", "fixed", "unfixed-merged", "unfixed-pushed"]),
    fix_ticket: ticketId.nullable(), still_failing: z.array(z.string()),
  }),
];

export { blockType };
