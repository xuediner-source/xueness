import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import type { Session, SessionStore } from "@xueness/sessions";
import { recordTurn } from "./turn-checkpoints.ts";
import manifest from "../manifest.json" with { type: "json" };
export * from "./actions.ts";
export * from "./turn-checkpoints.ts";
export * from "./http-api.ts";
export * from "./branches.ts";
export * from "./session-git.ts";
export * from "./clone.ts";
export * from "./write-actions.ts";
export function createGitCheckpoints(options: { store: SessionStore; stateDir: string; enabled(id: string): boolean; session(): Session | null }): BundledPlugin {
  return { manifest, plugin: definePlugin({ name: "git", apply(ctx) { ctx.toolEvent("after_tool_authorization", async (payload) => { await recordTurn(options.store, options.session(), options.enabled, String(payload.tool ?? ""), String(payload.kind ?? "")); }); } }) };
}
export const git: BundledPlugin = { manifest, plugin: definePlugin({ name: "git", apply() {} }) };
