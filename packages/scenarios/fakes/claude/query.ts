// The in-process Claude: an injected Agent SDK `query` driven by the script engine, beneath the real adapter
// (model: ai-foreman/test/qaGuidanceDelivery.test.ts:90-101). It reuses the fake `claude` executable's message
// builder and plays the SDK's side of the control protocol: initialize, hooks, canUseTool and interrupt.
import type { ClaudeQuery } from "@rafi-ai/engine";
import { FakeClaude } from "../claude-cli.mjs";
import type { Behavior, MetaLike } from "../script/engine.js";

export const META_KEY = Symbol.for("rafi.turn-meta");

/** The fake `claude` rule format for a behavior (shared with the PATH shims' scripts). */
export function claudeRule(b: Behavior): Record<string, unknown> {
  const behavior = b.hang ? "hang" : b.crash ? "crash" : b.error ? "error" : "reply";
  return { behavior, message: b.error, bash: b.bash, activity: b.activity, reply: b.reply, raw: b.raw };
}

type Hook = (input: Record<string, unknown>) => Promise<unknown>;
type CanUse = (tool: string, input: Record<string, unknown>, o: unknown) => Promise<{ behavior: string;
  message?: string }>;

export function claudeQuery(next: (meta: MetaLike) => Behavior, record: { metas: unknown[]; wire: unknown[] } =
  { metas: [], wire: [] }): ClaudeQuery {
  return ({ prompt, options }) => {
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
      nextRule: (message: Record<string, unknown>) => claudeRule(next((message as never)[META_KEY] ?? {})),
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
      async interrupt() {
        fake.onMessage({ type: "control_request", request_id: "interrupt", request: { subtype: "interrupt" } });
      },
    };
  };
}
