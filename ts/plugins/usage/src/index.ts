/** Read-only usage totals. The `usage` CLI stays on Python until the TS CLI round. */
import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };

export { aggregate, coerceMtime, coerceNow, coerceSteps, localDay, normalizeRange } from "./aggregate.ts";
export { buildUsage, collectSessions, type UsageStore } from "./build.ts";
export { createUsageHttp, USAGE_ROUTES, type UsageHttpOptions } from "./http.ts";

export const usage: BundledPlugin = { manifest, plugin: definePlugin({ name: "usage", apply() {} }) };
