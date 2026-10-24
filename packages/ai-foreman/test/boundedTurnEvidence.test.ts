import test from "node:test";
import assert from "node:assert/strict";
import { boundedUtf8, BoundedTurnEvents, receiptFingerprint, rawFingerprint } from "../src/boundedTurnEvidence.js";
import type { TurnResult } from "../src/adapters/types.js";

for (const bytes of [1024,1025]) test(`UTF-8 evidence retains complete characters within ${bytes} bytes`, () => {
  const original="é".repeat(1024);
  const retained=boundedUtf8(original,bytes);
  assert.ok(retained.length<=bytes);
  assert.equal(retained.toString().includes("�"),false);
  assert.equal(Buffer.from(retained.toString()).equals(retained),true);
});

test("event floods retain bounded metadata and exact counts without embedding turns", () => {
  const events=new BoundedTurnEvents(8192);
  for(let i=0;i<10000;i++) events.push({kind:"tool",name:"Bash",input:{command:"x".repeat(10000)},lifecycle:"completed"});
  const turn:TurnResult={text:"r".repeat(100000),isError:false,numTurns:1,costUsd:0,turnId:"terminal"};
  const receipt=receiptFingerprint(turn),raw=rawFingerprint(turn);
  events.push({kind:"turn-complete",turnId:"terminal",result:turn});
  const terminal=events.find(event=>event.kind==="turn-complete");
  assert.equal(terminal?.kind,"turn-complete");
  if(terminal?.kind!=="turn-complete")throw new Error("Terminal projection was lost");
  assert.equal(receiptFingerprint(terminal.result),receipt);assert.equal(rawFingerprint(terminal.result),raw);
  turn.text="changed after terminal";
  assert.notEqual(rawFingerprint(terminal.result),rawFingerprint(turn));
  events.push({kind:"turn-complete",turnId:"terminal",result:turn});
  assert.equal(events.terminalCount,2);assert.equal(events.toolCount,10000);assert.equal(events.totalCount,10002);
  assert.ok(events.omittedCount>0);assert.ok(events.retainedBytes<=8192);
  const metadata=JSON.stringify(events.metadata());assert.ok(Buffer.byteLength(metadata)<=8192);
  assert.equal(metadata.includes('"result"'),false);assert.equal(metadata.includes("rrrrrrrr"),false);
});
