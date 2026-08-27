import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  compactTerminalText,
  createFixedPromptResponder,
  createCreateGrillMeResponder,
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

function createResponder() {
  return createCreateGrillMeResponder({
    maxQuestions: 6,
    stopAnswer: "Stop questions and make the plan now",
    setupSteps: [
      { prompt: "App name", keys: "app\r" },
      { prompt: "Planning brief", keys: "plan everything\r" },
    ],
    ticketSetupSteps: [
      { prompt: "Run `rafi tickets setup:init` now", keys: "\r" },
      { prompt: "Run ticket population now", keys: "\r" },
    ],
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
  assert.deepEqual(feed(responder, `${submit}${activeText("How should expiry work?")}\nAlternative\nStop questions and make the plan now`), ["\u0015grilled answer\r"]);
  assert.deepEqual(feed(responder, `${submit}◆ Review this exact plan and ticket set:`), ["\r"]);
  assert.deepEqual(feed(responder, `${submit}◆ Start the agreed next ticket or delivery group now?`), ["\r"]);
  responder.assertComplete();
  assert.deepEqual(responder.snapshot(), {
    phase: "done",
    setupIndex: 2,
    standardQuestions: 1,
    grilledQuestions: 1,
    auditCompleted: false,
    reviews: 2,
  });
});

test("ticket-plan responder answers inline textual grill choices without a rendered cursor", () => {
  const responder = ticketResponder();
  feed(responder, "discover");
  feed(responder, `${submit}brief`);
  feed(responder, `${submit}Review this exact plan and ticket set:`);
  feed(responder, `${submit}◆ What should change?█`);

  assert.deepEqual(
    feed(responder, `${submit}│\n●  Choices: Choice (Recommended) | Alternative | Stop questions and make the plan now\n`),
    [],
  );
  assert.deepEqual(
    feed(responder, `◆ Which policy?\n│  Choice (Recommended) | Alternative | Stop questions and make the plan now\n└`),
    ["\u0015grilled answer\r"],
  );
  assert.equal(responder.snapshot().grilledQuestions, 1);
});

test("ticket-plan responder waits for and answers an active inline standard prompt", () => {
  const responder = ticketResponder();
  feed(responder, "discover");
  feed(responder, `${submit}brief`);

  assert.deepEqual(
    feed(responder, `${submit}● Choices: Choice (Recommended) | Alternative\n`),
    [],
  );
  assert.deepEqual(
    feed(responder, "◆ Which policy?\n│ Choice (Recommended) | Alternative\n└"),
    ["\u0015standard answer\r"],
  );
  assert.equal(responder.snapshot().standardQuestions, 1);
});

test("ticket-plan responder accepts the recommended native standard answer", () => {
  const responder = ticketResponder();
  feed(responder, "discover");
  feed(responder, `${submit}brief`);

  assert.deepEqual(
    feed(responder, `${submit}◆ Link access\n│ ● Anyone with the link (Recommended)\n│ ○ Signed-in users\n│ ○ Custom response\n└`),
    ["\r"],
  );
  assert.equal(responder.snapshot().standardQuestions, 1);
});

test("ticket-plan responder allows zero standard questions but rejects exhaustive approval without an answer or audit", () => {
  const missing = ticketResponder();
  feed(missing, "discover");
  feed(missing, `${submit}brief`);
  assert.deepEqual(feed(missing, `${submit}Review this exact plan and ticket set:`), ["\u001B[B\r"]);
  assert.deepEqual(feed(missing, `${submit}◆ What should change?█`), ["\u0015upgrade to grill-me\r"]);
  assert.throws(() => feed(missing, `${submit}Review this exact plan and ticket set:`), /without a valid grill-me answer or completed independent audit/);

  const capped = ticketResponder(1);
  feed(capped, "discover");
  feed(capped, `${submit}brief`);
  feed(capped, `${submit}${activeText("one")}`);
  assert.throws(() => feed(capped, `${submit}${activeText("two")}`), /exceeded 1 questions/);
  assert.throws(() => capped.assertComplete(), /ended during standard/);
});

test("create grill-me responder accepts one valid stop answer before approval", () => {
  const responder = createResponder();
  assert.deepEqual(feed(responder, "◆ App name"), ["app\r"]);
  assert.deepEqual(feed(responder, `${submit}◆ Planning brief`), ["plan everything\r"]);

  assert.deepEqual(feed(responder, `${submit}${activeText("Which import policy?")}\nAlternative\nStop questions and make the plan now`), ["\u0015Stop questions and make the plan now\r"]);
  assert.deepEqual(feed(responder, activeText("duplicate redraw")), []);
  assert.deepEqual(feed(responder, `${submit}◆ Approve this structured plan?`), ["\r"]);
  assert.deepEqual(feed(responder, `${submit}◆ Run \`rafi tickets setup:init\` now`), ["\r"]);
  assert.deepEqual(feed(responder, `${submit}◆ Run ticket population now`), ["\r"]);

  responder.assertComplete();
  assert.deepEqual(responder.snapshot(), {
    phase: "done",
    setupIndex: 2,
    ticketSetupIndex: 2,
    grillQuestions: 1,
    validGrillAnswers: 1,
    auditCompleted: false,
    stopSelected: true,
    planApprovals: 1,
  });
});

test("create grill-me responder supports native select questions and rejects early approval", () => {
  const responder = createResponder();
  feed(responder, "App name");
  feed(responder, `${submit}Planning brief`);
  assert.deepEqual(feed(responder, `${submit}◆ Grill-me: Native question\n│  ● Choice (Recommended)\n│  ○ Alternative\n│  ○ Stop questions and make the plan now\n│  ○ Custom response`), ["\u001B[B\u001B[B\r"]);

  const early = createResponder();
  feed(early, "App name");
  feed(early, `${submit}Planning brief`);
  assert.throws(() => feed(early, `${submit}◆ Approve this structured plan?`), /without a valid grill-me answer or completed independent audit/);
});

test("create grill-me responder supports inline textual choices", () => {
  const responder = createResponder();
  feed(responder, "App name");
  feed(responder, `${submit}Planning brief`);
  assert.deepEqual(
    feed(responder, `${submit}│\n●  Choices: Choice (Recommended) | Alternative | Stop questions and make the plan now\n◆ Which policy?\n│  Choice (Recommended) | Alternative | Stop questions and make the plan now\n└`),
    ["\u0015Stop questions and make the plan now\r"],
  );
  assert.deepEqual(feed(responder, `${submit}◆ Approve this structured plan?`), ["\r"]);
});

test("create grill-me responder permits approval after a completed independent audit with zero questions", () => {
  const responder = createResponder();
  feed(responder, "App name");
  feed(responder, `${submit}Planning brief`);
  assert.deepEqual(feed(responder, `${submit}rafi plan: independent verification found no missing user decisions`), []);
  assert.deepEqual(feed(responder, "◆ Approve this structured plan?"), ["\r"]);
  feed(responder, `${submit}◆ Run \`rafi tickets setup:init\` now`);
  feed(responder, `${submit}◆ Run ticket population now`);
  responder.assertComplete();
  assert.equal(responder.snapshot().grillQuestions, 0);
  assert.equal(responder.snapshot().auditCompleted, true);
});

test("create grill-me responder rejects a new active question after early stop", () => {
  const responder = createResponder();
  feed(responder, "App name");
  feed(responder, `${submit}Planning brief`);
  feed(responder, `${submit}${activeText("Which import policy?")}\nAlternative\nStop questions and make the plan now`);
  assert.deepEqual(feed(responder, "◇ Any more questions?\n│ Stop questions and make the plan now"), []);
  assert.throws(
    () => feed(responder, `${submit}${activeText("One unexpected follow-up?")}`),
    /another planner question after selecting early stop/,
  );
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
