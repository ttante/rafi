// C231: the Ticket Maker's risk-note repair reply is exactly `{rollback}`, non-empty; no ids rafi has (6.1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkReply, replySchemas } from "../../src/v1/replies.js";

test("risk: a non-empty rollback is accepted; an empty one, an id or an extra field is refused", () => {
  assert.equal(checkReply("risk", { rollback: "Revert the commit." }).ok, true);
  assert.equal(checkReply("risk", { rollback: "  " }).ok, false);
  assert.equal(checkReply("risk", { rollback: "x", id: "T1" }).ok, false);
  assert.equal(checkReply("risk", {}).ok, false);
  assert.deepEqual((replySchemas.risk.codex as { required: string[] }).required, ["rollback"]);
});
