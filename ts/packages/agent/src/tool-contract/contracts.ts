/**
 * Model contracts for the core tools: the ZCode v3.15.1 (aac4755, Apache-2.0)
 * name, description and input schema the model sees for each Xueness tool
 * (ZCode `core/src/tool/model-contract.ts`), and how a failure reads.
 */
import type { JsonSchema } from "@xueness/contracts";
import { ADAPTERS, type InputAdapter } from "./adapters.ts";
import { APPLY_PATCH_DESCRIPTION, APPLY_PATCH_SCHEMA } from "./apply-patch-contract.ts";
import { SKILL_DESCRIPTION, SKILL_SCHEMA } from "./skill-contract.ts";
import { AGENT_DESCRIPTION, AGENT_SCHEMA } from "./agent-contract.ts";
import * as D from "./descriptions.ts";
import { MODEL_TOOL_NAMES } from "./names.ts";
import * as F from "./schemas-files.ts";
import * as O from "./schemas-other.ts";
import { globText, grepText } from "./search-results.ts";
import { taskOutputText, taskStopText, todoReadText, todoWriteText, unknownTaskText } from "./task-results.ts";

export interface ToolContract extends InputAdapter {
  readonly internal: string;
  readonly model: string;
  readonly description: string;
  readonly schema: JsonSchema;
  /** Fields ZCode coerces before validation (`semanticNumber` / `semanticBoolean`). */
  readonly numbers?: readonly string[];
  readonly booleans?: readonly string[];
  /** Error codes whose output is already the model text (Bash's `Exit code N` result), not a `<tool_use_error>`. */
  readonly plainErrors?: ReadonlySet<string>;
  /** ZCode model text built from a successful result's data, when the plain output is not it. */
  readonly render?: (data: unknown, input: Record<string, unknown> | null, output: string) => string | undefined;
  /** ZCode model text for a failure code, built from the call input. */
  readonly renderError?: Readonly<Record<string, (input: Record<string, unknown> | null) => string | undefined>>;
}

const SPEC: Readonly<Record<string, Pick<ToolContract, "description" | "schema" | "numbers" | "booleans" | "plainErrors" | "render" | "renderError">>> = {
  exec: { description: D.BASH_DESCRIPTION, schema: O.BASH_SCHEMA, numbers: ["timeout"], booleans: ["run_in_background", "dangerouslyDisableSandbox"],
    plainErrors: new Set(["command_failed", "command_timeout", "command_cancelled", "command_not_found"]) },
  read: { description: D.READ_DESCRIPTION, schema: F.READ_SCHEMA },
  write: { description: D.WRITE_DESCRIPTION, schema: F.WRITE_SCHEMA },
  edit: { description: D.EDIT_DESCRIPTION, schema: F.EDIT_SCHEMA },
  glob: { description: D.GLOB_DESCRIPTION, schema: F.GLOB_SCHEMA, render: (data) => globText(data) },
  grep: { description: D.GREP_DESCRIPTION, schema: F.GREP_SCHEMA, render: grepText },
  todo_read: { description: D.TODOREAD_DESCRIPTION, schema: O.TODOREAD_SCHEMA, render: (data) => todoReadText(data) },
  todo_write: { description: D.TODOWRITE_DESCRIPTION, schema: O.TODOWRITE_SCHEMA, render: (data) => todoWriteText(data) },
  ask_user: { description: D.ASKUSERQUESTION_DESCRIPTION, schema: O.ASKUSERQUESTION_SCHEMA },
  exec_output: { description: D.TASKOUTPUT_DESCRIPTION, schema: O.TASKOUTPUT_SCHEMA, numbers: ["timeout"], booleans: ["block"],
    render: taskOutputText, renderError: { unknown_task: unknownTaskText } },
  exec_kill: { description: D.TASKSTOP_DESCRIPTION, schema: O.TASKSTOP_SCHEMA, render: (data) => taskStopText(data), renderError: { unknown_task: unknownTaskText } },
  exit_plan_mode: { description: D.EXITPLANMODE_DESCRIPTION, schema: O.EXITPLANMODE_SCHEMA },
  enter_plan_mode: { description: D.ENTERPLANMODE_DESCRIPTION, schema: O.ENTERPLANMODE_SCHEMA },
  apply_patch: { description: APPLY_PATCH_DESCRIPTION, schema: APPLY_PATCH_SCHEMA },
  skill_read: { description: SKILL_DESCRIPTION, schema: SKILL_SCHEMA },
  task: { description: AGENT_DESCRIPTION, schema: AGENT_SCHEMA },
};

export const TOOL_CONTRACTS: ReadonlyMap<string, ToolContract> = new Map(Object.entries(SPEC).map(([internal, spec]) => {
  const adapter = ADAPTERS[internal]!;
  return [internal, { internal, model: MODEL_TOOL_NAMES[internal]!, ...spec, toInternal: adapter.toInternal, toModel: adapter.toModel }];
}));

/** The contract of a Xueness tool name or of its model-visible name. */
export function contractFor(name: string): ToolContract | undefined {
  return TOOL_CONTRACTS.get(name) ?? [...TOOL_CONTRACTS.values()].find((contract) => contract.model === name);
}
