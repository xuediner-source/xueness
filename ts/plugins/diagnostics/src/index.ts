/** Local diagnostics. `doctor` CLI stays on Python until the TS CLI round. */
import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };

export { removeSettledLogs } from "./cleanup.ts";
export { doctor, type DoctorOptions } from "./doctor.ts";
export { createDiagnosticsHttp, DIAGNOSTICS_ROUTES, type DiagnosticsHttpOptions } from "./http.ts";
export { runtimeSnapshot } from "./metrics.ts";
export { diagnosticReport, type CatalogRow } from "./report.ts";
export {
  ENTRY_ACCEPTANCE_SCHEMA, ENTRY_PLATFORMS, PRODUCTION_ENTRIES, EntryAcceptanceError,
  assessEntry, buildEntryAcceptanceMatrix, entryPlatformOf, loadEntryAcceptance, saveEntryAcceptance, validateEntryAcceptance,
  type BuildEvidence, type EntryAcceptanceInput, type EntryAcceptanceMatrix, type EntryCellRecord,
  type EntryPlatform, type EntryProbe, type EntryVerdict, type KeyLinkEvidence, type ProductionEntry,
} from "./entry-acceptance.ts";

export const diagnostics: BundledPlugin = { manifest, plugin: definePlugin({ name: "diagnostics", apply() {} }) };
export { buildPerformanceBaseline, paginateHistory, concurrentFairness, PERF_SCHEMA } from "./performance-baseline.ts";
