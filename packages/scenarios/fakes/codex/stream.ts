// The in-process Codex: an in-memory JsonRpcStream driven by the script engine, beneath the real adapter.
// It reads `meta` from beside each message, as the real stream drops it (ARCH 11.6, plan choice C11).
import type { Cancel, JsonRpcStream } from "@rafi-ai/engine";
import { createCodexFake } from "./protocol.mjs";
import type { Behavior, MetaLike } from "../script/engine.js";

export interface CodexStreamLog {
  readonly wire: unknown[];
  readonly metas: unknown[];
  /** The permission profile active at each turn (null: none, or cleared by a legacy sandboxPolicy). */
  readonly active?: (string | null)[];
}

export interface CodexStreamOptions {
  /** Posts to rafi's endpoint (the harness's in-memory one). */
  readonly callMcp?: (url: string, headers: Record<string, string>, body: unknown) =>
    Promise<{ status: number; body: string }>;
  /** Called at each turn with its meta, the thread's params and turn/start's params (the transcript). */
  /** Waits on the fake clock for `wait` steps. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onTurn?: (entry: { meta: MetaLike; thread: Record<string, unknown>;
    start: Record<string, unknown> }) => void;
}

export function codexStream(next: (meta: MetaLike, ctx: { cwd: string; message: string }) => Behavior,
  record: CodexStreamLog = { wire: [], metas: [], active: [] }, o: CodexStreamOptions = {}) {
  const messageFns = new Set<(m: unknown) => void>();
  const closeFns = new Set<(i: { code: number | null }) => void>();
  let lastMeta: MetaLike = {};
  const deliver = (message: unknown) => queueMicrotask(() => { for (const fn of messageFns) fn(message); });
  const fake = createCodexFake({
    send: (message: unknown) => deliver(JSON.parse(JSON.stringify(message))),
    nextBehavior: (_meta: unknown, ctx: { cwd: string; message: string }) => next(lastMeta, ctx),
    callMcp: o.callMcp, ...(o.sleep ? { sleep: o.sleep } : {}),
    record: (entry: { meta: MetaLike; thread: Record<string, unknown>; start: Record<string, unknown>;
      active: string | null }) => {
      record.active?.push(entry.active);
      o.onTurn?.({ ...entry, meta: lastMeta });
    },
    exit: (code: number) => queueMicrotask(() => { for (const fn of closeFns) fn({ code }); }),
  } as never);
  const stream: JsonRpcStream = {
    write(message, meta) {
      const wire = JSON.parse(JSON.stringify(message));
      record.wire.push(wire);
      if (meta) { lastMeta = meta as MetaLike; record.metas.push(meta); }
      queueMicrotask(() => fake.onMessage(wire, meta));
    },
    onMessage(fn): Cancel { messageFns.add(fn); return () => messageFns.delete(fn); },
    onClose(fn): Cancel { closeFns.add(fn); return () => closeFns.delete(fn); },
    async close() { for (const fn of closeFns) fn({ code: 0 }); },
  };
  return { stream, record };
}
