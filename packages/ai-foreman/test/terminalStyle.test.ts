import assert from "node:assert/strict";
import { test } from "node:test";
import { accent, sanitizeTerminalText, terminalColorEnabled } from "../src/terminalStyle.js";

const tty = { isTTY: true };
const pipe = { isTTY: false };

test("color policy resolves TTY state independently from each destination", () => {
  assert.equal(terminalColorEnabled({ stream: tty, env: {} }), true);
  assert.equal(terminalColorEnabled({ stream: pipe, env: {} }), false);
  assert.equal(terminalColorEnabled({ stream: tty, env: {} , machineReadable: true }), false);
  assert.equal(terminalColorEnabled({ stream: pipe, env: { FORCE_COLOR: "2" } }), true);
  assert.equal(terminalColorEnabled({ stream: tty, env: { FORCE_COLOR: "2" }, machineReadable: true }), false);
});

test("NO_COLOR, TERM=dumb, and FORCE_COLOR=0 disable color in precedence order", () => {
  for (const env of [
    { NO_COLOR: "" },
    { NO_COLOR: "1", FORCE_COLOR: "3" },
    { TERM: "dumb" },
    { TERM: "dumb", FORCE_COLOR: "3" },
    { FORCE_COLOR: "0" },
    { FORCE_COLOR: "0", TERM: "xterm" },
  ]) assert.equal(terminalColorEnabled({ stream: tty, env }), false);
  assert.equal(terminalColorEnabled({ stream: pipe, env: { FORCE_COLOR: "1" } }), true);
  assert.equal(terminalColorEnabled({ stream: pipe, env: { FORCE_COLOR: "3" } }), true);
});

test("empty and invalid FORCE_COLOR fall through to TTY detection", () => {
  for (const value of ["", "true", "4", "yes"]) {
    assert.equal(terminalColorEnabled({ stream: tty, env: { FORCE_COLOR: value } }), true);
    assert.equal(terminalColorEnabled({ stream: pipe, env: { FORCE_COLOR: value } }), false);
  }
});

test("legacy Windows console TTY stays plain unless ANSI support is advertised", () => {
  assert.equal(terminalColorEnabled({ stream: tty, env: {}, platform: "win32" }), false);
  assert.equal(terminalColorEnabled({ stream: tty, env: { WT_SESSION: "1" }, platform: "win32" }), true);
  assert.equal(terminalColorEnabled({ stream: tty, env: { ConEmuANSI: "ON" }, platform: "win32" }), true);
});

test("styles use only their fixed semantic ANSI sequence and plain mode has no ESC", () => {
  assert.equal(accent("label", { stream: tty, env: {} }), "\x1b[36mlabel\x1b[39m");
  assert.equal(accent("label", { stream: pipe, env: {} }), "label");
  assert.equal(accent("label", { stream: tty, env: {}, machineReadable: true }).includes("\x1b"), false);
});

test("terminal sanitizer removes CSI, OSC, C1, and other controls while retaining newlines", () => {
  const input = "safe\x1b[31mred\x1b[0m\x1b]0;owned title\x07\x9b2J\x9dclipboard\x07\x01\nnext";
  const cleaned = sanitizeTerminalText(input);
  assert.equal(cleaned, "safered\nnext");
  assert.doesNotMatch(cleaned, /[\x1b\x80-\x9f]/);
});
