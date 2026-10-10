/** Offline evaluation manifest and matched-result validator. Never invokes a provider. */
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const categories = ['missed-caller', 'undeclared-dependency', 'cross-layer-regression', 'existing-invariant', 'captured-requirement'];
export function evaluationManifest() {
  const cases = categories.flatMap((category, index) => Array.from({ length: 4 }, (_, variant) => {
    const name = `${category}-${variant + 1}`;
    const files = {
      'requirements.md': `# Approved requirement\nReject negative values; preserve zero; return the normalized integer to every caller.\n`,
      'core.py': 'def normalize(value):\n    if value < 0:\n        raise ValueError("negative")\n    return int(value)\n',
      'api.py': 'from core import normalize\ndef response(value):\n    return {"value": normalize(value)}\n',
      'worker.py': 'from core import normalize\ndef process(value):\n    return normalize(value)\n',
      'test_contract.py': 'from api import response\nfrom worker import process\ndef test_zero():\n    assert response(0) == {"value": 0}\n    assert process(0) == 0\n',
      'plugin.py': 'def dynamic(module, value):\n    return getattr(module, "normalize")(value)\n',
    };
    const tasks = {
      'missed-caller': 'Assess changing normalize to accept a required precision argument. Identify every affected caller, including uncertain dynamic dispatch.',
      'undeclared-dependency': 'Plan a worker normalization change. Identify dependencies that must be reviewed before implementation.',
      'cross-layer-regression': 'Change integer conversion behavior while keeping API and worker contracts consistent. Identify regression tests.',
      'existing-invariant': 'Optimize normalization while preserving rejection of negative values and acceptance of zero.',
      'captured-requirement': 'Trace the approved negative-value and zero requirements to implementation and tests; identify missing test coverage.',
    };
    // Variants alter a source fact, not only the case identifier.
    files['variant.py'] = `from ${variant % 2 ? 'api import response' : 'worker import process'}\ndef scheduled_${variant}(value):\n    return ${variant % 2 ? 'response' : 'process'}(value)\n`;
    return { id: name, category, files, baselineDigest: hash(files), task: tasks[category], relevantPaths: Object.keys(files),
      sourceFacts: ['core.py rejects negative values', 'test_contract.py tests zero but omits negative-value coverage', 'plugin.py dispatch is dynamic and must be inspected in source'],
      absentOrAmbiguousEdges: ['dynamic getattr dispatch is not assumed resolved', 'requirements-to-test semantic edges are navigation hints, not proof'],
      mandatoryQa: ['inspect all affected callers', 'verify negative and zero behavior', 'run source tests', 'inspect dynamic dispatch'],
      order: (index + variant) % 2 ? ['off', 'on'] : ['on', 'off'] };
  }));
  return { version: 1, kind: 'rafi_graph_evaluation', cases, negativeControl: { task: 'Correct a comment typo in core.py', expectedMaintenanceRuns: 0 },
    controls: ['separate sessions and workspaces for each arm', 'identical approved scope, QA, depth, model, provider and baseline per pair', 'record cold and warm costs separately', 'retain blocked, cancelled, degraded and retried results', 'source inspection fallback is not graph retrieval'],
    qualityTarget: { repeatedExplorationOrOmissionReduction: 0.2, coverageMustNotDecline: true },
    limitation: 'Synthetic engineering fixtures validate machinery. Twenty matched fixture pairs do not establish representative production usefulness.' };
}
const metrics = ['usefulFindings', 'missedPaths', 'falseSuggestions', 'omissionRemediations', 'escapedDefects', 'repeatedExploration', 'preparationMs', 'buildMs', 'reviewMs', 'graphMs', 'extractionCostUsd', 'providerCostUsd', 'inputTokens', 'outputTokens'];
export function reportResults(manifest, rows) {
  if (!Array.isArray(rows)) throw new Error('Results must be an array');
  const keys = new Set(), sessions = new Set();
  for (const row of rows) {
    const fixture = manifest.cases.find(c => c.id === row.caseId);
    if (!fixture || !['on', 'off'].includes(row.arm) || !['cold', 'warm'].includes(row.cache)) throw new Error('Unknown case, arm or cache classification');
    const key = `${row.caseId}:${row.arm}:${row.cache}`;
    if (keys.has(key)) throw new Error(`Duplicate outcome ${key}`);
    keys.add(key);
    if (!row.sessionId || sessions.has(row.sessionId)) throw new Error('Each outcome needs an isolated session');
    sessions.add(row.sessionId);
    if (row.baselineDigest !== fixture.baselineDigest || row.qaDigest !== hash(fixture.mandatoryQa)) throw new Error('Baseline or mandatory QA differs from manifest');
    if (!['completed', 'blocked', 'cancelled', 'degraded', 'failed'].includes(row.status)) throw new Error('Missing outcome classification');
    for (const field of ['provider', 'model', 'depth', 'executionMode', 'semanticMode', 'difficulty']) if (typeof row[field] !== 'string' || !row[field]) throw new Error(`Missing ${field}`);
    if (!Number.isInteger(row.retries) || row.retries < 0) throw new Error('Retain retry accounting');
    if (typeof row.sourceVerified !== 'boolean' || typeof row.coverageVerified !== 'boolean') throw new Error('Explicit source and QA coverage review required');
    for (const metric of metrics) if (row[metric] !== null && !(Number.isFinite(row[metric]) && row[metric] >= 0)) throw new Error(`${metric} must be a nonnegative number or null (unmeasured)`);
  }
  const pairs = [], unmatched = [];
  for (const fixture of manifest.cases) for (const cache of ['cold', 'warm']) {
    const arms = rows.filter(r => r.caseId === fixture.id && r.cache === cache);
    if (arms.length !== 2) { unmatched.push({ caseId: fixture.id, cache, recordedArms: arms.map(r => r.arm) }); continue; }
    const on = arms.find(r => r.arm === 'on'), off = arms.find(r => r.arm === 'off');
    for (const field of ['provider', 'model', 'depth', 'executionMode', 'semanticMode', 'difficulty']) if (on[field] !== off[field]) throw new Error(`Unmatched ${field} in ${fixture.id}`);
    pairs.push({ caseId: fixture.id, cache, statuses: { on: on.status, off: off.status }, coverageVerified: on.coverageVerified && off.coverageVerified,
      differencesOnMinusOff: Object.fromEntries(metrics.map(m => [m, on[m] === null || off[m] === null ? null : on[m] - off[m]])) });
  }
  return { version: 1, recordedOutcomes: rows.length, matchedPairs: pairs.length, pairs, unmatched, outcomes: rows,
    qualityConclusion: 'No automatic benefit claim. Review source-backed findings and equal QA coverage, include all statuses and unknown costs, and disclose sample uncertainty.',
    liveEvaluation: rows.length ? 'User-supplied observations; harness does not execute or certify providers' : 'Deferred by user; no billed runs performed' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, destination] = process.argv.slice(2);
  const manifest = evaluationManifest();
  if (command === 'prepare' && destination) {
    mkdirSync(destination, { recursive: true });
    for (const fixture of manifest.cases) {
      const root = join(destination, fixture.id); mkdirSync(root, { recursive: true });
      for (const [path, content] of Object.entries(fixture.files)) writeFileSync(join(root, path), content, { flag: 'wx' });
    }
    writeFileSync(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    console.log(`Prepared ${manifest.cases.length} offline cases in ${destination}. No providers invoked.`);
  } else if (command === 'report') {
    console.log(JSON.stringify(reportResults(manifest, destination ? JSON.parse(readFileSync(destination, 'utf8')) : []), null, 2));
  } else throw new Error('Usage: node scripts/graph-evaluation.mjs prepare <new-directory> | report [results.json]');
}
