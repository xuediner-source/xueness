/**
 * Tool-call decision model (owner request, 2026-11-14).
 *
 * An optional model — a local server or an API, any saved profile — reviews
 * risky tool calls before they run: one batched request per model step,
 * advise-only by default, repair and reject behind settings, fail-open.
 * The plugin owns no tools: its behaviour is the run extension
 * (`toolJudgeExtension`), its settings and statistics routes, and the verdict
 * shown on tool cards. The host binds model access through `JudgePorts`.
 */
import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };

export * from "./settings.ts";
export * from "./verdicts.ts";
export * from "./stats.ts";
export * from "./extension.ts";
export * from "./http.ts";

export const toolJudge: BundledPlugin = { manifest, plugin: definePlugin({ name: "tool_judge", apply() {} }) };
