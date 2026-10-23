export const NATIVE_OPS_NAMES = Object.freeze([
  "inspect_local_file", "grep", "glob", "replace", "write_file", "edit_file", "diff", "stat",
  "copy", "move", "remove", "read_files", "read_table", "read_docx", "read_pdf",
] as const);

export type NativeOpsRawName = typeof NATIVE_OPS_NAMES[number];
export const NATIVE_OPS_TOOL_NAMES = Object.freeze(NATIVE_OPS_NAMES.map((name) => `xops_${name}`));
export const NATIVE_OPS_DISCOVERY_NAME = "xops_discover_tools";
export const NATIVE_OPS_DEFAULT_SELECTED = Object.freeze(["xops_read_files", NATIVE_OPS_DISCOVERY_NAME]);
export const NATIVE_OPS_MUTATIONS: ReadonlySet<NativeOpsRawName> = new Set([
  "replace", "write_file", "edit_file", "copy", "move", "remove",
]);

export interface NativeOpsToolSchema {
  inputSchema: Record<string, unknown>;
  description: string;
  outputSchema: Record<string, unknown>;
}

export interface NativeOpsSchemas {
  rawNames: NativeOpsRawName[];
  referenceSchema: Record<string, unknown>;
  tools: Record<NativeOpsRawName, NativeOpsToolSchema>;
}

export interface NativeOpsBinding {
  /** Session-scoped offered tools. The `__default__` entry is a template only. */
  selected: Map<string, Set<string>>;
  selectedFor(owner?: string): Set<string>;
  select(owner: string | undefined, names: readonly string[]): string[];
}

export interface NativeWorkerError {
  code?: string;
  message?: string;
  effectState?: string;
  nextAction?: string;
}

export interface NativeWorkerResult extends Record<string, unknown> {
  status?: string;
  error?: NativeWorkerError;
}
