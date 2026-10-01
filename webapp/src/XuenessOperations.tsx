/** Compatibility facade for integrations that used the former shared operations module. */
import React from "react";
import { XuenessMcpTools } from "./plugins/mcp";
export { WorkflowPanel } from "./plugins/workflows";
export { OperationStatus } from "./plugins/shared";
export { ModelManager } from "./plugins/providers";
export { TerminalPanel } from "./plugins/terminal";
export function McpDiagnostics(_props: { root: string }): React.ReactElement {
  return React.createElement(XuenessMcpTools);
}
