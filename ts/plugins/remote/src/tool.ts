/**
 * `remote_exec` tool. Argument checks that Python runs before Gate live in
 * `precheck` (the kernel authorizes only when precheck returns null). SSH runs
 * in `run`. A declared Windows host never reaches approval.
 */
import { pyJsonDumps, type JsonSchema } from "@xueness/contracts";
import { failure, type ToolDefinition, type ToolResult } from "@xueness/engine-tools";
import { RemoteValueError, SshClientUnavailableError, SshTimeoutError, prepareRemote, runRemoteExec, type RemoteExecArgs, type SshRunner } from "./exec.ts";
import type { Row } from "./handshake.ts";

export const REMOTE_EXEC_DESCRIPTION = "Run literal argv on a configured POSIX SSH host; trusted host key and exact action approval required. Connections declared system=windows (cmd or PowerShell) are refused.";

/** Published shape matches `BuiltinTool.schema()` (it adds additionalProperties false). */
const PARAMETERS: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    connection: { type: "string" },
    connection_digest: { type: "string" },
    argv: { type: "array", items: { type: "string" } },
  },
  required: ["connection", "connection_digest", "argv"],
};

function asResult(result: Row): ToolResult<Row> {
  const output = pyJsonDumps(result);
  if (result.ok === true) return { ok: true, output, data: result };
  const code = typeof result.error_code === "string" ? result.error_code : "command_failed";
  const message = typeof result.error === "string" ? result.error : "remote command failed";
  return { ok: false, output, data: result, error: { code, message } };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function remoteExecTool(options: { stateDir: string; runner?: SshRunner }): ToolDefinition<RemoteExecArgs, Row> {
  return {
    name: "remote_exec",
    description: REMOTE_EXEC_DESCRIPTION,
    inputSchema: PARAMETERS,
    modelSchema: PARAMETERS,
    gate: "exec",
    mutating: true,
    concurrencySafe: false,
    requires: { exec: ["*"], fs: { read: ["state"] } },
    subjectKind: "text",
    subject: (input) => pyJsonDumps(input, { sortKeys: true, separators: [",", ":"], ensureAscii: false }),
    precheck(input) {
      try {
        prepareRemote(options.stateDir, input);
        return null;
      } catch (error) {
        return failure("invalid_argument", messageOf(error));
      }
    },
    async run(input, env) {
      try {
        return asResult(await runRemoteExec(options.stateDir, env.cwd, input, options.runner));
      } catch (error) {
        if (error instanceof SshTimeoutError) return failure("timeout_expired", "TimeoutExpired");
        if (error instanceof SshClientUnavailableError) return failure("os_error", "OSError");
        if (error instanceof RemoteValueError) return failure("invalid_argument", error.message);
        return failure("invalid_argument", messageOf(error));
      }
    },
  };
}
