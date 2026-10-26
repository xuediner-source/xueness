/**
 * Session-scoped persistent Node REPL (F12.01).
 *
 * Each session owns one vm context: variables, helpers and imported modules
 * survive across calls, `reset` swaps in a brand-new context (true isolation),
 * and every run is bounded by a timeout so an infinite loop settles as a
 * `tool_timeout` result instead of hanging the run. Code runs with the host's
 * own privileges — the tool therefore declares the full-exec capability, and
 * callers should treat a REPL call like an exec call.
 *
 * Host capability ports: the sandbox gets a capturing console (output), a
 * `nodeImport(name)` shim plus dynamic `import()` (modules), the ToolEnv abort
 * signal is honoured before and after each call, and the manager's dispose
 * drops every session when the owning scope is torn down.
 */
import { createHash } from "node:crypto";
import vm from "node:vm";
import { join } from "node:path";
import { failure, type ToolDefinition, type ToolEnv, type ToolResult } from "./tool.ts";

export const REPL_DEFAULT_TIMEOUT_MS = 10_000;
export const REPL_MAX_TIMEOUT_MS = 60_000;
const MAX_SESSIONS = 16;
const MAX_SESSIONS_MESSAGE = "too many repl sessions";
const MAX_OUTPUT_CHARS = 20_000;
const MAX_RESULT_CHARS = 4_000;

export type ReplRunOutcome =
  | { ok: true; value: string; kind: string; lines: string[]; durationMs: number }
  | { ok: false; code: "invalid_argument" | "tool_timeout" | "cancelled" | "tool_failed"; message: string; lines: string[]; durationMs: number };

export interface ReplSessionInfo {
  id: string;
  owner: string;
  /** Bumped on every reset; results carry it so stale responses are visible. */
  epoch: number;
  createdAt: string;
  lastUsedAt: string;
  calls: number;
}

interface SessionState {
  owner: string;
  epoch: number;
  createdAt: number;
  lastUsedAt: number;
  calls: number;
  context: vm.Context;
}

/** Values a sandboxed result may never leak through: functions stay named, host objects get classified. */
export function formatReplValue(value: unknown, depth = 0, seen = new Set<unknown>()): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") return JSON.stringify(value.length > MAX_RESULT_CHARS ? `${value.slice(0, MAX_RESULT_CHARS)}…` : value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return `[Function: ${value.name || "anonymous"}]`;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    try {
      if (value instanceof Map) {
        const body = [...value.entries()].slice(0, 20).map(([k, v]) => `${formatReplValue(k, depth + 1, seen)} => ${formatReplValue(v, depth + 1, seen)}`).join(", ");
        return `Map(${value.size}) {${body ? ` ${body} ` : ""}}`;
      }
      if (value instanceof Set) {
        const body = [...value.values()].slice(0, 20).map((v) => formatReplValue(v, depth + 1, seen)).join(", ");
        return `Set(${value.size}) {${body ? ` ${body} ` : ""}}`;
      }
      if (value instanceof Date) return value.toISOString();
      if (value instanceof RegExp) return String(value);
      if (value instanceof Promise) return "Promise { … }";
      if (depth >= 3) return Array.isArray(value) ? `Array(${value.length})` : "{ … }";
      if (Array.isArray(value)) return `[${value.slice(0, 50).map((item) => formatReplValue(item, depth + 1, seen)).join(", ")}${value.length > 50 ? ", …" : ""}]`;
      const name = value.constructor?.name;
      const prefix = name && name !== "Object" ? `${name} ` : "";
      const entries = Object.entries(value as Record<string, unknown>).slice(0, 30);
      const body = entries.map(([k, v]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${formatReplValue(v, depth + 1, seen)}`).join(", ");
      const tail = Object.keys(value as object).length > 30 ? ", …" : "";
      return body ? `${prefix}{ ${body}${tail} }` : `${prefix}{}`;
    } catch {
      return "[Unserializable]";
    } finally {
      seen.delete(value);
    }
  }
  return String(value);
}

function sandboxConsole(capture: string[]) {
  const push = (prefix: string) => (...args: unknown[]) => {
    const text = args.map((arg) => (typeof arg === "string" ? arg : formatReplValue(arg))).join(" ");
    capture.push(prefix ? `${prefix} ${text}` : text);
  };
  return { log: push(""), info: push(""), warn: push("warning:"), error: push("error:"), debug: push("") };
}

export class ReplError extends Error {
  override name = "ReplError";
  readonly code: string;
  constructor(code: "too_many_sessions" | "unknown_session" | "sessions_closed", message: string) {
    super(message);
    this.code = code;
  }
}

export interface ReplRunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Reset the session (fresh context) before running this code. */
  reset?: boolean;
}

/** Manager of per-session REPL contexts; one per owning scope, disposed with it. */
export class ReplSessions {
  readonly #sessions = new Map<string, SessionState>();
  #closed = false;
  #hooks: (() => void)[] = [];

  info(owner: string): ReplSessionInfo {
    const state = this.#require(owner);
    return describe(owner, state);
  }

  /** The session's info when it exists; a cancelled first call never creates one. */
  peek(owner: string): ReplSessionInfo | undefined {
    const state = this.#sessions.get(owner);
    return state ? describe(owner, state) : undefined;
  }

  list(): ReplSessionInfo[] {
    return [...this.#sessions.entries()].map(([owner, state]) => describe(owner, state)).sort((a, b) => a.owner.localeCompare(b.owner));
  }

  /** Drop the session's context; the next call starts from a clean slate. */
  reset(owner: string): ReplSessionInfo {
    const state = this.#require(owner);
    this.#sessions.set(owner, createContext(this, owner, state.epoch + 1));
    return this.info(owner);
  }

  /** Host capability port: resources a session's code grabbed for cleanup at dispose time. */
  onDispose(hook: () => void): void {
    this.#hooks.push(hook);
  }

  async run(owner: string, code: string, options: ReplRunOptions = {}): Promise<ReplRunOutcome> {
    if (this.#closed) throw new ReplError("sessions_closed", "repl sessions are closed");
    if (options.signal?.aborted) return { ok: false, code: "cancelled", message: "repl run cancelled", lines: [], durationMs: 0 };
    const timeoutMs = Math.min(options.timeoutMs ?? REPL_DEFAULT_TIMEOUT_MS, REPL_MAX_TIMEOUT_MS);
    if (options.reset) this.#sessions.delete(owner);
    const state = this.#sessions.get(owner) ?? this.#create(owner);
    const capture: string[] = [];
    (state.context as { console?: unknown }).console = sandboxConsole(capture);
    const beganAt = performance.now();
    try {
      const script = new vm.Script(wrapForRepl(code), {
        filename: join(process.cwd(), `.xueness-repl-${createHash("sha256").update(owner).digest("hex").slice(0, 16)}-${state.epoch}-${state.calls + 1}.mjs`),
        importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
      });
      const value = await settle(script.runInContext(state.context, { timeout: timeoutMs, displayErrors: true }), timeoutMs);
      state.calls += 1;
      state.lastUsedAt = Date.now();
      return { ok: true, value: formatReplValue(value), kind: describeKind(value), lines: capture, durationMs: performance.now() - beganAt };
    } catch (error) {
      state.calls += 1;
      state.lastUsedAt = Date.now();
      const durationMs = performance.now() - beganAt;
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      const lines = capture.length > MAX_OUTPUT_CHARS ? [...capture.slice(0, 10), "… output truncated …"] : capture;
      const code2 = error instanceof SyntaxError ? "invalid_argument" : message.includes("Script execution timed out") ? "tool_timeout" : "tool_failed";
      return { ok: false, code: code2, message, lines, durationMs };
    }
  }

  disposeSession(owner: string): boolean {
    return this.#sessions.delete(owner);
  }

  dispose(): void {
    this.#closed = true;
    this.#sessions.clear();
    for (const hook of this.#hooks.splice(0)) {
      try {
        hook();
      } catch {
        // A misbehaving cleanup hook never blocks the rest of teardown.
      }
    }
  }

  #require(owner: string): SessionState {
    const state = this.#sessions.get(owner);
    if (!state) throw new ReplError("unknown_session", `no repl session for ${owner}`);
    return state;
  }

  #create(owner: string): SessionState {
    if (this.#sessions.size >= MAX_SESSIONS) throw new ReplError("too_many_sessions", `${MAX_SESSIONS_MESSAGE} (max ${MAX_SESSIONS})`);
    const state = createContext(this, owner, 1);
    this.#sessions.set(owner, state);
    return state;
  }
}

function describe(owner: string, state: SessionState): ReplSessionInfo {
  return { id: replSessionId(owner, state.epoch), owner, epoch: state.epoch, createdAt: new Date(state.createdAt).toISOString(), lastUsedAt: new Date(state.lastUsedAt).toISOString(), calls: state.calls };
}

function describeKind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function replSessionId(owner: string, epoch: number): string {
  return `repl-${createHash("sha256").update(`${owner}:${epoch}`).digest("hex").slice(0, 12)}`;
}

const TOP_LEVEL_AWAIT = /(^|[^\w.$])await[\s(]/;
const STATEMENT_KEYWORDS = /^(?:const|let|var|function\*?|class|if|for|while|do|switch|try|return|throw|break|continue|debugger|with|export)[\s({;]/;
const CONTINUATION_TAIL = /(?:[+\-*/%=<>&|?!,:~^(\[]|\b(?:typeof|instanceof|in|of|new|delete|void|await|yield|case|do|else))$/;

/**
 * Classic vm scripts already give both halves of the persistence contract for
 * free: top-level const/let live in the context's shared lexical environment
 * and the script's completion value is the last statement's value. They cannot
 * await, though — code that does runs inside an async IIFE instead, with
 * top-level const/let rewritten into context-global assignments so bindings
 * survive exactly like the sync path's, and the trailing expression captured
 * as the wrapper's return value.
 */
export function wrapForRepl(code: string): string {
  if (!TOP_LEVEL_AWAIT.test(code)) return code;
  const body = code.replace(/(^|[\n;])[ \t]*(?:const|let)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=/g, "$1$2 =");
  const tail = trailingExpression(body);
  if (!tail) return `(async () => {\n${body}\n})()`;
  const head = body.slice(0, tail.index).trimEnd().replace(/[; \t]+$/, "");
  if (CONTINUATION_TAIL.test(head)) return `(async () => {\n${body}\n})()`;
  return `(async () => {\n${head}\nreturn (${tail.source});\n})()`;
}

/** The final top-level statement of `code` when it is a plain expression, else null. */
export function trailingExpression(code: string): { index: number; source: string } | null {
  let depth = 0;
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;
  let blockComment = false;
  let lineComment = false;
  let boundary = -1;
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    const next = code[i + 1] ?? "";
    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "/" && next === "/") {
      lineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") {
      depth += 1;
      continue;
    }
    if (ch === ")" || ch === "}" || ch === "]") {
      depth -= 1;
      continue;
    }
    if (depth === 0 && (ch === ";" || ch === "\n")) boundary = i;
  }
  const candidate = code.slice(boundary + 1).replace(/\/\/[^\n]*$/, "").trim();
  if (!candidate || STATEMENT_KEYWORDS.test(candidate)) return null;
  return { index: boundary + 1, source: candidate };
}

/** vm's own timeout only guards synchronous execution; a promise that never settles is cut here. */
async function settle(value: unknown, timeoutMs: number): Promise<unknown> {
  if (typeof (value as { then?: unknown } | null)?.then !== "function") return value;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Script execution timed out.")), timeoutMs);
    timer.unref?.();
    Promise.resolve(value as PromiseLike<unknown>).then(
      (settled) => {
        clearTimeout(timer);
        resolve(settled);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function createContext(manager: ReplSessions, owner: string, epoch: number): SessionState {
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: true, wasm: false } });
  const prepare = (globalObject: Record<string, unknown>) => {
    globalObject.console = sandboxConsole([]);
    globalObject.globalThis = globalObject;
    globalObject.nodeImport = async (name: string) => import(name);
    globalObject.nodeReset = () => manager.reset(owner);
    globalObject.session = { owner, epoch };
  };
  prepare(context as unknown as Record<string, unknown>);
  return { owner, epoch, createdAt: Date.now(), lastUsedAt: Date.now(), calls: 0, context };
}

export interface NodeReplInput {
  code: string;
  session?: string;
  timeout_ms?: number;
  reset?: boolean;
}

export interface NodeReplData {
  session_id: string;
  owner: string;
  epoch: number;
  ok: boolean;
  result?: string;
  result_kind?: string;
  error_code?: string;
  output_lines: string[];
  duration_ms: number;
}

export interface NodeReplOptions {
  sessions?: ReplSessions;
  defaultTimeoutMs?: number;
}

export function createNodeReplTool(options: NodeReplOptions = {}): ToolDefinition<NodeReplInput, NodeReplData> {
  const sessions = options.sessions ?? new ReplSessions();
  return {
    name: "node_repl",
    gate: "repl",
    mutating: true,
    concurrencySafe: false,
    // Sandboxed code runs with the host's privileges: the full-exec power, plus state for session records.
    requires: { exec: ["*"], fs: { write: ["state"] } },
    description: [
      "Run JavaScript in a persistent Node REPL scoped to the session.",
      "Variables, helpers and imported modules survive across calls; each call shares one context per session.",
      "reset: true replaces the context first, so the call starts from a clean slate.",
      "Long calls are bounded by timeout_ms (default 10s, max 60s); an overrunning call settles as tool_timeout and the session stays usable.",
      "The sandbox provides console (captured into output), nodeImport(name) and dynamic import(), and nodeReset().",
    ].join(" "),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        code: { type: "string", minLength: 1, maxLength: 100_000, description: "JavaScript to evaluate; top-level await is allowed." },
        session: { type: "string", minLength: 1, maxLength: 200, description: "Session identity; defaults to the calling session (owner)." },
        timeout_ms: { type: "integer", minimum: 1, maximum: REPL_MAX_TIMEOUT_MS },
        reset: { type: "boolean", description: "Reset the session context before running." },
      },
      required: ["code"],
    },
    subject: (input) => `node_repl${input.reset ? " (reset)" : ""}: ${input.code.slice(0, 120)}`,
    subjectKind: "command",
    async run(input, env: ToolEnv): Promise<ToolResult<NodeReplData>> {
      const owner = input.session ?? env.owner ?? "default";
      try {
        const outcome = await sessions.run(owner, input.code, { timeoutMs: input.timeout_ms ?? options.defaultTimeoutMs, signal: env.signal, reset: input.reset });
        // A cancelled first call short-circuits before the context exists: report
        // the identity it would have used instead of inventing a failed session.
        const info = sessions.peek(owner);
        const data: NodeReplData = {
          session_id: info?.id ?? replSessionId(owner, 1), owner, epoch: info?.epoch ?? 1, ok: outcome.ok,
          result: outcome.ok ? outcome.value : undefined,
          result_kind: outcome.ok ? outcome.kind : undefined,
          error_code: outcome.ok ? undefined : outcome.code,
          output_lines: outcome.lines.slice(0, 100), duration_ms: Math.round(outcome.durationMs),
        };
        const output = [
          ...outcome.lines,
          outcome.ok ? `=> ${outcome.value}` : `error(${outcome.code}): ${outcome.message}`,
        ].join("\n");
        return outcome.ok || outcome.code === "invalid_argument" || outcome.code === "cancelled"
          ? { ok: outcome.ok, output, data }
          : { ok: false, output, data, error: { code: outcome.code, message: outcome.message } };
      } catch (error) {
        if (error instanceof ReplError) return failure(error.code, error.message);
        return failure("tool_failed", error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export const nodeReplTool = createNodeReplTool();
