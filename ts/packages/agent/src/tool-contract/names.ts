/**
 * Model-visible tool names (ZCode v3.15.1, aac4755) and the Xueness tools behind them.
 *
 * The journal, Gate kinds, plugin manifests and the Python fallback keep the
 * Xueness names; only the model sees the ZCode names. A model that still calls
 * a Xueness name (an old session) is served as before: that is the alias.
 */
export const MODEL_TOOL_NAMES: Readonly<Record<string, string>> = Object.freeze({
  exec: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  glob: "Glob",
  grep: "Grep",
  todo_read: "TodoRead",
  todo_write: "TodoWrite",
  ask_user: "AskUserQuestion",
  exec_output: "TaskOutput",
  exec_kill: "TaskStop",
  exit_plan_mode: "ExitPlanMode",
  enter_plan_mode: "EnterPlanMode",
  apply_patch: "ApplyPatch",
  skill_read: "Skill",
  task: "Agent",
  reply_to_channel: "ReplyToChannel",
});

const INTERNAL_BY_MODEL: ReadonlyMap<string, string> = new Map(Object.entries(MODEL_TOOL_NAMES).map(([internal, model]) => [model, internal]));

/** The Xueness tool a model-visible name stands for (unchanged for other names). */
export function internalToolName(name: string): string {
  return INTERNAL_BY_MODEL.get(name) ?? name;
}

/** The name the model sees for a Xueness tool (unchanged for tools without a ZCode contract). */
export function modelToolName(name: string): string {
  return MODEL_TOOL_NAMES[name] ?? name;
}

export function isModelContractName(name: string): boolean {
  return INTERNAL_BY_MODEL.has(name);
}

/**
 * ZCode `provider-visible-order.ts`: the reference tools sorted by name, then
 * every other tool in registry order.
 */
const SORTED_PROVIDER_TOOL_NAMES = new Set([
  "Agent", "AskUserQuestion", "Bash", "CronCreate", "CronDelete", "CronList", "CronUpdate", "Edit", "EnterPlanMode",
  "EnterWorktree", "ExitPlanMode", "ExitWorktree", "Glob", "Grep", "LSP", "NotebookEdit", "Read", "ScheduleWakeup",
  "Skill", "TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate", "TodoRead", "TodoWrite",
  "WebFetch", "WebSearch", "Workflow", "Write",
]);

export function orderProviderVisibleTools<T>(tools: readonly T[], nameOf: (tool: T) => string): T[] {
  const reference: T[] = [];
  const local: T[] = [];
  for (const tool of tools) (SORTED_PROVIDER_TOOL_NAMES.has(nameOf(tool)) ? reference : local).push(tool);
  return [...reference.sort((a, b) => nameOf(a).localeCompare(nameOf(b))), ...local];
}
