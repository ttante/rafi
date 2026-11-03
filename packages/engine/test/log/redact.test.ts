// M2 plan 11.4 A5–A6 at the unit level (ARCH 7.12 "redaction learns every value handed out, with encodings";
// C80, C81): base64 (padded or not), base64url, hex (either case) and URL-encoded forms, a secret encoded inside a
// longer string, and the wider name test for declared names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { looksSecret, redactor } from "../../src/log/redact.js";

const SECRET = "s3cr3t value/with+chars&x=1";
const b64 = (t: string) => Buffer.from(t).toString("base64");
const forms = (t: string) => ({ raw: t, base64: b64(t), unpadded: b64(t).replace(/=+$/, ""),
  base64url: Buffer.from(t).toString("base64url"), hex: Buffer.from(t).toString("hex"),
  HEX: Buffer.from(t).toString("hex").toUpperCase(), url: encodeURIComponent(t) });

test("a secret-named variable's value is redacted raw and in each casual encoding, with its name", () => {
  const r = redactor({ MY_API_TOKEN: SECRET });
  for (const [form, value] of Object.entries(forms(SECRET))) {
    const out = r.text(`printed ${value} here`);
    assert.doesNotMatch(out, new RegExp(value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")), form);
    assert.match(out, /\[REDACTED:MY_API_TOKEN\]/, form);
  }
});

test("a secret encoded inside a longer string is caught at any byte offset", () => {
  const r = redactor({ API_SECRET: "canary-0123456789abcdef01234567" });
  for (const prefix of ["", "x", "xy", "API_SECRET="]) {
    const encoded = b64(`${prefix}canary-0123456789abcdef01234567;rest`);
    assert.doesNotMatch(r.text(encoded), new RegExp(b64("0123456789abcdef").slice(4, 16)), JSON.stringify(prefix));
  }
});

test("a session token rafi registers is redacted in its encodings too", () => {
  const r = redactor({});
  r.add("RAFI_SESSION_TOKEN", "tok123456789abcdefghij");
  assert.doesNotMatch(r.text(b64("tok123456789abcdefghij")), /dG9rMTIz/);
  assert.doesNotMatch(r.text(Buffer.from("tok123456789abcdefghij").toString("hex")), /746f6b/);
});

test("short values aren't learned; ordinary text is left alone", () => {
  const r = redactor({ SHORT_KEY: "abc", MY_TOKEN: "abcdef123" });
  assert.equal(r.text("abc and abcdeX"), "abc and abcdeX");
  assert.equal(r.text("hello world"), "hello world");
});

test("looksSecret: the secret-name test plus DSN, COOKIE and SESSION", () => {
  for (const name of ["API_SECRET", "STRIPE_KEY", "GH_TOKEN", "DB_PASSWORD", "SENTRY_DSN", "SESSION_COOKIE",
    "APP_SESSION"]) assert.equal(looksSecret(name), true, name);
  for (const name of ["DATABASE_URL", "PROJECT_FLAG", "PATH", "NODE_ENV"]) assert.equal(looksSecret(name), false, name);
});
