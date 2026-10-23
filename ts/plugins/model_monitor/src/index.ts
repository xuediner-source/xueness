/** Passive upstream-model log. Default off, and only after the marketplace marker is installed. */
import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };

export { cleanObservation, clearObservations, readObservations, recordObservation, type Observation } from "./records.ts";
export { createModelMonitorHttp, MODEL_MONITOR_ROUTES, type ModelMonitorHttpOptions } from "./http.ts";

export const modelMonitor: BundledPlugin = { manifest, plugin: definePlugin({ name: "model_monitor", apply() {} }) };
