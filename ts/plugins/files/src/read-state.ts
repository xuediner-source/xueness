import { isDict, pyJsonLoads } from "@xueness/contracts";
import type { AgentContext, AgentExtension } from "@xueness/agent";
import {
  FileStateTracker,
  resolveWorkspacePath,
  type FileSnapshot,
  type PersistedFileReadState,
  type ReadStateSourceTool,
} from "@xueness/engine-tools";
import { isAbsolute } from "node:path";

interface HistoricalToolCall {
  name: string;
}

const FILE_TOOLS = new Set<ReadStateSourceTool>(["read", "write", "edit"]);

/** Restores only successful file-tool snapshots stored on their paired journal tool messages. */
export function filesReadStateExtension(tracker: FileStateTracker): AgentExtension {
  return {
    id: "files",
    capabilities: ["files.read_state_restore"],
    async beforeRun(context) {
      tracker.clear();
      const messages = Array.isArray(context.session.messages) ? context.session.messages : [];
      const calls = new Map<string, HistoricalToolCall>();
      let adjacentCalls: HistoricalToolCall[] = [];
      let adjacentAssistantIndex = -1;
      let adjacentToolIndex = 0;

      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (!isDict(message)) {
          adjacentCalls = [];
          adjacentAssistantIndex = -1;
          continue;
        }

        if (message.role === "assistant") {
          adjacentCalls = [];
          adjacentAssistantIndex = index;
          adjacentToolIndex = 0;
          for (const call of (Array.isArray(message.tool_calls) ? message.tool_calls : []).filter(isDict)) {
            const fn = isDict(call.function) ? call.function : null;
            if (
              typeof call.id !== "string" ||
              !fn ||
              typeof fn.name !== "string" ||
              !FILE_TOOLS.has(fn.name as ReadStateSourceTool)
            ) {
              continue;
            }
            const historical = { name: fn.name };
            calls.set(call.id, historical);
            adjacentCalls.push(historical);
          }
          continue;
        }

        if (message.role === "tool") {
          const callId = typeof message.tool_call_id === "string" ? message.tool_call_id : undefined;
          const matched = callId
            ? calls.get(callId)
            : index === adjacentAssistantIndex + adjacentToolIndex + 1 && adjacentCalls.length === 1
              ? adjacentCalls[0]
              : undefined;
          adjacentToolIndex += 1;
          if (!matched || !successfulToolMessage(message.content)) continue;

          const readState = parseReadState(message._read_state);
          if (!readState || matched.name !== readState.sourceTool) continue;

          try {
            const resolved = await resolveWorkspacePath(readState.path, context.root, [context.root]);
            if (readState.sourceTool === "read" && readState.range) {
              tracker.forget(resolved.absolute);
            } else {
              tracker.restore(resolved.absolute, readState.snapshot);
            }
          } catch {
            // Historical paths outside the current workspace are not restored.
          }
          continue;
        }

        adjacentCalls = [];
        adjacentAssistantIndex = -1;
      }
    },
  };
}

function successfulToolMessage(content: unknown): boolean {
  if (typeof content !== "string") return false;
  try {
    const result: unknown = pyJsonLoads(content);
    return isDict(result) && result.ok === true;
  } catch {
    return false;
  }
}

function parseReadState(value: unknown): PersistedFileReadState | undefined {
  if (!isDict(value) || value.schema !== 1 || typeof value.path !== "string" || !isAbsolute(value.path)) {
    return undefined;
  }
  if (typeof value.sourceTool !== "string" || !FILE_TOOLS.has(value.sourceTool as ReadStateSourceTool)) {
    return undefined;
  }
  if (typeof value.range !== "boolean" || (value.sourceTool !== "read" && value.range)) return undefined;
  if (!isDict(value.snapshot)) return undefined;

  const snapshot = value.snapshot as Partial<FileSnapshot>;
  if (
    typeof snapshot.mtimeMs !== "number" || !Number.isFinite(snapshot.mtimeMs) ||
    typeof snapshot.size !== "number" || !Number.isSafeInteger(snapshot.size) || snapshot.size < 0 ||
    typeof snapshot.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(snapshot.sha256) ||
    typeof snapshot.partial !== "boolean"
  ) {
    return undefined;
  }

  return {
    schema: 1,
    path: value.path,
    sourceTool: value.sourceTool as ReadStateSourceTool,
    range: value.range,
    snapshot: {
      mtimeMs: snapshot.mtimeMs,
      size: snapshot.size,
      sha256: snapshot.sha256,
      partial: snapshot.partial,
    },
  };
}

