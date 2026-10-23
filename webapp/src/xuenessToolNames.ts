/**
 * Tool names: the journal and the event stream use the Xueness names (they
 * are also Gate kinds and permission subjects); the model sees the ZCode
 * names (Step 3 contract layer, ts/packages/agent/src/tool-contract/names.ts).
 * The UI maps a ZCode name back to the Xueness one before choosing a renderer
 * or a label, so either spelling shows the same row.
 */
export const MODEL_TOOL_NAMES: Readonly<Record<string, string>> = Object.freeze({
  exec: "Bash", read: "Read", write: "Write", edit: "Edit", glob: "Glob", grep: "Grep",
  todo_read: "TodoRead", todo_write: "TodoWrite", ask_user: "AskUserQuestion",
  exec_output: "TaskOutput", exec_kill: "TaskStop", exit_plan_mode: "ExitPlanMode", enter_plan_mode: "EnterPlanMode",
  apply_patch: "ApplyPatch", skill_read: "Skill", task: "Agent",
});

const INTERNAL_BY_MODEL: ReadonlyMap<string, string> = new Map(Object.entries(MODEL_TOOL_NAMES).map(([internal, model]) => [model, internal]));

/** The Xueness name for a ZCode model name; any other name unchanged. */
export function internalToolName(name: string): string {
  return INTERNAL_BY_MODEL.get(name) ?? name;
}

/** The ZCode name the model used for a Xueness tool; any other name unchanged. */
export function modelToolName(name: string): string {
  return MODEL_TOOL_NAMES[name] ?? name;
}
