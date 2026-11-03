// The one-line error and refusal formats, with the `rafi:` prefix (Q-OUT-2). M1 part.
export function line(text: string): string {
  return `rafi: ${text}\n`;
}

export function notBuiltLine(command: string, milestone: string): string {
  return line(`\`rafi ${command}\` isn't in the new engine yet (milestone ${milestone}).`);
}

export function legacyRunLine(runId: string): string {
  return line(`This project uses 0.10.x formats and has an unfinished 0.10.x build (run ${runId}). ` +
    "Finish it with `rafi resume` or drop it with `rafi build:reset`, both run without RAFI_ENGINE; " +
    "then run `rafi migrate`.");
}
