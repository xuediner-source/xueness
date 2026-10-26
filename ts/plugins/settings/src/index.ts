import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };
export * from "./paths.ts";
export * from "./preferences.ts";
export * from "./store.ts";
export * from "./workspaces.ts";
export * from "./native-picker.ts";
export * from "./http-api.ts";
export * from "./runtime-config.ts";
export * from "./runtime-config-api.ts";
export * from "./layers.ts";
/** Settings own HTTP families only; the host wires them (`createSettingsApi`). */
export const settings: BundledPlugin = { manifest, plugin: definePlugin({ name: "settings", apply() {} }) };
