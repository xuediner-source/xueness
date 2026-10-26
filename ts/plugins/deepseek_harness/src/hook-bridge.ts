/**
 * H08.02 — mounted harness hook declarations → hooks-plugin contribution data.
 *
 * A harness manifest declares `hooks: [{ event, handler }]` (H01 loader), but
 * the hooks plugin only runs rows handed to it through `registerPluginHooks`.
 * This module is the production seam between the two: it turns a mount in a
 * `HarnessRegistry` into one `deepseek_harness` plugin contribution, mapping
 * the harness event vocabulary onto the hooks plugin's `HookEvent` names.
 *
 * Three rules keep the bridge declarative and trust-neutral:
 *   - the harness never names a program: a manifest row is only a handler
 *     reference, so the host supplies a resolver for command/args. A
 *     declaration the host cannot resolve produces no row, with a reason.
 *   - the bridge returns data, it does not reach into the hooks plugin: the
 *     host registers the contribution, so no plugin-to-plugin import grows.
 *   - admission stays with the hooks plugin boundary (F07.03). Nothing here
 *     marks a row trusted; an untrusted boundary still disables every row.
 */
import type { HarnessHookDeclaration } from "./loader.ts";
import type { HarnessRegistry } from "./registry.ts";

/** The plugin id harness hook rows register under. */
export const HARNESS_HOOK_PLUGIN = "deepseek_harness";

/**
 * Harness event names are lowercase snake case (`after_tool_execution`); the
 * hooks plugin runs the tool-event names (`PostToolUse`). Only events with the
 * same meaning map across, so a manifest cannot relabel one event as another
 * and inherit a different admission rule (PreToolUse alone can veto).
 */
export const HARNESS_EVENT_MAP: Readonly<Record<string, string>> = Object.freeze({
  after_tool_execution: "PostToolUse",
  after_tool_failure: "PostToolUseFailure",
  session_start: "SessionStart",
  user_prompt_submit: "UserPromptSubmit",
});

/** One runnable command the host resolves for a declared handler. */
export interface HarnessHookCommand {
  readonly command: string;
  readonly args?: readonly string[];
  /** Only fire for this tool name (the hooks plugin `matcher`). */
  readonly matcher?: string;
  readonly timeoutMs?: number;
}

/** Resolves a handler reference to a command; `null` means "not runnable here". */
export type HarnessHookResolver = (handler: string, declaration: HarnessHookDeclaration) => HarnessHookCommand | null;

/**
 * One row as the hooks plugin stores it. The index signature keeps it
 * assignable to the hooks plugin's own `Row`, so the host can pass these rows
 * straight to `registerPluginHooks` without re-typing or casting.
 */
export interface HarnessHookRow extends Record<string, unknown> {
  readonly id: string;
  readonly event: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly matcher?: string;
  readonly timeout?: number;
}

/** One harness's rows, plus why the remaining declarations produced none. */
export interface HarnessHookMapping {
  readonly harness: string;
  readonly rows: readonly HarnessHookRow[];
  /** Declarations that produced no row, with the reason (never silent). */
  readonly skipped: readonly { readonly handler: string; readonly event: string; readonly reason: string }[];
}

/** The hooks-plugin contribution shape: one plugin id and its rows. */
export interface HarnessHookContribution {
  readonly plugin: string;
  readonly rows: readonly HarnessHookRow[];
}

/**
 * Map one harness's declarations to hooks-plugin rows. Deterministic: manifest
 * order is preserved and ids are `${event}:${handler}`, so a re-mount produces
 * byte-identical rows.
 */
export function harnessHookRows(
  declarations: readonly HarnessHookDeclaration[],
  resolve: HarnessHookResolver,
): { rows: HarnessHookRow[]; skipped: { handler: string; event: string; reason: string }[] } {
  const rows: HarnessHookRow[] = [];
  const skipped: { handler: string; event: string; reason: string }[] = [];
  for (const declaration of declarations) {
    const event = HARNESS_EVENT_MAP[declaration.event];
    if (event === undefined) {
      skipped.push({ handler: declaration.handler, event: declaration.event, reason: `unmapped_event:${declaration.event}` });
      continue;
    }
    const resolved = resolve(declaration.handler, declaration);
    if (resolved === null || !resolved.command) {
      skipped.push({ handler: declaration.handler, event: declaration.event, reason: "handler_unresolved" });
      continue;
    }
    rows.push({
      id: `${declaration.event}:${declaration.handler}`,
      event,
      command: resolved.command,
      ...(resolved.args?.length ? { args: [...resolved.args] } : {}),
      ...(resolved.matcher ? { matcher: resolved.matcher } : {}),
      ...(resolved.timeoutMs && resolved.timeoutMs > 0 ? { timeout: resolved.timeoutMs } : {}),
    });
  }
  return { rows, skipped };
}

/** Every mounted harness's mapping, in registry id order. */
export function harnessHookMappings(registry: HarnessRegistry, resolve: HarnessHookResolver): HarnessHookMapping[] {
  const mappings: HarnessHookMapping[] = [];
  for (const entry of registry.list()) {
    const mounted = registry.get(entry.id);
    if (mounted === null) continue;
    mappings.push({ harness: mounted.id, ...harnessHookRows(mounted.manifest.hooks, resolve) });
  }
  return mappings;
}

/**
 * The single `deepseek_harness` contribution covering every mounted harness,
 * or `null` when no mounted manifest declares a runnable hook. The host hands
 * this to `registerPluginHooks`, which keeps ownership and admission in the
 * hooks plugin instead of duplicating them here.
 */
export function harnessHookContribution(registry: HarnessRegistry, resolve: HarnessHookResolver): HarnessHookContribution | null {
  const rows = harnessHookMappings(registry, resolve).flatMap((mapping) => mapping.rows.map((row) => ({ ...row })));
  return rows.length ? { plugin: HARNESS_HOOK_PLUGIN, rows } : null;
}
