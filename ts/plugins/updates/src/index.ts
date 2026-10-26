/** Source fast-forward and the desktop update bridge. CLI `update` stays on Python until round 9. */
import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };

export { apply, check, safeOrigin } from "./git.ts";
export { createUpdatesHttp, UPDATE_ROUTES, type UpdateBridge, type UpdatesHttpOptions } from "./http.ts";

export const updates: BundledPlugin = { manifest, plugin: definePlugin({ name: "updates", apply() {} }) };
export { buildRetentionReport, seedLegacyUserState, snapshotUserState, RETENTION_SCHEMA } from "./upgrade-retention.ts";
