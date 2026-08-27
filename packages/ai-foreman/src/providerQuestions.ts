import { isCancel, multiselect, select, text } from "@clack/prompts";
import type { PermissionDecision, PermissionRequest } from "./adapters/types.js";

const ASK_USER_QUESTION_TOOL = "AskUserQuestion";
const CUSTOM_VALUE = "__rafi_custom_response__";

export interface PromptOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface ProviderQuestion {
  question: string;
  header?: string;
  options: PromptOption[];
  multiSelect: boolean;
}

export interface ProviderQuestionPromptDeps {
  select: typeof select;
  multiselect: typeof multiselect;
  text: typeof text;
  isCancel: typeof isCancel;
}

export interface ProviderQuestionOptions {
  interactive: boolean;
  prompts?: ProviderQuestionPromptDeps;
  /** Called only after a non-empty answer has been successfully collected. */
  onAnsweredQuestion?: (event: AnsweredProviderQuestion) => void;
}

export interface AnsweredProviderQuestion {
  toolName: "AskUserQuestion";
  question: ProviderQuestion;
  /** Number of readable questions presented by this provider tool call. */
  questionCount: number;
  answer: string;
}

export const GRILL_ME_STOP_CHOICE = "Stop questions and make the plan now";

export async function handleProviderQuestionTool(
  req: PermissionRequest,
  opts: ProviderQuestionOptions,
): Promise<PermissionDecision | undefined> {
  if (req.toolName !== ASK_USER_QUESTION_TOOL) return undefined;
  if (!opts.interactive) {
    return {
      behavior: "deny",
      interrupt: true,
      message: "AskUserQuestion requires interactive input, but this Rafi run is non-interactive.",
    };
  }

  const questions = parseQuestions(req.input);
  if (questions.length === 0) {
    return {
      behavior: "deny",
      interrupt: true,
      message: "AskUserQuestion did not include any readable questions.",
    };
  }

  const prompts = opts.prompts ?? { select, multiselect, text, isCancel };
  const answers = recordFromUnknown(req.input.answers);
  const annotations = annotationRecordFromUnknown(req.input.annotations);

  for (const question of questions) {
    const answered = await askOneQuestion(question, prompts, req.signal);
    if (answered.cancelled) {
      return {
        behavior: "deny",
        interrupt: true,
        message: "User cancelled the provider question prompt.",
      };
    }
    answers[question.question] = answered.answer;
    if (answered.annotation) annotations[question.question] = answered.annotation;
    if (answered.answer.trim()) {
      opts.onAnsweredQuestion?.({
        toolName: ASK_USER_QUESTION_TOOL,
        question,
        questionCount: questions.length,
        answer: answered.answer,
      });
    }
  }

  const updatedInput: Record<string, unknown> = {
    ...req.input,
    answers,
  };
  if (Object.keys(annotations).length > 0) updatedInput.annotations = annotations;

  return { behavior: "allow", updatedInput };
}

/** Machine-recognizable native grill-me question shape. */
export function isGrillMeProviderQuestion(event: AnsweredProviderQuestion): boolean {
  const { question } = event;
  if (event.questionCount !== 1 || question.multiSelect) return false;
  if (!/^grill-me\b/i.test(question.header ?? "")) return false;
  const labels = question.options.map((option) => option.label.trim());
  if (labels.length < 3 || !labels[0]?.endsWith("(Recommended)")) return false;
  const stopIndex = labels.indexOf(GRILL_ME_STOP_CHOICE);
  if (stopIndex < 0) return false;
  return labels.some((label, index) => index > 0 && index !== stopIndex && label.length > 0);
}

export function countProviderQuestions(input: Record<string, unknown>): number {
  const questions = input.questions;
  return Array.isArray(questions) ? questions.length : 0;
}

function parseQuestions(input: Record<string, unknown>): ProviderQuestion[] {
  const rawQuestions = input.questions;
  if (!Array.isArray(rawQuestions)) return [];
  return rawQuestions.flatMap((raw): ProviderQuestion[] => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const record = raw as Record<string, unknown>;
    const question = typeof record.question === "string" ? record.question.trim() : "";
    if (!question) return [];
    const header = typeof record.header === "string" && record.header.trim()
      ? record.header.trim()
      : undefined;
    const options = Array.isArray(record.options)
      ? record.options.flatMap((option): PromptOption[] => {
          if (!option || typeof option !== "object" || Array.isArray(option)) return [];
          const optionRecord = option as Record<string, unknown>;
          const label = typeof optionRecord.label === "string" ? optionRecord.label.trim() : "";
          if (!label) return [];
          return [{
            label,
            description: typeof optionRecord.description === "string" ? optionRecord.description : undefined,
            preview: typeof optionRecord.preview === "string" ? optionRecord.preview : undefined,
          }];
        })
      : [];
    return [{ question, header, options, multiSelect: record.multiSelect === true }];
  });
}

async function askOneQuestion(
  question: ProviderQuestion,
  prompts: ProviderQuestionPromptDeps,
  signal?: AbortSignal,
): Promise<{
  cancelled: boolean;
  answer: string;
  annotation?: { preview?: string; notes?: string };
}> {
  const message = question.header ? `${question.header}: ${question.question}` : question.question;
  if (question.options.length === 0) {
    const answer = await prompts.text({ message, signal });
    if (prompts.isCancel(answer)) return { cancelled: true, answer: "" };
    return { cancelled: false, answer: String(answer) };
  }

  if (question.multiSelect) {
    const selected = await prompts.multiselect<string>({
      message,
      options: [
        ...question.options.map((option, index) => ({
          value: String(index),
          label: option.label,
          hint: option.description,
        })),
        { value: CUSTOM_VALUE, label: "Custom response", hint: "Type a different answer" },
      ],
      required: true,
      signal,
    });
    if (prompts.isCancel(selected)) return { cancelled: true, answer: "" };
    const selectedValues = selected as string[];
    const labels = selectedValues
      .filter((value) => value !== CUSTOM_VALUE)
      .map((value) => question.options[Number(value)]?.label)
      .filter((value): value is string => Boolean(value));
    const previews = selectedValues
      .filter((value) => value !== CUSTOM_VALUE)
      .map((value) => question.options[Number(value)]?.preview)
      .filter((value): value is string => Boolean(value));
    let notes: string | undefined;
    if (selectedValues.includes(CUSTOM_VALUE)) {
      const custom = await prompts.text({ message: "Custom response:", signal });
      if (prompts.isCancel(custom)) return { cancelled: true, answer: "" };
      notes = String(custom);
      labels.push(notes);
    }
    return {
      cancelled: false,
      answer: labels.join(", "),
      annotation: annotationFor(previews, notes),
    };
  }

  const selected = await prompts.select<string>({
    message,
    options: [
      ...question.options.map((option, index) => ({
        value: String(index),
        label: option.label,
        hint: option.description,
      })),
      { value: CUSTOM_VALUE, label: "Custom response", hint: "Type a different answer" },
    ],
    signal,
  });
  if (prompts.isCancel(selected)) return { cancelled: true, answer: "" };
  if (selected === CUSTOM_VALUE) {
    const custom = await prompts.text({ message: "Custom response:", signal });
    if (prompts.isCancel(custom)) return { cancelled: true, answer: "" };
    const answer = String(custom);
    return { cancelled: false, answer, annotation: { notes: answer } };
  }
  const option = question.options[Number(selected)];
  return {
    cancelled: false,
    answer: option?.label ?? String(selected),
    annotation: annotationFor(option?.preview ? [option.preview] : [], undefined),
  };
}

function annotationFor(previews: string[], notes: string | undefined): { preview?: string; notes?: string } | undefined {
  const annotation: { preview?: string; notes?: string } = {};
  if (previews.length > 0) annotation.preview = previews.join("\n\n");
  if (notes) annotation.notes = notes;
  return Object.keys(annotation).length > 0 ? annotation : undefined;
}

function recordFromUnknown(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") result[key] = entry;
  }
  return result;
}

function annotationRecordFromUnknown(value: unknown): Record<string, { preview?: string; notes?: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, { preview?: string; notes?: string }> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const annotation: { preview?: string; notes?: string } = {};
    if (typeof record.preview === "string") annotation.preview = record.preview;
    if (typeof record.notes === "string") annotation.notes = record.notes;
    if (Object.keys(annotation).length > 0) result[key] = annotation;
  }
  return result;
}
