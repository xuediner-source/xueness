/**
 * The OS Computer Use plugin (F12.03): approval-gated screen capture, window
 * listing and one-action input over a platform adapter port, with a per-session
 * grant ledger and an evidence journal. The bundled plugin wires no adapter, so
 * on every host it reports explicitly unavailable until the desktop host
 * injects one; a host that has an adapter passes it via `createOsCua`.
 */
import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };
import { EvidenceJournal } from "./journal.ts";
import { PermissionLedger } from "./permissions.ts";
import { platformAdapter, unwiredAdapter, type OsAdapterPort } from "./platform.ts";
import { osCuaTools } from "./tools.ts";

export { EvidenceJournal, DEFAULT_MAX_ENTRIES, type JournalEntry } from "./journal.ts";
export { PermissionLedger, DEFAULT_GRANT_TTL_MS, type GrantRecord, type LedgerState, type OsCuaScope } from "./permissions.ts";
export { ADAPTER_PLATFORMS, platformAdapter, unwiredAdapter, type AdapterAvailability, type OsAdapterPort, type OsInputAction, type OsWindow, type ScreenCapture } from "./platform.ts";
export { checkInputAction, KEYS, MAX_COORD, MAX_PNG_BASE64, MAX_TEXT_CHARS, MAX_WINDOWS, osCuaTools, type OsCuaToolsOptions } from "./tools.ts";

export interface OsCuaOptions {
  stateDir: string;
  /** A host-wired platform adapter; without one every tool is explicitly unavailable. */
  adapter?: OsAdapterPort;
  /** Restored grant ledger state (see PermissionLedger.state). */
  grants?: { grants: { sessionId: string; scope: "screen" | "input"; grantedAt: number; expiresAt: number }[] };
  now?: () => number;
}

export function createOsCua(options: OsCuaOptions): BundledPlugin {
  const platform = options.adapter?.platform ?? process.platform;
  const ledger = new PermissionLedger({ ...(options.now ? { now: options.now } : {}) });
  if (options.grants) ledger.restore(options.grants, options.now?.());
  const journal = new EvidenceJournal({ ...(options.now ? { now: options.now } : {}) });
  const adapter: OsAdapterPort = options.adapter ?? unwiredAdapter(platform);
  return { manifest, plugin: definePlugin({ name: "os_cua", apply(ctx) {
    for (const tool of osCuaTools({ adapter: async () => adapter, ledger, journal, ...(options.now ? { now: options.now } : {}) })) ctx.tool(tool);
  } }) };
}

/** The bundled registration: no adapter wired, so availability is explicit per platform. */
export const osCua = createOsCua({ stateDir: "." });
export const osCuaPlugin = osCua.plugin;
