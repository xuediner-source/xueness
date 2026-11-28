/**
 * Antigravity-style dynamic roster, title, and model discovery tools for both
 * the parent conversation and active swarm members (`swarm_add`, `swarm_title`,
 * `swarm_models`).
 */
import type { CapabilityDeclaration, JsonSchema } from "@xueness/contracts";
import type { ToolDefinition, ToolEnv, ToolResult } from "@xueness/engine-tools";
import { PlanError } from "./plan.ts";
import type { SwarmModelOption } from "./roster.ts";
import { SwarmServiceError, type SwarmService } from "./service.ts";
import type { SwarmRecord } from "./store.ts";
import { swarmSummary, type SwarmBinding } from "./tools.ts";

type Row = Record<string, unknown>;
const STATE: CapabilityDeclaration = { fs: { read: ["state"], write: ["state"] } };

const ok = (output: string, data?: unknown): ToolResult => ({ ok: true, output, ...(data === undefined ? {} : { data }) } as ToolResult);
const fail = (code: string, message: string): ToolResult => ({ ok: false, output: message, error: { code, message } } as ToolResult);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

async function guarded(action: () => ToolResult | Promise<ToolResult>): Promise<ToolResult> {
  try { return await action(); }
  catch (error) {
    if (error instanceof SwarmServiceError) return fail(error.status === 404 ? "not_found" : error.status === 403 ? "forbidden" : "swarm_refused", error.message);
    if (error instanceof PlanError) return fail("invalid_plan", error.message);
    throw error;
  }
}

const ADD_PROPERTIES: Record<string, JsonSchema> = {
  name: { type: "string", description: "Roster name (or base prefix when count/n/tasks is set), e.g. \"helper\" or \"shard\"." },
  task: { type: "string", description: "Assignment brief: what this worker owns and what done looks like." },
  tasks: { type: "array", items: { type: "string" }, description: "Optional per-worker slice targets (<name>-1..K) combined with task." },
  count: { type: "integer", minimum: 1, maximum: 6, description: "Optional homogeneous copy count (<name>-1..N)." },
  n: { type: "integer", minimum: 1, maximum: 6, description: "Alias for count (<name>-1..N)." },
  owns: { type: "array", description: "Workspace-relative paths (within approved scope)." },
  commands: { type: "array", items: { type: "string" }, description: "Allowed commands (within approved scope)." },
  groups: { type: "array", items: { type: "string" } },
  channels: { type: "array", items: { type: "string" } },
  fork: { type: "string", description: "Optional existing member name (or \"coordinator\") to warm-fork context from." },
  model: { description: "Optional \"inherit\" or {provider_id, model} from approved models." },
};

function formatModels(configured: readonly SwarmModelOption[], approved?: readonly { providerId: string; model: string | null }[]): Row {
  return {
    default: "inherit",
    ...(approved ? { approvedModels: approved } : {}),
    configuredModels: configured.map((item) => ({
      provider_id: item.providerId,
      model: item.model,
      ...(item.name ? { name: item.name } : {}),
      ...(item.source ? { source: item.source } : {}),
    })),
  };
}

export function parentRosterTools(binding: SwarmBinding, owned: (env: ToolEnv, id: unknown) => SwarmRecord): ToolDefinition[] {
  return [
    {
      name: "swarm_models",
      description: "List configured model profiles (including Magpie gateway models) that can be assigned in swarm_start or swarm_add.",
      inputSchema: { type: "object", additionalProperties: false, properties: { swarm_id: { type: "string" } } },
      gate: "planning", mutating: false, readOnly: true, concurrencySafe: true, requires: STATE,
      run: (input: Row, env: ToolEnv) => guarded(() => {
        const configured = binding.listModels?.() ?? [];
        const approved = input.swarm_id ? owned(env, input.swarm_id).approvedModels : undefined;
        const data = formatModels(configured, approved);
        const lines = configured.map((m) => `- { provider_id: "${m.providerId}", model: ${m.model ? `"${m.model}"` : "null"} }${m.name ? ` (${m.name})` : ""}`);
        return ok(lines.length ? `Available models:\n- "inherit" (current conversation model)\n${lines.join("\n")}` : "Available models: \"inherit\" (current conversation model).", data);
      }),
    },
    {
      name: "swarm_title",
      description: "Set or update the short UI title of a swarm in this conversation.",
      inputSchema: { type: "object", additionalProperties: false, required: ["swarm_id", "title"], properties: { swarm_id: { type: "string" }, title: { type: "string", maxLength: 120 } } },
      gate: "planning", mutating: false, readOnly: false, concurrencySafe: false, requires: STATE,
      run: (input: Row, env: ToolEnv) => guarded(() => {
        const record = owned(env, input.swarm_id);
        const updated = binding.service()!.setTitle(record.id, text(input.title), "parent");
        return ok(`Swarm ${updated.id} title set to "${updated.title}".`, { id: updated.id, title: updated.title });
      }),
    },
    {
      name: "swarm_add",
      description: "Add a worker (or sharded worker group via count/n/tasks) to an active swarm within its approved path/command/model scope, optionally forked from an existing member.",
      inputSchema: { type: "object", additionalProperties: false, required: ["swarm_id", "name"], properties: { swarm_id: { type: "string" }, ...ADD_PROPERTIES } },
      gate: "planning", mutating: false, readOnly: false, concurrencySafe: false, requires: STATE,
      run: (input: Row, env: ToolEnv) => guarded(() => {
        const record = owned(env, input.swarm_id);
        const updated = binding.service()!.addMember(record.id, {
          name: text(input.name),
          task: text(input.task) || undefined,
          tasks: Array.isArray(input.tasks) ? strings(input.tasks) : undefined,
          count: typeof input.count === "number" ? input.count : undefined,
          n: typeof input.n === "number" ? input.n : undefined,
          owns: Array.isArray(input.owns) ? input.owns : undefined,
          commands: Array.isArray(input.commands) ? strings(input.commands) : undefined,
          groups: Array.isArray(input.groups) ? strings(input.groups) : undefined,
          channels: Array.isArray(input.channels) ? strings(input.channels) : undefined,
          fork: text(input.fork) || undefined,
          model: input.model,
        }, "parent");
        return ok(`Swarm ${updated.id} now has ${updated.members.length} members.`, swarmSummary(updated));
      }),
    },
  ] as unknown as ToolDefinition[];
}

export function memberRosterTools(binding: SwarmBinding): ToolDefinition[] {
  const me = binding.member!;
  const service = (): SwarmService => { const value = binding.service(); if (!value) throw new SwarmServiceError(503, "the swarm service is unavailable"); return value; };
  const base = { gate: "planning", mutating: false, readOnly: false, concurrencySafe: false, alwaysLoad: true, requires: STATE };
  return [
    {
      ...base, name: "swarm_models", readOnly: true, concurrencySafe: true,
      description: "List models approved for this swarm (usable immediately with swarm_model or swarm_add) and configured host models.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      run: () => guarded(() => {
        const record = service().get(me.swarmId);
        const data = formatModels(binding.listModels?.() ?? [], record.approvedModels ?? []);
        const approved = (record.approvedModels ?? []).map((m) => `{ provider_id: "${m.providerId}", model: ${m.model ? `"${m.model}"` : "null"} }`);
        return ok(`Swarm models: "inherit"${approved.length ? `, ${approved.join(", ")}` : ""}.`, data);
      }),
    },
    {
      ...base, name: "swarm_title",
      description: "Coordinator only: set or update the short UI title of this swarm.",
      inputSchema: { type: "object", additionalProperties: false, required: ["title"], properties: { title: { type: "string", maxLength: 120 } } },
      run: (input: Row) => guarded(() => {
        const updated = service().setTitle(me.swarmId, text(input.title), me.name);
        return ok(`Swarm title updated to "${updated.title}".`);
      }),
    },
    {
      ...base, name: "swarm_add",
      description: "Spawn a new worker or helper (or sharded group via count/n/tasks) on the board within approved scope. Workers may spawn helpers within their own scope (a helper cannot own a path another member already owns) and may later kill or model-switch helpers they added; pass fork: \"<member>\" or \"coordinator\" to warm-fork context.",
      inputSchema: { type: "object", additionalProperties: false, required: ["name"], properties: ADD_PROPERTIES },
      run: (input: Row) => guarded(() => {
        const before = new Set(service().get(me.swarmId).members.map((m) => m.name));
        const updated = service().addMember(me.swarmId, {
          name: text(input.name),
          task: text(input.task) || undefined,
          tasks: Array.isArray(input.tasks) ? strings(input.tasks) : undefined,
          count: typeof input.count === "number" ? input.count : undefined,
          n: typeof input.n === "number" ? input.n : undefined,
          owns: Array.isArray(input.owns) ? input.owns : undefined,
          commands: Array.isArray(input.commands) ? strings(input.commands) : undefined,
          groups: Array.isArray(input.groups) ? strings(input.groups) : undefined,
          channels: Array.isArray(input.channels) ? strings(input.channels) : undefined,
          fork: text(input.fork) || undefined,
          model: input.model,
        }, me.name);
        const created = updated.members.filter((m) => !before.has(m.name)).map((m) => `@${m.name}`);
        return ok(`Added ${created.join(", ")} and posted assignment on the board.`);
      }),
    },
  ] as unknown as ToolDefinition[];
}
