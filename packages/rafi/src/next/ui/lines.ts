// The one-line error and refusal formats, with the `rafi:` prefix (Q-OUT-2). M1 part; M4's storage line.
import path from "node:path";
export function line(text: string): string {
  return `rafi: ${text}\n`;
}

/** C155 (ARCH 5.1 `storage`): a full disk or an unwritable folder stops with one line naming it and the command to
 * continue; null for any other error. Nothing recorded is deleted, and the lease stays for `rafi resume`. */
export function storageLine(error: unknown, project: string): string | null {
  const code = (error as { code?: string }).code ?? "";
  const folder = path.join(project, ".rafi");
  if (code === "SQLITE_FULL" || code === "ENOSPC") {
    return line(`The disk is full: rafi couldn't write to ${folder}. Free some space, then run \`rafi resume\`.`);
  }
  if (["EACCES", "EPERM", "EROFS", "SQLITE_READONLY", "SQLITE_CANTOPEN"].includes(code) ||
    /^SQLITE_(READONLY|CANTOPEN)/.test(code)) {
    return line(`rafi can't write to ${folder} (${code}). Make it writable, then run \`rafi resume\`.`);
  }
  return null;
}

export function notBuiltLine(command: string, milestone: string): string {
  return line(`\`rafi ${command}\` isn't in the new engine yet (milestone ${milestone}).`);
}

export function legacyRunLine(runId: string): string {
  return line(`This project uses 0.10.x formats and has an unfinished 0.10.x build (run ${runId}). ` +
    "Finish it with `rafi resume` or drop it with `rafi build:reset`, both run without RAFI_ENGINE; " +
    "then run `rafi migrate`.");
}
