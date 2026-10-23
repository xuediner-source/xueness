/**
 * ZCode v3.15.1 (aac4755, Apache-2.0) Skill tool contract: description from
 * `core/src/tool/handlers/skill.ts` (the plugin-namespace sentence dropped: Xueness
 * has no plugin-qualified skills), schema from `contracts/src/tools/skill.ts`.
 * The Xueness tool is `skill_read` (`id` = exact skill name or catalog id).
 */
import type { JsonSchema } from "@xueness/contracts";
import type { InputAdapter } from "./adapters.ts";

export const SKILL_DESCRIPTION = "Execute a skill within the main conversation\n\nWhen users ask you to perform tasks, check if any of the available skills match. Skills provide specialized capabilities and domain knowledge.\n\nWhen users reference a \"slash command\" or \"/<something>\", they are referring to a skill. Use this tool to invoke it.\n\nHow to invoke:\n- Set `skill` to the exact name of an available skill (no leading slash).\n- Set `args` to pass optional arguments.\n\nImportant:\n- Available skills are listed in system-reminder messages in the conversation\n- Only invoke a skill that appears in that list, or one the user explicitly typed as `/<name>` in their message. Never guess or invent a skill name from training data; otherwise do not call this tool\n- When a skill matches the user's request, this is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task\n- NEVER mention a skill without actually calling this tool\n- Do not invoke a skill that is already running\n- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)\n- If you see a <command-name> tag in the current conversation turn, the skill has ALREADY been loaded - follow the instructions directly instead of calling this tool again\n";

export const SKILL_SCHEMA = {
 "type": "object",
 "properties": {
  "skill": {
   "type": "string",
   "description": "The name of a skill from the available-skills list. Do not guess names."
  },
  "args": {
   "type": "string",
   "description": "Optional arguments for the skill"
  }
 },
 "required": [
  "skill"
 ],
 "additionalProperties": false
} as unknown as JsonSchema;

/** `skill` (or ZCode's legacy `name`) is the lookup key; `args` has no Xueness counterpart yet. */
export const skillAdapter: InputAdapter = {
  toInternal(input) {
    const key = typeof input.skill === "string" ? input.skill : typeof input.name === "string" ? input.name : "";
    return key.trim() ? { id: key.trim().replace(/^\//, "") } : { error: "<tool_use_error>Missing required parameter: skill</tool_use_error>" };
  },
  toModel(input) {
    return { skill: typeof input.id === "string" ? input.id : "" };
  },
};
