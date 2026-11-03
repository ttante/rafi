// The in-process Claude: an injected Agent SDK `query` driven by the script engine, beneath the real adapter
// (model: ai-foreman/test/qaGuidanceDelivery.test.ts:90-101). It reuses the fake `claude` executable's message
// builder and plays the SDK's side of the control protocol: initialize, hooks, canUseTool and interrupt.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ClaudeQuery } from "@rafi-ai/engine";
import { FakeClaude } from "../claude-cli.mjs";
import type { Behavior, MetaLike } from "../script/engine.js";

export const META_KEY = Symbol.for("rafi.turn-meta");

/** The fake `claude` rule format for a behavior (shared with the PATH shims' scripts). */
export function claudeRule(b: Behavior): Record<string, unknown> {
  const behavior = b.hang ? "hang" : b.crash ? "crash" : b.error ? "error" : "reply";
  return { ...b, behavior, message: b.error };
}

type Hook = (input: Record<string, unknown>) => Promise<unknown>;
type CanUse = (tool: string, input: Record<string, unknown>, o: unknown) => Promise<{ behavior: string;
  message?: string }>;

type CallTool = (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;

function textOf(message: Record<string, unknown>): string {
  const content = (message.message as { content?: unknown } | undefined)?.content;
  return typeof content === "string" ? content : JSON.stringify(content ?? "");
}

type Next = (meta: MetaLike, ctx: { cwd: string; message: string }) => Behavior;

const READS: ReadonlySet<string> = new Set(["Read", "Glob", "Grep", "LS"]);

/**
 * The tools Claude Code allows without asking canUseTool: reads; Bash when the sandbox is on and
 * `autoAllowBashIfSandboxed` isn't false (its default is true); and the tools the loaded project settings
 * (`.claude/settings.json` `permissions.allow`, when `settingSources` has "project") allow.
 */
function autoAllowed(options: Record<string, unknown>): (tool: string) => boolean {
  const sandbox = options.sandbox as { enabled?: boolean; autoAllowBashIfSandboxed?: boolean } | undefined;
  const rules = new Set<string>();
  if ((options.settingSources as string[] | undefined)?.includes("project")) {
    try {
      const file = path.join(String(options.cwd ?? "."), ".claude", "settings.json");
      const settings = JSON.parse(readFileSync(file, "utf8")) as { permissions?: { allow?: string[] } };
      for (const rule of settings.permissions?.allow ?? []) rules.add(rule.split("(")[0]!);
    } catch { /* no project settings */ }
  }
  return (tool) => READS.has(tool) || rules.has(tool) ||
    (tool === "Bash" && sandbox?.enabled === true && sandbox.autoAllowBashIfSandboxed !== false);
}

export function claudeQuery(next: Next, record: { metas: unknown[]; wire: unknown[] } =
  { metas: [], wire: [] }): ClaudeQuery {
  return ({ prompt, options }) => {
    // SDK 0.3.159's query() has no `appendSystemPrompt` option and drops it silently (live check, plan 10.8).
    if ("appendSystemPrompt" in options) throw new Error("appendSystemPrompt isn't an Agent SDK option");
    const output: unknown[] = [];
    const waker: { fn: (() => void) | null } = { fn: null };
    let done = false;
    const push = (m: unknown) => { output.push(m); waker.fn?.(); };
    const hooks = new Map<string, Hook>();
    const canUseTool = options.canUseTool as CanUse | undefined;
    const io = {
      write: (message: Record<string, unknown>) => {
        if (message.type === "control_response") return;
        if (message.type !== "control_request") return push(message);
        const request = message.request as Record<string, unknown>;
        const reply = (response: unknown) => fake.onMessage({ type: "control_response",
          response: { subtype: "success", request_id: message.request_id, response } });
        // Control requests are handled in stream order, after the messages before them are read (as the SDK does).
        push(() => {
          if (request.subtype === "can_use_tool") {
            void canUseTool?.(String(request.tool_name), request.input as Record<string, unknown>, {}).then(reply);
          } else if (request.subtype === "hook_callback") {
            void (hooks.get(String(request.callback_id))?.(request.input as Record<string, unknown>) ??
              Promise.resolve({})).then(reply);
          }
        });
      },
      exit: () => { done = true; waker.fn?.(); },
      nextRule: (message: Record<string, unknown>) => claudeRule(next((message as never)[META_KEY] ?? {},
        { cwd: String(options.cwd ?? "."), message: textOf(message) })),
      callTool: (options.mcpServers as { rafi?: { call?: CallTool } } | undefined)?.rafi?.call,
      cwd: String(options.cwd ?? "."),
      sleep: options.__sleep,
      autoAllow: autoAllowed(options),
    };
    const fake = new FakeClaude({ rules: [] }, options.resume ? ["--resume", String(options.resume)] : [], io as never);
    const registered: Record<string, unknown[]> = {};
    for (const [event, matchers] of Object.entries((options.hooks ?? {}) as Record<string, { hooks: Hook[] }[]>)) {
      registered[event] = matchers.map((m, i) => ({ hookCallbackIds: m.hooks.map((h, j) => {
        const id = `hook_${event}_${i}_${j}`;
        hooks.set(id, h);
        return id;
      }) }));
    }
    fake.onMessage({ type: "control_request", request_id: "init", request: { subtype: "initialize",
      hooks: registered, jsonSchema: (options.outputFormat as { schema?: unknown } | undefined)?.schema } });
    void (async () => {
      for await (const message of prompt as AsyncIterable<Record<string | symbol, unknown>>) {
        record.metas.push(message[META_KEY]);
        const wire = JSON.parse(JSON.stringify(message));
        record.wire.push(wire);
        fake.onMessage({ ...wire, [META_KEY]: message[META_KEY] });
      }
      done = true;
      waker.fn?.();
    })();
    const abort = options.abortController as AbortController | undefined;
    abort?.signal.addEventListener("abort", () => { done = true; waker.fn?.(); });
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (output.length) {
            const item = output.shift();
            if (typeof item === "function") item();
            else yield item;
            continue;
          }
          if (done) return;
          await new Promise<void>((resolve) => { waker.fn = resolve; });
          waker.fn = null;
        }
      },
      /** The fake's model list (C52's provider source): an unlisted model is flagged before the build. */
      async supportedModels() {
        return [{ value: "default" }, { value: "claude-sonnet-4-5" }, { value: "claude-opus-4-1" }];
      },
      async interrupt() {
        fake.onMessage({ type: "control_request", request_id: "interrupt", request: { subtype: "interrupt" } });
      },
    };
  };
}
