// C124: the fast suite's job order. Jobs run longest first, using the last run's times from an ignored cache
// file; jobs with no recorded time (new files, or CI with no cache) go first, biggest file first. Plain ESM.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** `times`: name → ms from the last run; `size(name)`: the job file's size in bytes. Returns a new array. */
export function order(jobs, times, size) {
  const known = (j) => typeof times[j.name] === "number";
  const fresh = jobs.filter((j) => !known(j)).sort((a, b) => size(b.name) - size(a.name));
  const timed = jobs.filter(known).sort((a, b) => times[b.name] - times[a.name]);
  return [...fresh, ...timed];
}

export function readTimes(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Writes this run's times; `kept` (the last cache) keeps the solo times of files that ran in a group this time. */
export function writeTimes(file, results, kept = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  const times = { ...kept, ...Object.fromEntries(results.map((r) => [r.name, Math.round(r.ms * 10) / 10])) };
  writeFileSync(file, `${JSON.stringify(times, null, 2)}\n`);
}

/**
 * M5 speed (plan 10.8): a scenario job's process start and module load cost about half a second, so files whose
 * last solo time is under `solo` ms share one process (`--test-isolation=none`), packed first fit, longest first,
 * into groups of at most `group` ms. A file with no recorded time, or a heavy one, runs alone (and so gets a time).
 */
export function pack(files, times, o) {
  const known = (f) => typeof times[f] === "number";
  const alone = files.filter((f) => !known(f) || times[f] >= o.solo);
  const light = files.filter((f) => known(f) && times[f] < o.solo).sort((a, b) => times[b] - times[a]);
  const groups = [];
  for (const f of light) {
    const fits = groups.find((g) => g.ms + times[f] <= o.group);
    if (fits) { fits.files.push(f); fits.ms += times[f]; } else groups.push({ files: [f], ms: times[f] });
  }
  const solo = alone.sort((a, b) => (times[b] ?? Infinity) - (times[a] ?? Infinity) || a.localeCompare(b));
  return [...solo.map((f) => [f]), ...groups.map((g) => g.files)];
}
