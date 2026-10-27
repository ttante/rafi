/** Tag an error raised before any provider transport began, so the journal
 * records a known unsent turn instead of an unknown outcome. */
export function markDispatchNotSent(error: unknown): unknown {
  if (error && typeof error === "object") (error as { dispatchNotSent?: boolean }).dispatchNotSent = true;
  return error;
}

export function dispatchWasNotSent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { dispatchNotSent?: boolean }).dispatchNotSent);
}
