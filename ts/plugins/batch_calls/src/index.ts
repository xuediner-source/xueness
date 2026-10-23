import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };

export { BATCH_CALLS_COMPACTION_REMINDER, BATCH_CALLS_POLICY } from "./policy.ts";
export { batchCallsExtension } from "./extension.ts";

export const batchCalls: BundledPlugin = {
  manifest,
  plugin: definePlugin({ name: "batch_calls", apply() {} }),
};
