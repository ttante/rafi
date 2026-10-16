/** Only explicit speed-option rejection permits a same-session retry. Auth,
 * generic model failures, timeouts, and uncertain transport failures do not. */
export function isFastModeUnavailable(detail: string): boolean {
  return /(?:fast(?:[ _-]mode)?|service[ _-]tier|speed\s*[=:]\s*["']?fast)[\s\S]{0,160}(?:not supported|unsupported|not available|unavailable|not enabled|disabled|not allowed|requires|invalid|unrecognized|unknown)|(?:not supported|unsupported|not available|unavailable|invalid|unrecognized|unknown)[\s\S]{0,100}(?:--fast|fast[ _-]mode|service[ _-]tier)/i.test(detail);
}

export function reportFastModeUnavailable(model?: string): void {
  const label = (model ?? "the selected model").replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 200);
  console.error(`rafi: Fast mode not available with ${label}; continuing at standard speed.`);
}
