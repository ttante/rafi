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

export function writeTimes(file, results) {
  mkdirSync(path.dirname(file), { recursive: true });
  const times = Object.fromEntries(results.map((r) => [r.name, Math.round(r.ms * 10) / 10]));
  writeFileSync(file, `${JSON.stringify(times, null, 2)}\n`);
}
