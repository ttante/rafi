import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import {
  extractSourceRequests,
  loadSourceRegistry,
  registerSourceRequests,
  saveSourceRegistry,
  sourceRequestFromAnswer,
  validateSourceVersionRef,
} from "../src/sources/sourceRegistry.js";

function temp(): string { return mkdtempSync(join(tmpdir(), "rafi-sources-")); }

test("legacy planning and ticket sources merge without tokenizing human descriptions", () => {
  const dir = temp();
  try {
    writeFileSync(join(dir, "rafi-config.yaml"), stringify({
      planning: { sources: ["some files in docs", "docs/a file.md"] },
      tickets: { sources: [{ type: "local", paths: ["docs/a file.md"] }, { type: "url", url: "https://example.com/a,b+c" }], populate: { import_cap: 500 }, build: { cleanup: true } },
    }));
    const loaded = loadSourceRegistry(dir);
    assert.equal(loaded.migrated, true);
    assert.deepEqual(loaded.registry.pending?.map((item) => item.description), ["some files in docs"]);
    assert.equal(loaded.registry.entries.filter((item) => item.type === "local").length, 1);
    assert.equal(loaded.registry.entries.find((item) => item.type === "url")?.locator.url, "https://example.com/a,b+c");
    saveSourceRegistry(dir, loaded.registry);
    const saved = parse(readFileSync(join(dir, "rafi-config.yaml"), "utf8")) as any;
    assert.equal(saved.planning, undefined);
    assert.equal(saved.tickets.sources, undefined);
    assert.equal(saved.tickets.populate.import_cap, 500);
    assert.equal(saved.tickets.build.cleanup, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("local source versions append by fingerprint and support spaces and storage changes", async () => {
  const dir = temp();
  try {
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs", "a file.md"), "one\n");
    let result = await registerSourceRequests(dir, { version: 1, snapshot_storage: "local", entries: [] }, [sourceRequestFromAnswer("docs/a file.md", dir)]);
    const id = result.registry.entries[0]!.id;
    assert.equal(result.registry.entries[0]!.versions.length, 1);
    assert.match(result.registry.entries[0]!.versions[0]!.snapshot_path, /^\.rafi\/source-cache\//);
    result = await registerSourceRequests(dir, result.registry, [sourceRequestFromAnswer("docs/a file.md", dir)]);
    assert.equal(result.registry.entries[0]!.versions.length, 1);
    writeFileSync(join(dir, "docs", "a file.md"), "two\n");
    result = await registerSourceRequests(dir, result.registry, [sourceRequestFromAnswer("docs/a file.md", dir)], { storage: "tracked" });
    assert.equal(result.registry.entries[0]!.versions.length, 2);
    assert.match(result.registry.entries[0]!.versions[1]!.snapshot_path, /^\.rafi\/sources\//);
    assert.equal(validateSourceVersionRef(result.registry, { source_id: id, fingerprint: result.registry.entries[0]!.versions[0]!.fingerprint }, dir), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("structured requests and URL answers preserve commas and plus signs", () => {
  const dir = temp();
  try {
    const url = "https://example.com/issues?q=a+b,c";
    assert.equal(sourceRequestFromAnswer(url, dir).locator?.url, url);
    const requests = extractSourceRequests(`before\nRAFI_SOURCE_REQUEST_START\n[{"type":"local","label":"Docs","locator":{"path":"docs with spaces"}}]\nRAFI_SOURCE_REQUEST_END\nSTEP_STATUS: needs_input | question="Which files?"`);
    assert.deepEqual(requests, [{ type: "local", label: "Docs", locator: { path: "docs with spaces" } }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("local directories and globs resolve as one source answer without whitespace splitting", async () => {
  const dir = temp();
  try {
    mkdirSync(join(dir, "docs with spaces"));
    writeFileSync(join(dir, "docs with spaces", "one.md"), "one");
    writeFileSync(join(dir, "docs with spaces", "two.txt"), "two");
    const request = sourceRequestFromAnswer("docs with spaces/*.md", dir);
    assert.equal(request.type, "local");
    const result = await registerSourceRequests(dir, { version: 1, snapshot_storage: "local", entries: [] }, [request]);
    assert.equal(result.registry.entries[0]!.versions[0]!.item_count, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("external absolute paths are snapshotted without persisting the absolute locator", async () => {
  const dir = temp(); const outside = temp();
  try {
    const file = join(outside, "outside notes.md"); writeFileSync(file, "private\n");
    const result = await registerSourceRequests(dir, { version: 1, snapshot_storage: "local", entries: [] }, [{ type: "local", locator: { path: file } }]);
    const serialized = JSON.stringify(result.registry);
    assert.equal(serialized.includes(outside), false);
    assert.equal(existsSync(join(dir, result.registry.entries[0]!.versions[0]!.snapshot_path)), true);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("source-aware writes backfill unique legacy ticket links and report ambiguous ones", () => {
  const dir = temp();
  try {
    mkdirSync(join(dir, ".tickets"));
    writeFileSync(join(dir, "rafi-config.yaml"), stringify({ sources: { version: 1, snapshot_storage: "local", entries: [
      { id: "src_aaaaaaaaaaaaaaaa", type: "url", label: "spec", active: true, locator: { url: "https://example.com/a" }, versions: [] },
    ] } }));
    writeFileSync(join(dir, ".tickets", "tickets.yaml"), stringify({ tickets: [{ id: "T001", source_refs: [{ source: "spec", item: "REQ-1" }] }] }));
    const loaded = loadSourceRegistry(dir); saveSourceRegistry(dir, loaded.registry);
    const ticketFile = parse(readFileSync(join(dir, ".tickets", "tickets.yaml"), "utf8")) as any;
    assert.equal(ticketFile.tickets[0].source_refs[0].source_id, "src_aaaaaaaaaaaaaaaa");
    loaded.registry.entries.push({ id: "src_bbbbbbbbbbbbbbbb", type: "local", label: "spec", active: true, locator: { path: "spec" }, versions: [] });
    delete ticketFile.tickets[0].source_refs[0].source_id;
    writeFileSync(join(dir, ".tickets", "tickets.yaml"), stringify(ticketFile));
    saveSourceRegistry(dir, loaded.registry);
    assert.match(loadSourceRegistry(dir).warnings.join("\n"), /ambiguous legacy source reference/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
