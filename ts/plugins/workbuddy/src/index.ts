/**
 * WorkBuddy pool: a plugin-owned local gateway that rotates several WorkBuddy
 * accounts and exposes three of its models to conversations.
 *
 * The plugin starts nothing at boot. The gateway is started on the first
 * request that needs it, so a disabled or unused plugin costs no process.
 */
import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };

export { createWorkbuddy, PROFILE_PREFIX, type WorkbuddyOptions, type WorkbuddyProfiles } from "./api.ts";
export { Gateway } from "./gateway.ts";
export { createWorkbuddyHttp, ownsWorkbuddyRoute, WORKBUDDY_ROUTES, type WorkbuddyHttpOptions } from "./http.ts";
export { ensureLayout, PANEL_EXE, readRuntime, workbuddyLayout, writeRuntime, type Layout, type Runtime } from "./layout.ts";
export { MODELS, modelForProfile, profileId, type WorkbuddyModel } from "./models.ts";
export { ADAPTER_OUTPUT_CAP, WorkbuddyProvider } from "./provider.ts";

export const workbuddy: BundledPlugin = { manifest, plugin: definePlugin({ name: "workbuddy", apply() {} }) };
