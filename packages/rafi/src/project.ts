import { loadDefaults } from "special-agents";
import type { ProjectConfig, HarnessTarget } from "rafi-spec";

export const NO_UI = "No UI";
export const LOCAL_ONLY = "Local only";

export interface WalkthroughAnswers {
  appName: string;
  timezone: string;
  frontend: string;
  backend: string;
  database: string;
  cloud: string;
  packageManager: string;
  usesAI: boolean;
  targets: HarnessTarget[];
  qa: boolean;
}

/** Default answers — equivalent to running with `--defaults`. */
export function defaultAnswers(): WalkthroughAnswers {
  const d = loadDefaults();
  return {
    appName: "My App",
    timezone: "UTC",
    frontend: d.stack.frontend,
    backend: d.stack.backend,
    database: d.stack.database,
    cloud: d.stack.cloud,
    packageManager: d.stack.packageManager,
    usesAI: Boolean(d.flags.usesAI),
    targets: ["claude", "codex"],
    qa: true,
  };
}

/** Map walkthrough answers to a validated ProjectConfig. */
export function buildProjectConfig(answers: WalkthroughAnswers): ProjectConfig {
  const hasFrontend = answers.frontend !== NO_UI;
  const runsInCloud = answers.cloud !== LOCAL_ONLY;
  return {
    appName: answers.appName,
    timezone: answers.timezone,
    stack: {
      frontend: hasFrontend ? answers.frontend : "",
      backend: answers.backend,
      database: answers.database,
      cloud: runsInCloud ? answers.cloud : "",
      packageManager: answers.packageManager,
    },
    flags: {
      hasFrontend,
      usesAI: answers.usesAI,
      runsInCloud,
    },
    harness: {
      targets: answers.targets,
      qa: answers.qa,
    },
  };
}
