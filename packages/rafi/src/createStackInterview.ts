import {
  discoveryEnvelopePlanningSources,
  discoveryEnvelopeStack,
  runDiscovery,
  type DiscoveryResult,
} from "./discovery.js";
import type { WalkthroughAnswers } from "./project.js";

export interface CreateStackPrompts {
  text(options: { message: string; initialValue?: string; defaultValue?: string }): Promise<unknown>;
  confirm(options: { message: string; initialValue?: boolean }): Promise<unknown>;
  select(options: { message: string; options: Array<{ value: string; label: string }> }): Promise<unknown>;
  isCancel(value: unknown): boolean;
  info(message: string): void;
}

export interface CreateStackInterviewResult {
  frontend: string;
  backend: string;
  database: string;
  planningSources?: string;
}

export interface CreateStackInterviewOptions {
  targetDir: string;
  answers: WalkthroughAnswers;
  prompts: CreateStackPrompts;
  checkpoint(checkpoint: string, key: string, value: unknown): void;
  discover?: (options: { project: string; suppressNextCommand: boolean }) => Promise<DiscoveryResult>;
}

/**
 * Ask whether this is a new or existing app, then collect its stack. Existing
 * apps may use read-only discovery and accept or edit the detected stack.
 */
export async function collectCreateStackInterview(
  options: CreateStackInterviewOptions,
): Promise<CreateStackInterviewResult | undefined> {
  const { targetDir, answers, prompts, checkpoint } = options;
  const projectKind = await prompts.select({
    message: "Are you starting a new app or adding Rafi to an existing app?",
    options: [
      { value: "new", label: "A new app" },
      { value: "existing", label: "An existing app" },
    ],
  });
  if (prompts.isCancel(projectKind)) return undefined;
  checkpoint("existing-app-review", "projectKind", String(projectKind));

  let frontend = answers.frontend;
  let backend = answers.backend;
  let database = answers.database;
  let planningSources: string | undefined;
  let acceptedReviewedStack = false;

  if (projectKind === "existing") {
    const runCreateDiscovery = await prompts.confirm({
      message: "Run a read-only review of this existing codebase before continuing?",
      initialValue: true,
    });
    if (prompts.isCancel(runCreateDiscovery)) return undefined;
    checkpoint("stack-review", "runDiscovery", Boolean(runCreateDiscovery));
    if (runCreateDiscovery) {
      const discovery = await (options.discover ?? runDiscovery)({ project: targetDir, suppressNextCommand: true });
      planningSources = discoveryEnvelopePlanningSources(discovery.envelope, discovery.answers);
      const reviewedStack = discoveryEnvelopeStack(discovery.envelope, {
        frontend: answers.frontend,
        backend: answers.backend,
        database: answers.database,
      });
      frontend = reviewedStack.frontend;
      backend = reviewedStack.backend;
      database = reviewedStack.database;
      prompts.info(`Read-only review suggested this stack:\n  Frontend: ${frontend}\n  Backend: ${backend}\n  Database: ${database}`);
      const stackChoice = await prompts.select({
        message: "Is this stack correct, and do you want to accept it?",
        options: [
          { value: "accept", label: "Accept these stack fields" },
          { value: "edit", label: "Edit the stack fields" },
        ],
      });
      if (prompts.isCancel(stackChoice)) return undefined;
      acceptedReviewedStack = stackChoice === "accept";
      checkpoint(acceptedReviewedStack ? "cloud" : "frontend", "stackReviewAccepted", acceptedReviewedStack);
    }
  }

  if (!acceptedReviewedStack) {
    const frontendAnswer = await prompts.text({
      message: 'Frontend stack (Enter to accept, or type "No UI" for no frontend):',
      initialValue: frontend,
      defaultValue: frontend,
    });
    if (prompts.isCancel(frontendAnswer)) return undefined;
    frontend = String(frontendAnswer);
    checkpoint("backend", "frontend", frontend);

    const backendAnswer = await prompts.text({
      message: "Backend stack: (Enter to accept)",
      initialValue: backend,
      defaultValue: backend,
    });
    if (prompts.isCancel(backendAnswer)) return undefined;
    backend = String(backendAnswer);
    checkpoint("database", "backend", backend);

    const databaseAnswer = await prompts.text({
      message: "Database: (Enter to accept)",
      initialValue: database,
      defaultValue: database,
    });
    if (prompts.isCancel(databaseAnswer)) return undefined;
    database = String(databaseAnswer);
    checkpoint("cloud", "database", database);
  }

  return { frontend, backend, database, planningSources };
}
