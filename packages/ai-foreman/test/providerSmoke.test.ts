import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "../src/adapters/claude.js";
import { CodexAdapter } from "../src/adapters/codex.js";
import type { BuilderAdapter } from "../src/adapters/types.js";

const live = process.env.RAFI_LIVE_PROVIDER_SESSIONS === "1";
for (const provider of ["claude", "codex"] as const) {
  test(`authenticated ${provider} session starts, compacts natively, and resumes exactly`, { skip: !live }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), `rafi-${provider}-smoke-`));
    const make = async (resumeSessionId?: string): Promise<BuilderAdapter> => provider === "claude"
      ? await ClaudeAdapter.create({ cwd, resumeSessionId, permission: async () => ({ behavior: "deny", message: "smoke is read-only" }), sandboxMode: "read-only" })
      : new CodexAdapter({ cwd, resumeSessionId, permission: async () => ({ behavior: "deny", message: "smoke is read-only" }), sandboxMode: "read-only" });
    const first = await make();
    let sessionId: string | undefined;
    let context;
    try {
      const turn = await first.sendTurn('Remember the nonce "rafi-native-compact" and return exactly OK.');
      assert.equal(turn.isError, false, turn.text);
      sessionId = first.sessionId();
      assert.ok(sessionId);
      let compact = await first.compact?.();
      for (let attempt = 1; compact && !compact.ok && /not enough messages/i.test(compact.error ?? "") && attempt <= 4; attempt += 1) {
        const filler = await first.sendTurn(`Continue remembering the nonce and return exactly ACK-${attempt}.`);
        assert.equal(filler.isError, false, filler.text);
        compact = await first.compact?.();
      }
      assert.equal(compact?.ok, true, compact?.error);
      context = await first.contextUsage?.();
    } finally {
      await first.close();
    }
    const resumed = await make(sessionId);
    try {
      const continuity = await resumed.sendTurn("Return only the nonce I asked you to remember.");
      assert.equal(continuity.isError, false, continuity.text);
      assert.match(continuity.text, /rafi-native-compact/);
      assert.ok(context === undefined || context.used >= 0);
    } finally {
      await resumed.close();
    }
  });
}
