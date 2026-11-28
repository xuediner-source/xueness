/**
 * Swarm (owner request, 2026-11-14): a coordinator, workers and a verifier
 * working in parallel on one goal, coordinated on a durable shared board,
 * modelled on Antigravity's /swarm and adapted to local models.
 *
 * The user approves the plan once; each worker may then write only its own
 * paths and run only its listed commands. Members sleep until a post reaches
 * them, a monitor without a model nudges a quiet swarm, and the Swarm pane
 * shows the board, the members and a mention graph with replay. Each member
 * may run on its own model and under the tool-call judge of the swarm's choice.
 *
 * `createSwarm(binding)` registers the user's tools, or a member's tools when
 * the binding names a member; the host owns the `SwarmService` and builds the
 * members' runtimes.
 */
import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };
import { swarmTools, type SwarmBinding } from "./tools.ts";

export * from "./plan.ts";
export * from "./board.ts";
export * from "./store.ts";
export * from "./engine.ts";
export * from "./prompts.ts";
export * from "./settings.ts";
export * from "./roster.ts";
export * from "./service.ts";
export * from "./tools.ts";
export * from "./roster-tools.ts";
export * from "./extension.ts";
export * from "./http.ts";

export function createSwarm(binding: SwarmBinding): BundledPlugin {
  return { manifest, plugin: definePlugin({ name: "swarm", apply(ctx) { for (const tool of swarmTools(binding)) ctx.tool(tool); } }) };
}

/** The bundled entry: catalog ownership only; a run binds the live service. */
export const swarm: BundledPlugin = createSwarm({ service: () => null, commandIssue: () => null, foldCase: process.platform === "win32" });
