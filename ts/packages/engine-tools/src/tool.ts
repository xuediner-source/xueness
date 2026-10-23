/**
 * Tool contract shared by the engine tools.
 *
 * A tool validates its input against a JSON schema, runs inside a ToolEnv
 * (working directory, workspace roots, read tracker, artifact directory,
 * abort signal) and returns model-facing text plus structured data. Failures
 * are results with a stable code, not exceptions, so one bad call never ends
 * a run.
 */
import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { formatSchemaIssues, validateSchema, type CapabilityDeclaration, type JsonSchema } from "@xueness/contracts";
import { FileStateTracker, type PersistedFileReadState } from "./file-state.ts";

export interface NetworkActivityEvent {
  type: "network_request"; phase: "started" | "redirected" | "completed" | "failed" | "cache_hit";
  requestId: string; url?: string; redirects?: number; bytes?: number; errorCode?: string;
}

export interface ToolEnv {
  /** Bound by the network plugin for the active run. */
  onNetworkActivity?: (event: NetworkActivityEvent) => void;
  cwd: string;
  roots: readonly string[];
  tracker: FileStateTracker;
  /** Where full command output goes. Must be outside the workspace. */
  artifactsDir: string;
  signal?: AbortSignal;
  /** Who is calling (a session id); background tasks are only visible to their owner. */
  owner?: string;
  /** Host-bound result source; a child uses its own session even with a shared kernel. */
  currentSession?: () => Record<string, unknown> | null;
  /** What the selected model accepts besides text (Read attaches PDFs only with `pdf`). */
  modelInput?: { image?: boolean; pdf?: boolean };
}

/** An attachment for the model (Read's images, PDFs and PDF pages); `output` names it by placeholder. */
export interface ToolMedia {
  mimeType: string;
  /** Base64 bytes. */
  data: string;
  placeholder: string;
}

export interface ToolResult<D = unknown> {
  ok: boolean;
  /** Text returned to the model. */
  output: string;
  data?: D;
  error?: { code: string; message: string };
  /** User-facing reason shown when this result pauses the run (approval, permission refusal). */
  user_reason?: string;
  media?: ToolMedia[];
  /** Private session-journal metadata; the agent strips it from model-visible results. */
  _read_state?: PersistedFileReadState;
}

export interface ToolDefinition<I = Record<string, unknown>, D = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** What the model is shown when it differs from what the bridge validates (an MCP server's own schema). */
  modelSchema?: JsonSchema;
  /** Python Gate kind the call is checked under; must match the plugin manifest. */
  gate: string;
  /** Changes workspace files (checkpointed, refused in read-only modes). */
  mutating: boolean;
  /** A pure read that may run concurrently with other safe calls. */
  concurrencySafe: boolean;
  /** Powers the tool needs from its plugin's grant; the kernel refuses to register it otherwise. */
  requires: CapabilityDeclaration;
  /** What a permission decision is about: a path, a command, a task id. Defaults by gate kind. */
  subject?(input: I): string;
  /** Every workspace path a multi-file call touches. Each is resolved and authorized on its own; takes precedence over `subject`. */
  subjectPaths?(input: I): string[];
  /** How permission rules read the subject: a shell command line, a workspace path or plain text. Defaults by gate kind. */
  subjectKind?: "command" | "path" | "text";
  /** A refusal made before any permission check (Python validates some arguments before its Gate); null lets the call through. */
  precheck?(input: I): ToolResult<D> | null;
  run(input: I, env: ToolEnv): Promise<ToolResult<D>>;
}

/** What the read-only and the writing file tools need. */
export const READS_WORKSPACE: CapabilityDeclaration = Object.freeze({ fs: Object.freeze({ read: Object.freeze(["workspace"] as const) }) });
export const WRITES_WORKSPACE: CapabilityDeclaration = Object.freeze({ fs: Object.freeze({ write: Object.freeze(["workspace"] as const) }) });

export class ArtifactsInsideWorkspaceError extends Error {
  override name = "ArtifactsInsideWorkspaceError";
  readonly code = "invalid_argument";
}

/** True when `path` is `root` or inside it (lexical check on absolute paths). */
export function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function createToolEnv(options: { cwd: string; roots?: readonly string[]; artifactsDir: string; signal?: AbortSignal; owner?: string }): ToolEnv {
  const roots = options.roots ?? [options.cwd];
  const inside = roots.find((root) => isInside(root, options.artifactsDir));
  if (inside) throw new ArtifactsInsideWorkspaceError(`artifacts directory must be outside the workspace (${inside})`);
  const env: ToolEnv = {
    cwd: options.cwd,
    roots,
    tracker: new FileStateTracker(),
    artifactsDir: options.artifactsDir,
  };
  if (options.signal) env.signal = options.signal;
  if (options.owner !== undefined) env.owner = options.owner;
  return env;
}

export function failure(code: string, message: string): ToolResult<never> {
  return { ok: false, output: message, error: { code, message } };
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[a-z_]+$/.test(code)) return code;
  if (typeof code === "string" && code === "ENOENT") return "not_found";
  if (typeof code === "string" && code === "EISDIR") return "is_directory";
  if (typeof code === "string" && (code === "EACCES" || code === "EPERM")) return "permission_denied";
  if (error instanceof TypeError || error instanceof SyntaxError) return "invalid_argument";
  return "tool_failed";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `stat` that returns null for a missing path. */
export async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Run a tool with input validation and uniform error results. */
export async function runTool<I, D>(tool: ToolDefinition<I, D>, input: unknown, env: ToolEnv): Promise<ToolResult<D>> {
  const issues = validateSchema(tool.inputSchema, input);
  if (issues.length) return failure("invalid_argument", `invalid ${tool.name} input: ${formatSchemaIssues(issues)}`);
  if (env.signal?.aborted) return failure("cancelled", `${tool.name} cancelled`);
  try {
    return await tool.run(input as I, env);
  } catch (error) {
    const code = errorCodeOf(error);
    return failure(code, messageOf(error));
  }
}
