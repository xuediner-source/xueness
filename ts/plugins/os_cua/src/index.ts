/** Plugin-owned desktop adapter, tool admission and per-session evidence. */
import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };
import { EvidenceJournal } from "./journal.ts";
import { PermissionLedger, type LedgerState } from "./permissions.ts";
import { unwiredAdapter, type OsAdapterPort } from "./platform.ts";
import { createMacOsAdapter } from "./macos.ts";
import { osCuaTools } from "./tools.ts";

export { EvidenceJournal, DEFAULT_MAX_ENTRIES, type JournalEntry } from "./journal.ts";
export { PermissionLedger, DEFAULT_GRANT_TTL_MS, type GrantRecord, type LedgerState, type OsCuaScope } from "./permissions.ts";
export { ADAPTER_PLATFORMS, platformAdapter, unwiredAdapter, type AdapterAvailability, type OsAdapterPort, type OsInputAction, type OsWindow, type ScreenCapture } from "./platform.ts";
export { checkInputAction, KEYS, MAX_COORD, MAX_PNG_BASE64, MAX_TEXT_CHARS, MAX_WINDOWS, osCuaTools, type OsCuaToolsOptions } from "./tools.ts";

export const OS_CUA_TOOL_NAMES: readonly string[] = Object.freeze(manifest.tools.map(({ name }) => name));

export interface OsCuaOptions {
  stateDir: string;
  adapter?: OsAdapterPort;
  grants?: LedgerState;
  now?: () => number;
  desktop?: {
    enabled(): boolean;
    session(): { id?: unknown; remote_connection?: unknown } | null;
  };
}

export function createOsCua(options: OsCuaOptions): BundledPlugin {
  const { desktop, now } = options;
  const ledger = desktop ? undefined : new PermissionLedger({ now });
  if (options.grants) ledger?.restore(options.grants, now?.());
  const journal = new EvidenceJournal({ now });
  return { manifest, plugin: definePlugin({ name: "os_cua", apply(ctx) {
    const adapter = options.adapter ?? (desktop ? createMacOsAdapter(ctx, desktop.enabled) : unwiredAdapter(process.platform));
    for (const tool of osCuaTools({
      adapter: async () => adapter, ledger, journal, now, windowRequired: !!desktop,
      admit: desktop ? (env) => {
        const session = desktop.session();
        return desktop.enabled() && !!session && !session.remote_connection && !!env.owner && env.owner === session.id;
      } : undefined,
    })) ctx.tool(tool);
  } }) };
}

/** Catalog-only binding outside the managed desktop agent. */
export const osCua = createOsCua({ stateDir: "." });
export const osCuaPlugin = osCua.plugin;
