/** Built-in prefix used only when neither a run nor project value exists. */
export const BUILTIN_BRANCH_PREFIX = "feature";

/**
 * Validate a prefix as the leading components of a Git branch ref. Internal
 * slashes are intentional (for example `team/feature`).
 */
export function validateBranchPrefix(value: string): string {
  const prefix = value.trim();
  if (!prefix) throw new Error("branch prefix must not be empty");
  if (prefix === "@" || prefix.startsWith("-") || prefix.startsWith("/") || prefix.endsWith("/")) {
    throw new Error(`invalid Git branch prefix: ${value}`);
  }
  if (prefix.includes("//") || prefix.includes("..") || prefix.includes("@{") || /[\x00-\x20\x7f~^:?*\[\\]/.test(prefix)) {
    throw new Error(`invalid Git branch prefix: ${value}`);
  }
  for (const segment of prefix.split("/")) {
    if (!segment || segment === "." || segment === ".." || segment.startsWith(".") || segment.endsWith(".") || segment.endsWith(".lock")) {
      throw new Error(`invalid Git branch prefix: ${value}`);
    }
  }
  return prefix;
}

export function normalizeBranchPrefix(prefix: string | undefined): string {
  return validateBranchPrefix(prefix === undefined ? BUILTIN_BRANCH_PREFIX : prefix);
}
