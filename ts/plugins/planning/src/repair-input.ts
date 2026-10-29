/** Execution-input failures are not failed program assertions. */
import { isDict } from "@xueness/contracts";
import type { Row } from "@xueness/agent";

export function executionInputFailure(result: Row): boolean {
  const error = isDict(result.error) ? result.error : {};
  const code = String(result.error_code ?? error.code ?? "");
  return ["invalid_argument", "invalid_tool_arguments", "command_not_found", "command_prepare_failed"].includes(code)
    || /FullyQualifiedErrorId\s*:\s*InvalidEndOfLine|CommandNotFoundException|ParserError[^\n]*\n|syntax error near unexpected token/i.test(String(result.output ?? ""));
}

export function codeChange(call: { name: string; input?: unknown }): boolean {
  if (!["write", "edit"].includes(call.name) || !isDict(call.input) || typeof call.input.path !== "string") return false;
  return /\.(?:[cm]?[jt]sx?|py|go|rs|[ch](?:pp)?|java|kt|cs|sh|ps1|rb|php|swift)$/i.test(call.input.path);
}
