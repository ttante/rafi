/**
 * The Rafi templating engine — deliberately tiny (§3 of PLAN.md).
 *
 * Two directives only:
 *   - `{{key}}`                  → substituted from {@link TemplateContext.vars}
 *   - `{{#if flag}}…{{/if}}`     → body kept when the flag is true, else the whole
 *                                  block (markers + body) is removed
 *
 * No nesting, no expressions, no helpers. An unknown var or flag is a hard error
 * rather than a silent blank, so a typo can never quietly drop guidance from a
 * composed agent. Conditional blocks are resolved first, so vars that live only
 * inside a dropped block are never required to exist.
 */

/** Values available to the engine for one render. */
export interface TemplateContext {
  /** `{{key}}` substitutions (e.g. the resolved `stack.*` strings). */
  vars: Record<string, string>;
  /** Booleans gating `{{#if flag}}…{{/if}}` blocks (e.g. `hasFrontend`). */
  flags: Record<string, boolean>;
}

const IF_BLOCK = /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g;
const VAR = /\{\{\s*(\w+)\s*\}\}/g;

/** Render a template string against the given context. Throws on unknown var/flag. */
export function render(template: string, ctx: TemplateContext): string {
  // 1) Resolve conditional blocks. Body is kept verbatim (and re-scanned for vars
  //    in step 2) when the flag is true; the entire block is dropped when false.
  const withConditionals = template.replace(IF_BLOCK, (_match, flag: string, body: string) => {
    if (!(flag in ctx.flags)) {
      throw new Error(`unknown flag in {{#if}}: ${flag}`);
    }
    return ctx.flags[flag] ? body : "";
  });

  // 2) Substitute remaining {{var}} occurrences. Anything left now is real text
  //    the author expected to fill, so an unknown key is an error.
  return withConditionals.replace(VAR, (_match, key: string) => {
    if (!(key in ctx.vars)) {
      throw new Error(`unknown placeholder: {{${key}}}`);
    }
    return ctx.vars[key];
  });
}
