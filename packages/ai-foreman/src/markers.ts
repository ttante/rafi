/**
 * Native operation instructions. Extracted from foreman.ts so tests can import
 * them without pulling in @clack/prompts (which requires Node >=20 for styleText).
 */

/** Active work protocol; legacy status parsers remain historical readers. */
export const MARKER_SPEC = `Return one work-report result through the configured native JSON schema. result.kind completed is your claim that the assigned work is finished; do not add a duplicate status field. The payload contains disposition modified or already-satisfied, truthful evidence, coverage when a verification contract is supplied (otherwise null), and graphMaintenance (null unless a meaningful indexed change occurred). Blocked work and questions use their own result alternatives. Never claim completion merely because a turn ended. Include bounded continuity when requested. The host still requires independent QA before completing a ticket.`;

export const QA_MARKER_SPEC = `Return one qa-verdict result through the configured native JSON schema. A completed verdict payload is either passed with independent coverage, or failed with the complete structured failure report and coverage. Report blocked work or a question explicitly. A pass cannot contain blocking findings; preserve all failures and uncertainties. Include required continuity in the same object.`;
