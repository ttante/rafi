import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
// Script intentionally runs without built package dependencies or provider SDKs.
// @ts-ignore JavaScript CLI module has no declaration file.
import { evaluationManifest, reportResults } from '../scripts/graph-evaluation.mjs';
test('evaluation retains incomplete outcomes and refuses mismatched controls', () => {
  const manifest = evaluationManifest();
  assert.equal(manifest.cases.length, 20);
  assert.equal(new Set(manifest.cases.map((c: any) => c.category)).size, 5);
  assert.equal(reportResults(manifest, []).matchedPairs, 0);
  const fixture = manifest.cases[0];
  const base = { caseId: fixture.id, baselineDigest: fixture.baselineDigest, qaDigest: createHash('sha256').update(JSON.stringify(fixture.mandatoryQa)).digest('hex'), cache: 'cold', provider: 'fixture', model: 'fixture', depth: 'full', executionMode: 'local', semanticMode: 'mixed', difficulty: 'medium', status: 'cancelled', retries: 1, sourceVerified: false, coverageVerified: false,
    usefulFindings: null, missedPaths: null, falseSuggestions: null, omissionRemediations: null, escapedDefects: null, repeatedExploration: null, preparationMs: 10, buildMs: null, reviewMs: null, graphMs: 2, extractionCostUsd: null, providerCostUsd: null, inputTokens: null, outputTokens: null };
  const on = { ...base, arm: 'on', sessionId: 'on-session' }, off = { ...base, arm: 'off', sessionId: 'off-session' };
  const report = reportResults(manifest, [on, off]);
  assert.equal(report.matchedPairs, 1);
  assert.equal(report.outcomes.length, 2);
  assert.equal(report.pairs[0].differencesOnMinusOff.providerCostUsd, null);
  assert.throws(() => reportResults(manifest, [on, on]), /Duplicate/);
  assert.throws(() => reportResults(manifest, [on, { ...off, model: 'different' }]), /Unmatched/);
  assert.throws(() => reportResults(manifest, [{ ...on, qaDigest: 'different' }]), /mandatory QA/);
});
