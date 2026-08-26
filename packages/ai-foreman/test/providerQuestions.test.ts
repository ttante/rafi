import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config.js";
import { createPermissionHandler } from "../src/foreman.js";
import { PermissionPolicy } from "../src/permissions/policy.js";
import {
  handleProviderQuestionTool,
  type ProviderQuestionPromptDeps,
} from "../src/providerQuestions.js";

const CANCEL = Symbol("cancel");

function promptDeps(answers: {
  select?: Array<string | symbol>;
  multiselect?: Array<string[] | symbol>;
  text?: Array<string | symbol>;
}): ProviderQuestionPromptDeps {
  return {
    select: async () => answers.select?.shift() ?? "0",
    multiselect: async () => answers.multiselect?.shift() ?? ["0"],
    text: async () => answers.text?.shift() ?? "",
    isCancel: (value: unknown): value is symbol => value === CANCEL,
  } as ProviderQuestionPromptDeps;
}

function askInput(questions: unknown[]): Record<string, unknown> {
  return { questions };
}

test("AskUserQuestion single-select returns updatedInput answers keyed by question text", async () => {
  const decision = await handleProviderQuestionTool({
    toolName: "AskUserQuestion",
    input: askInput([{
      question: "Which date library should we use?",
      header: "Library",
      multiSelect: false,
      options: [
        { label: "Temporal", description: "Use the platform API.", preview: "Temporal.Now" },
        { label: "Luxon", description: "Use the existing dependency." },
      ],
    }]),
  }, {
    interactive: true,
    prompts: promptDeps({ select: ["1"] }),
  });

  assert.equal(decision?.behavior, "allow");
  assert.deepEqual(decision?.updatedInput?.answers, {
    "Which date library should we use?": "Luxon",
  });
});

test("AskUserQuestion custom response records free text as the answer and annotation notes", async () => {
  const decision = await handleProviderQuestionTool({
    toolName: "AskUserQuestion",
    input: askInput([{
      question: "How should setup behave?",
      header: "Setup",
      multiSelect: false,
      options: [
        { label: "Strict", description: "Fail fast." },
        { label: "Repair", description: "Try a repair." },
      ],
    }]),
  }, {
    interactive: true,
    prompts: promptDeps({ select: ["__rafi_custom_response__"], text: ["Prompt once, then repair"] }),
  });

  assert.equal(decision?.behavior, "allow");
  assert.deepEqual(decision?.updatedInput?.answers, {
    "How should setup behave?": "Prompt once, then repair",
  });
  assert.deepEqual(decision?.updatedInput?.annotations, {
    "How should setup behave?": { notes: "Prompt once, then repair" },
  });
});

test("AskUserQuestion multi-select supports selected options plus a custom response", async () => {
  const decision = await handleProviderQuestionTool({
    toolName: "AskUserQuestion",
    input: askInput([{
      question: "Which checks should run?",
      header: "Checks",
      multiSelect: true,
      options: [
        { label: "Unit tests", description: "Fast tests.", preview: "pnpm test" },
        { label: "Typecheck", description: "Compiler check.", preview: "pnpm typecheck" },
      ],
    }]),
  }, {
    interactive: true,
    prompts: promptDeps({
      multiselect: [["0", "__rafi_custom_response__"]],
      text: ["Smoke test"],
    }),
  });

  assert.equal(decision?.behavior, "allow");
  assert.deepEqual(decision?.updatedInput?.answers, {
    "Which checks should run?": "Unit tests, Smoke test",
  });
  assert.deepEqual(decision?.updatedInput?.annotations, {
    "Which checks should run?": { preview: "pnpm test", notes: "Smoke test" },
  });
});

test("AskUserQuestion handles provider batches larger than the documented schema limit", async () => {
  const questions = Array.from({ length: 5 }, (_, index) => ({
    question: `Question ${index + 1}?`,
    header: `Q${index + 1}`,
    multiSelect: false,
    options: [
      { label: "Yes", description: "Accept." },
      { label: "No", description: "Reject." },
    ],
  }));

  const decision = await handleProviderQuestionTool({
    toolName: "AskUserQuestion",
    input: askInput(questions),
  }, {
    interactive: true,
    prompts: promptDeps({ select: ["0", "1", "0", "1", "0"] }),
  });

  assert.equal(decision?.behavior, "allow");
  assert.deepEqual(decision?.updatedInput?.answers, {
    "Question 1?": "Yes",
    "Question 2?": "No",
    "Question 3?": "Yes",
    "Question 4?": "No",
    "Question 5?": "Yes",
  });
});

test("AskUserQuestion denies with interrupt when interactive input is unavailable or cancelled", async () => {
  const input = askInput([{
    question: "Continue?",
    header: "Continue",
    multiSelect: false,
    options: [
      { label: "Yes", description: "Continue." },
      { label: "No", description: "Stop." },
    ],
  }]);

  const noninteractive = await handleProviderQuestionTool({
    toolName: "AskUserQuestion",
    input,
  }, { interactive: false });
  assert.deepEqual(noninteractive, {
    behavior: "deny",
    interrupt: true,
    message: "AskUserQuestion requires interactive input, but this Rafi run is non-interactive.",
  });

  const cancelled = await handleProviderQuestionTool({
    toolName: "AskUserQuestion",
    input,
  }, {
    interactive: true,
    prompts: promptDeps({ select: [CANCEL] }),
  });
  assert.deepEqual(cancelled, {
    behavior: "deny",
    interrupt: true,
    message: "User cancelled the provider question prompt.",
  });
});

test("permission handler routes AskUserQuestion before unknown-tool policy escalation", async () => {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const policy = new PermissionPolicy(DEFAULT_CONFIG.permissions, "/tmp/project");
  const handler = createPermissionHandler(policy, {
    write: (event: string, data: Record<string, unknown>) => events.push({ event, data }),
  } as never, { interactive: false });

  const decision = await handler({
    toolName: "AskUserQuestion",
    input: askInput([{ question: "Continue?", options: [], multiSelect: false }]),
  });

  assert.equal(decision.behavior, "deny");
  assert.equal(decision.interrupt, true);
  assert.deepEqual(events.map((event) => event.event), ["permission"]);
  assert.equal(events[0]?.data.reason, "provider question prompt");
});
