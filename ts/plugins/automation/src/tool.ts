/**
 * The `offpeak_create` model tool (Python `automation/off_peak.py` `_create` +
 * `TOOLS`).
 *
 * It queues a prompt for the local idle window in the session's workspace.
 * Nothing here grants a capability: the queued run still needs the operator's
 * approval of the immutable plan digest, and the host still decides whether a
 * real provider may be called at all.
 */
import { isDict, pyJsonDumps, PyValueError } from "@xueness/contracts";
import type { CapabilityDeclaration, JsonSchema } from "@xueness/contracts";
import type { ToolDefinition, ToolResult } from "@xueness/engine-tools";
import { OffPeakQueue } from "./off-peak-queue.ts";
import { isDirectory, MAX_MODEL_TEXT, MAX_NAME, MAX_PROMPT, pick, QUEUED, requireEnabled, resolvePath, type Row } from "./off-peak.ts";

/** Reads the workspace root and writes the queue; the eventual run is the scheduler's. */
const REQUIRES: CapabilityDeclaration = { fs: { read: ["workspace"], write: ["state"] } };

export interface OffPeakToolOptions {
  stateDir: string;
}

/** `_subject`: `json.dumps(args, ensure_ascii=False, sort_keys=True, separators=(",", ":")).` */
const subject = (args: Row): string => pyJsonDumps(args, { ensureAscii: false, sortKeys: true, separators: [",", ":"] });

const text = (description: string, maximum: number, minLength = 0): JsonSchema =>
  ({ type: "string", minLength, maxLength: maximum, description });

export function offPeakCreateTool(options: OffPeakToolOptions): ToolDefinition {
  return {
    name: "offpeak_create",
    description: "Queue a non-urgent task for off-peak execution in this session workspace: it runs unattended "
      + "inside the locally configured idle window once the operator approves the plan. Use only when "
      + "the user explicitly asks for idle-time/off-peak execution; there is no guaranteed start time.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        prompt: text("What the deferred run must deliver; never ask it to schedule more tasks", MAX_PROMPT, 1),
        name: text("Short task title", MAX_NAME),
        model: text("Optional model id override", MAX_MODEL_TEXT),
      },
      required: ["prompt"],
    },
    gate: "exec",
    mutating: true,
    concurrencySafe: false,
    requires: REQUIRES,
    subject,
    precheck(): ToolResult | null {
      // Python validates the plugin switch before its Gate: a disabled plugin
      // must not become an approval prompt.
      requireEnabled(options.stateDir);
      return null;
    },
    async run(input, env): Promise<ToolResult<Row>> {
      const workspace = resolvePath(env.cwd);
      if (!isDirectory(workspace)) throw new PyValueError("session workspace is unavailable");
      const queue = new OffPeakQueue(options.stateDir);
      const row = queue.add({
        prompt: input.prompt,
        name: input.name,
        root: workspace,
        model: input.model,
        confirm: false,
      });
      const position = queue.list().filter((item) => isDict(item) && pick(item, "status") === QUEUED).length;
      const data: Row = {
        ok: true, task: row, queuePosition: position,
        note: "任务已排入闲时队列；操作员在「自动化 → 闲时任务」批准计划后才会无人值守执行。",
      };
      return { ok: true, output: pyJsonDumps(data), data };
    },
  };
}

/** §3.9 name kept alongside the §3.10 name for callers that use either. */
export const offPeakTool = offPeakCreateTool;
