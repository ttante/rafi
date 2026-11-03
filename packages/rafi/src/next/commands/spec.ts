// The shape of a command definition, and the shared option sets (plan 5.1; REQ section 2).
export type Milestone = "M2" | "M4" | "M5" | "M6" | "M7" | "M8" | "M9" | "M10";

export interface OptionSpec {
  readonly flags: string;
  readonly description: string;
  readonly defaultValue?: string;
}

export interface CommandSpec {
  readonly name: string;
  /** Commander argument syntax, for example "<project>" or "[project]". */
  readonly args?: string;
  readonly summary: string;
  readonly milestone?: Milestone;
  readonly options?: readonly OptionSpec[];
  readonly subcommands?: readonly CommandSpec[];
  /** Which argument names the project, when one does. */
  readonly projectArg?: number;
  /** Runs without a project and without the format check (ARCH 9.2: migrate, doctor). */
  readonly anyFormat?: boolean;
  readonly noProject?: boolean;
}

const o = (flags: string, description: string, defaultValue?: string): OptionSpec =>
  Object.freeze({ flags, description, defaultValue });

export const projectOption = o("-p, --project <path>", "project folder (default: the nearest rafi-config.yaml)");
export const autoApprove: readonly OptionSpec[] = [
  o("--auto-approve", "answer every question that has a safe default (-y and --yes still work)"),
  o("-y, --yes", "alias for --auto-approve"),
];
export const agentOverrides: readonly OptionSpec[] = [
  o("-a, --agent <runtime>", "agent runtime for this run: claude or codex"),
  o("-m, --model <model>", "model for this run"),
  o("--effort <level>", "reasoning effort for this run"),
  o("--fast", "use the runtime's fast mode for this run"),
];
export const grillMe: readonly OptionSpec[] = [
  o("--grill-me", "exhaustive planning"),
  o("--no-grill-me", "standard planning (the default)"),
];
export const allowOption = o("--allow <needs>",
  "grant for this build, for builder and QA: internet, local-servers, installs, services");

export { o };
