import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  compactTerminalText,
  createFixedPromptResponder,
  createTicketPlanResponder,
  findUnsupportedPrompt,
  has,
  runTtyJourney,
} from "../../../scripts/live-interview-harness.mjs";

const submit = "◇ submitted\n";
const activeText = (question) => `◆ ${question}\n│ Recommended answer█`;

function ticketResponder(maxQuestionsPerPhase = 6) {
  return createTicketPlanResponder({
    maxQuestionsPerPhase,
    setupSteps: [
      { prompt: "discover", keys: "discover\r" },
      { prompt: "brief", keys: "brief\r" },
    ],
    standardAnswer: "standard answer",
    revision: "upgrade to grill-me",
    grilledAnswer: "grilled answer",
  });
}

function feed(responder, value) {
  return responder.handle(value);
}

test("terminal compaction tolerates ANSI, punctuation, and fragmented script output", () => {
  assert.equal(compactTerminalText("\u001B[32mReview this\r\n exact-plan\u001B[0m"), "reviewthisexactplan");
  assert.deepEqual(findUnsupportedPrompt("Claude is not ready. What should Rafi do?"), [
    "isnotreadywhatshouldrafido",
    "an authenticated runtime is not ready",
  ]);
});

test("fixed responder advances once per submitted Clack prompt", () => {
  const responder = createFixedPromptResponder([
    { prompt: "First prompt", keys: "one\r" },
    { prompt: "Second prompt", keys: "two\r" },
  ]);
  assert.deepEqual(feed(responder, "◆ First "), []);
  assert.deepEqual(feed(responder, "prompt"), ["one\r"]);
  assert.deepEqual(feed(responder, "◆ First prompt again"), []);
  assert.deepEqual(feed(responder, `${submit}◆ Second prompt`), ["two\r"]);
  responder.assertComplete();
});

test("ticket-plan responder enforces standard, revision, grilled, approval, and start phases", () => {
  const responder = ticketResponder();
  assert.deepEqual(feed(responder, "◆ dis"), []);
  assert.deepEqual(feed(responder, "cover"), ["discover\r"]);
  assert.deepEqual(feed(responder, `${submit}◆ brief`), ["brief\r"]);

  assert.deepEqual(feed(responder, `${submit}${activeText("Who may use links?")}`), ["\u0015standard answer\r"]);
  assert.deepEqual(feed(responder, activeText("duplicate redraw")), []);
  assert.deepEqual(feed(responder, `${submit}◆ Review this exact plan and ticket set:`), ["\u001B[B\r"]);
  assert.deepEqual(feed(responder, `${submit}◆ What should change?█`), ["\u0015upgrade to grill-me\r"]);
  assert.deepEqual(feed(responder, `${submit}${activeText("How should expiry work?")}`), ["\u0015grilled answer\r"]);
  assert.deepEqual(feed(responder, `${submit}◆ Review this exact plan and ticket set:`), ["\r"]);
  assert.deepEqual(feed(responder, `${submit}◆ Start the agreed next ticket or delivery group now?`), ["\r"]);
  responder.assertComplete();
  assert.deepEqual(responder.snapshot(), {
    phase: "done",
    setupIndex: 2,
    standardQuestions: 1,
    grilledQuestions: 1,
    reviews: 2,
  });
});

test("ticket-plan responder rejects missing interview questions and phase overflow", () => {
  const missing = ticketResponder();
  feed(missing, "discover");
  feed(missing, `${submit}brief`);
  assert.throws(() => feed(missing, `${submit}Review this exact plan and ticket set:`), /without a standard interview question/);

  const capped = ticketResponder(1);
  feed(capped, "discover");
  feed(capped, `${submit}brief`);
  feed(capped, `${submit}${activeText("one")}`);
  assert.throws(() => feed(capped, `${submit}${activeText("two")}`), /exceeded 1 questions/);
  assert.throws(() => capped.assertComplete(), /ended during standard/);
});

const ttyAvailable = process.platform === "linux" && has("script");

test("TTY runner reports a premature successful exit as an incomplete journey", { skip: !ttyAvailable }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-live-harness-test-"));
  try {
    await assert.rejects(runTtyJourney({
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.exit(0)")}`,
      cwd: resolve(dir),
      transcript: join(dir, "premature.typescript"),
      responder: createFixedPromptResponder([{ prompt: "never appears", keys: "\r" }]),
      timeoutMs: 2_000,
      echoOutput: false,
    }), /ended before expected prompt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TTY runner enforces its configured timeout", { skip: !ttyAvailable }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "rafi-live-harness-timeout-"));
  try {
    await assert.rejects(runTtyJourney({
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`,
      cwd: resolve(dir),
      transcript: join(dir, "timeout.typescript"),
      responder: createFixedPromptResponder([]),
      timeoutMs: 50,
      echoOutput: false,
    }), /exceeded the .* minute timeout/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
