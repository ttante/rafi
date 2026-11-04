// The ./build export: the check executor and step, and the full fingerprint, for the harness's tests (item 24, M3).
export { checkStep, executeCheck, type CheckEnv } from "./checks.js";
export { fullFingerprint } from "../facts/fingerprint.js";
