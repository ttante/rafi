export function importFromMarkdown(_progressDocPath: string): never {
  throw new Error(
    "foreman tickets import is not yet implemented.\n\n" +
    "To start fresh:\n" +
    "  1. Run `foreman tickets init --app-name \"My App\" --timezone America/Chicago`\n" +
    "  2. Add your tickets to .tickets/tickets.yaml\n" +
    "  3. Run `foreman tickets render`\n\n" +
    "Manual migration steps:\n" +
    "  1. Copy ticket definitions into .tickets/tickets.yaml following the schema.\n" +
    "  2. Run `foreman tickets validate` to check the structure.\n" +
    "  3. Use `foreman tickets update <id> --status <status>` to restore active ticket states.",
  );
}
