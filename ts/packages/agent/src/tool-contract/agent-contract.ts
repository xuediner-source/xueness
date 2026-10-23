/**
 * ZCode v3.15.1 (aac4755, Apache-2.0) Agent tool contract: description from
 * `core/src/tool/handlers/agent.ts` (`buildAgentProviderDescription` with the
 * dynamic workflow line off), schema from `contracts/src/tools/agent.ts`.
 * Xueness changes: no SendMessage and no background launch yet, so those
 * lines and `run_in_background` are dropped; definitions come from the
 * settings page instead of `.zcode/agents/*.md`; every agent is read-only.
 * The Xueness tool is `task` (`prompt`, optional `agent`), as in Python.
 */
import type { JsonSchema } from "@xueness/contracts";
import type { InputAdapter } from "./adapters.ts";

export const AGENT_DESCRIPTION = [
  "Launch a new agent to handle complex, multi-step tasks. Each agent type has specific capabilities and tools available to it.",
  "",
  "Available agent types are listed in <system-reminder> messages in the conversation.",
  "",
  "When using the Agent tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.",
  "",
  "## When to use",
  "",
  "Reach for this when the task matches an available agent type, when you have independent work to delegate, or when answering would mean reading across several files — delegate it and you keep the conclusion, not the file dumps. For a single-fact lookup where you already know the file, symbol, or value, search directly. Once you've delegated a search, don't also run it yourself — wait for the result.",
  "",
  "- The agent's final message is returned to you as the tool result; it is not shown to the user — relay what matters.",
  "- A new Agent call starts fresh: the agent does not see this conversation, so put everything it needs in the prompt.",
  "- Agents are read-only: they inspect and report, and cannot edit files, run state-changing commands or launch further agents.",
  "- Each agent type's model and tools come from its definition (the subagent settings).",
].join("\n");

export const AGENT_SCHEMA = {
 "type": "object",
 "properties": {
  "description": {
   "type": "string",
   "description": "A short (3-5 word) description of the task"
  },
  "prompt": {
   "type": "string",
   "description": "The task for the agent to perform"
  },
  "subagent_type": {
   "type": "string",
   "description": "The type of specialized agent to use for this task"
  }
 },
 "required": [
  "description",
  "prompt"
 ],
 "additionalProperties": false
} as unknown as JsonSchema;

/** `subagent_type` selects the stored agent (Python `agent`); `description` is the run label. */
export const agentAdapter: InputAdapter = {
  toInternal(input) {
    const out: Record<string, unknown> = { prompt: input.prompt };
    if (typeof input.subagent_type === "string" && input.subagent_type.trim()) out.agent = input.subagent_type.trim();
    if (typeof input.description === "string" && input.description.trim()) out.description = input.description.trim();
    return out;
  },
  toModel(input) {
    return { description: typeof input.description === "string" ? input.description : "", prompt: typeof input.prompt === "string" ? input.prompt : "",
      ...(typeof input.agent === "string" ? { subagent_type: input.agent } : {}) };
  },
};
