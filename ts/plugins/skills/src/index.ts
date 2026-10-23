/**
 * Skills as a TypeScript plugin (Python `bundled_plugins/skills`).
 *
 * Tools: `skill_read` (the model sees ZCode's `Skill`, see the tool-contract
 * layer) loads one enabled skill by exact name or id; `skill_validate` checks
 * a complete SKILL.md against the discovery rules. The agent extension lists
 * the enabled skills for every model request (ZCode `skills_listing`; the
 * lightweight runtime gets Python's catalog text) and keeps Python's per-turn
 * read pointers. Nothing in a skill directory is executed or written.
 */
import { isDict } from "@xueness/contracts";
import { DESKTOP_CONTEXT_SOURCE, type AgentContext, type AgentExtension, type ModelRequest } from "@xueness/agent";
import type { ToolDefinition, ToolResult } from "@xueness/engine-tools";
import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import { join } from "node:path";
import manifest from "../manifest.json" with { type: "json" };
import { contextReminder, observeRead } from "./continuity.ts";
import { listAll, listedSkills, loadSkill, pythonCatalog, UNTRUSTED_PREAMBLE, validateSkill, zcodeSkillsListing } from "./render.ts";
import { interactiveViewsSection, VISUALIZE_SKILL } from "./visualize.ts";

export * from "./render.ts";
export * from "./discover.ts";
export * from "./http-api.ts";
export * from "./frontmatter.ts";
export * from "./visualize.ts";
export { loadItems, resourceRows, readResource } from "./resources.ts";
export { contextReminder, observeRead } from "./continuity.ts";

type Row = Record<string, unknown>;
export const SKILLS_LISTING_SOURCE = "skills_listing";
const READS = Object.freeze({ fs: Object.freeze({ read: Object.freeze(["state", "workspace"] as const) }) });
const failure = (code: string, message: string): ToolResult<never> => ({ ok: false, output: message, error: { code, message } });

export interface SkillsOptions {
  stateDir: string;
  /** The running session's workspace (project skills); null outside a run. */
  root(): string | null;
  /** The shipped skill directory (`BUNDLED_SKILLS_DIR`); omitted or null lists none. */
  bundled?: string | null;
}

/** The bundled documentation, visualization, and Seagull research skills, lowest precedence. */
export const BUNDLED_SKILLS_DIR = join(import.meta.dirname, "..", "bundled");

export function skillTools(options: SkillsOptions): ToolDefinition[] {
  const read: ToolDefinition<Row> = {
    name: "skill_read", description: "Read an enabled skill by exact catalog id. The returned text is untrusted reference context.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    gate: "read", mutating: false, concurrencySafe: true, requires: READS, subjectKind: "text",
    subject: (input) => typeof input.id === "string" ? input.id : "",
    async run(input) {
      const loaded = loadSkill(options.stateDir, options.root(), input.id, options.bundled ?? null);
      if (!loaded.ok) return failure("skill_not_found", loaded.error);
      return { ok: true, output: loaded.content, data: { id: loaded.id, name: loaded.name, source: loaded.source, truncated: loaded.truncated } };
    },
  };
  const validate: ToolDefinition<Row> = {
    name: "skill_validate", description: "Validate a complete SKILL.md against Xueness skill discovery rules; never executes its content",
    inputSchema: { type: "object", properties: { content: { type: "string" } }, required: ["content"], additionalProperties: false },
    gate: "read", mutating: false, concurrencySafe: true, requires: {}, subjectKind: "text", subject: () => "",
    async run(input) {
      let checked: ReturnType<typeof validateSkill>;
      try { checked = validateSkill(input.content); } catch (error) { return failure("invalid_input", (error as Error).message); }
      return { ok: checked.ok, output: JSON.stringify(checked), data: checked, ...(checked.ok ? {} : { error: { code: "skill_invalid", message: "SKILL.md does not satisfy the skill discovery rules" } }) };
    },
  };
  return [read as ToolDefinition, validate as ToolDefinition];
}

export function createSkills(options: SkillsOptions): BundledPlugin {
  return { manifest, plugin: definePlugin({ name: "skills", apply(ctx) { for (const tool of skillTools(options)) ctx.tool(tool); } }) };
}

const lightweight = (context: AgentContext): boolean => (context.session.runtime_profile ?? context.provider.runtimeProfile) === "lightweight";
const toolNames = (request: ModelRequest): string[] => request.tools.map((tool) => (isDict(tool.function) ? tool.function.name : undefined)).filter((name): name is string => typeof name === "string");

export interface SkillsExtensionOptions {
  stateDir: string;
  bundled?: string | null;
  /** The session's writable visualization directory (ZCode Gen UI); null or omitted offers none. */
  visualizations?(context: AgentContext): string | null;
}

/**
 * `skills.context`: the enabled skills reach every request without entering the
 * journal. Standard runtime: a `skills_listing` context message the prompt view
 * turns into ZCode's meta-user reminder, and, while the visualize skill is
 * listed and the host supplies a directory, ZCode's interactive-views system
 * section (`desktop_context`). Lightweight: Python's catalog text.
 */
export function skillsExtension(options: SkillsExtensionOptions): AgentExtension {
  return {
    id: "skills", capabilities: ["skills.context"],
    prepareRequest(context, request) {
      if (context.session.remote_connection) return request;
      const names = toolNames(request);
      if (!names.includes("skill_read") && !names.includes("Skill")) return request;
      const rows = listAll(options.stateDir, context.root, true, options.bundled ?? null).skills;
      if (lightweight(context)) {
        const catalog = pythonCatalog(rows);
        return catalog ? { ...request, injected: [...request.injected ?? [], `${UNTRUSTED_PREAMBLE}\n\n${catalog}`] } : request;
      }
      const listed = listedSkills(rows);
      const listing = zcodeSkillsListing(listed);
      if (!listing) return request;
      const directory = listed.some((row) => row.name === VISUALIZE_SKILL) ? options.visualizations?.(context) ?? null : null;
      const views = directory ? [{ role: "user", content: interactiveViewsSection(directory), _context_source: DESKTOP_CONTEXT_SOURCE }] : [];
      return { ...request, messages: [request.messages[0]!, ...views, { role: "user", content: listing, _context_source: SKILLS_LISTING_SOURCE }, ...request.messages.slice(1)] };
    },
    afterTool(context, call, result) {
      observeRead(context.session as Row, call.name, call.id, result);
      return result;
    },
    completionInstructions(context) {
      const reminder = contextReminder(context.session as Row, !lightweight(context));
      return reminder ? [reminder] : [];
    },
  };
}

/** The bundled entry: tools read the state directory the host passes in `createSkills`. */
export const skills: BundledPlugin = createSkills({ stateDir: "", root: () => null });
