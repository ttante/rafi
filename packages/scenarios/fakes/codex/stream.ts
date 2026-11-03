// The in-process Codex: an in-memory JsonRpcStream driven by the script engine, beneath the real adapter.
// It reads `meta` from beside each message, as the real stream drops it (ARCH 11.6, plan choice C11).
import type { Cancel, JsonRpcStream } from "@rafi-ai/engine";
import { createCodexFake } from "./protocol.mjs";
import type { Behavior, MetaLike } from "../script/engine.js";

export interface CodexStreamLog {
  readonly wire: unknown[];
  readonly metas: unknown[];
}

export function codexStream(next: (meta: MetaLike) => Behavior, record: CodexStreamLog = { wire: [], metas: [] }) {
  const messageFns = new Set<(m: unknown) => void>();
  const closeFns = new Set<(i: { code: number | null }) => void>();
  let lastMeta: MetaLike = {};
  const deliver = (message: unknown) => queueMicrotask(() => { for (const fn of messageFns) fn(message); });
  const fake = createCodexFake({
    send: (message: unknown) => deliver(JSON.parse(JSON.stringify(message))),
    nextBehavior: () => next(lastMeta),
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
