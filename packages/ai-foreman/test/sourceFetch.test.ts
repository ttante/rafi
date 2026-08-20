import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchAndSnapshotUrl, htmlToText, isPublicAddress, normalizePublicHttpUrl, snapshotExternalLocalFile } from "../src/tickets/sourceFetch.js";

test("URL validation rejects credentials and private/reserved destinations", async () => {
  assert.throws(() => normalizePublicHttpUrl("https://user:secret@example.com/a"), /credentials/);
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.1.1", "192.168.1.1", "192.0.2.1", "::1", "fe80::1", "fc00::1", "2001:db8::1"]) assert.equal(isPublicAddress(address), false, address);
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(address), true, address);
  await assert.rejects(fetchAndSnapshotUrl(mkdtempSync(join(tmpdir(), "rafi-url-")), "http://127.0.0.1/source"), /not public/);
});

test("HTML extraction drops executable content and keeps readable blocks", () => {
  const text = htmlToText("<!doctype html><html><body><h1>Roadmap</h1><script>bad()</script><p>A &amp; B</p><li>Ship</li></body></html>");
  assert.match(text, /Roadmap/);
  assert.match(text, /A & B/);
  assert.match(text, /Ship/);
  assert.doesNotMatch(text, /bad/);
});

test("external local sources are copied into ignored imports", () => {
  const project = mkdtempSync(join(tmpdir(), "rafi-project-"));
  const external = join(mkdtempSync(join(tmpdir(), "rafi-external-")), "requirements.md");
  writeFileSync(external, "# Requirements\n", "utf8");
  const snapshot = snapshotExternalLocalFile(project, external);
  assert.match(snapshot, /^\.tickets\/imports\/local-/);
  assert.equal(readFileSync(join(project, snapshot), "utf8"), "# Requirements\n");
});
