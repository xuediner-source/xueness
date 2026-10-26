/**
 * ZCode tool input ⇄ Xueness tool input, one pair per model-visible tool.
 *
 * `toInternal` turns what the model sent (already valid against the ZCode
 * schema) into the Xueness tool's input; it returns `{ error }` for input the
 * Xueness tool cannot serve. `toModel` rebuilds the ZCode input from a journal
 * entry that has no saved model call (sessions from before this change).
 */
import { isAbsolute, posix, win32 } from "node:path";
import { execSubject, shellQuote } from "@xueness/engine-tools";
import { skillAdapter } from "./skill-contract.ts";
import { agentAdapter } from "./agent-contract.ts";
import { channelReplyAdapter } from "./channel-reply-contract.ts";

type Row = Record<string, unknown>;
export type InternalInput = Row | { error: string };
export interface AdapterContext {
  /** Workspace root, to show journal paths as the absolute paths ZCode tools take. */
  root: string;
  /** Whether the Xueness tool's live schema accepts this property. */
  accepts(tool: string, property: string): boolean;
}
export interface InputAdapter {
  toInternal(input: Row, context: AdapterContext): InternalInput;
  toModel(input: Row, context: AdapterContext): Row;
}

/** ZCode `bash-timeout-policy.ts` defaults. */
export const BASH_DEFAULT_TIMEOUT_MS = 120_000;
export const BASH_MAX_TIMEOUT_MS = 600_000;
const TASK_OUTPUT_DEFAULT_TIMEOUT_MS = 30_000;
const EXEC_OUTPUT_MAX_WAIT_MS = 30_000;
const DESCRIPTION_MAX = 200;

const str = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const num = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const absolute = (path: unknown, root: string): unknown => {
  if (typeof path !== "string" || !path || isAbsolute(path)) return path;
  // `/ws` stays POSIX. win32.resolve would prefix the current drive (`E:\ws\...`).
  return posix.isAbsolute(root) && !/^[A-Za-z]:/.test(root) ? posix.resolve(root, path) : win32.resolve(root, path);
};
const defined = (row: Row): Row => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));

const bash: InputAdapter = {
  toInternal(input) {
    const background = input.run_in_background === true;
    const requested = num(input.timeout);
    // ZCode resolveBashTimeoutMs: min(timeout || default, max). A background task keeps its own longer limit.
    const timeout = requested ? Math.max(1, Math.round(background ? requested : Math.min(requested, BASH_MAX_TIMEOUT_MS))) : undefined;
    const description = str(input.description)?.trim();
    return defined({
      command: input.command,
      timeout_ms: timeout,
      description: description ? description.slice(0, DESCRIPTION_MAX) : undefined,
      background: background || undefined,
    });
  },
  toModel(input) {
    const words = Array.isArray(input.argv) && input.argv.every((word) => typeof word === "string") ? input.argv as string[] : undefined;
    let command = str(input.command) ?? (words ? execSubject({ argv: words }) : "");
    if (typeof input.cwd === "string" && input.cwd && input.cwd !== ".") command = `cd ${shellQuote(input.cwd)} && ${command}`;
    return defined({ command, timeout: num(input.timeout_ms), description: str(input.description), run_in_background: input.background === true ? true : undefined });
  },
};

const pathTool = (keys: readonly string[]): InputAdapter => ({
  toInternal(input) {
    const out: Row = { path: input.file_path };
    for (const key of keys) if (input[key] !== undefined) out[key] = input[key];
    return out;
  },
  toModel(input, context) {
    const out: Row = { file_path: absolute(input.path, context.root) };
    for (const key of keys) if (input[key] !== undefined) out[key] = input[key];
    return out;
  },
});

const read: InputAdapter = {
  toInternal(input) {
    // ZCode reads from the start for offset 0 or 1 (read-text toRangeOffsetLine).
    const offset = num(input.offset);
    return defined({ path: input.file_path, offset: offset !== undefined && offset > 1 ? offset : undefined, limit: input.limit, pages: input.pages });
  },
  toModel: pathTool(["offset", "limit", "pages"]).toModel,
};

const searchTool = (keys: readonly string[]): InputAdapter => ({
  toInternal(input) {
    const out: Row = {};
    for (const key of ["pattern", "path", ...keys]) if (input[key] !== undefined) out[key] = input[key];
    return out;
  },
  toModel(input) {
    const out: Row = {};
    for (const key of ["pattern", "path", ...keys]) if (input[key] !== undefined) out[key] = input[key];
    return out;
  },
});

/** A few ripgrep `--type` names as globs (ZCode Grep `type`), used when no glob is given. */
const RG_TYPE_GLOBS: Readonly<Record<string, string>> = Object.freeze({
  js: "**/*.{js,jsx,mjs,cjs}", ts: "**/*.{ts,tsx,mts,cts}", py: "**/*.{py,pyi}", rust: "**/*.rs", go: "**/*.go", java: "**/*.java",
  c: "**/*.{c,h}", cpp: "**/*.{cpp,cc,cxx,hpp,hh,hxx,h}", md: "**/*.{md,markdown}", json: "**/*.json", css: "**/*.{css,scss,less}",
  html: "**/*.{html,htm}", sh: "**/*.{sh,bash,zsh}", yaml: "**/*.{yaml,yml}", toml: "**/*.toml", rb: "**/*.rb", php: "**/*.php", kotlin: "**/*.{kt,kts}", swift: "**/*.swift",
});

/** ZCode MAX_GLOB_RESULTS: Glob returns at most 100 paths. */
export const GLOB_MODEL_MAX_RESULTS = 100;
const globTool: InputAdapter = {
  toInternal: (input, context) => ({ ...searchTool([]).toInternal(input, context), limit: GLOB_MODEL_MAX_RESULTS }),
  toModel: searchTool([]).toModel,
};

const grep: InputAdapter = {
  toInternal(input) {
    const base = searchTool(["glob", "output_mode", "head_limit", "offset", "multiline"]).toInternal(input, { root: "", accepts: () => true }) as Row;
    const context = num(input["-C"]) ?? num(input.context) ?? Math.max(num(input["-A"]) ?? 0, num(input["-B"]) ?? 0);
    const typeGlob = typeof input.type === "string" ? RG_TYPE_GLOBS[input.type] : undefined;
    return defined({
      ...base,
      glob: base.glob ?? typeGlob,
      // ZCode Grep defaults to files_with_matches; Xueness grep defaults to content.
      output_mode: base.output_mode ?? "files_with_matches",
      case_insensitive: input["-i"] === true ? true : undefined,
      context: context ? Math.min(20, Math.max(0, Math.round(context))) : undefined,
      // head_limit 0 means unlimited in ZCode; 5000 is the Xueness ceiling.
      head_limit: num(base.head_limit) === 0 ? 5000 : num(base.head_limit) !== undefined && (base.head_limit as number) > 0 ? Math.min(5000, Math.round(base.head_limit as number)) : undefined,
      offset: num(base.offset) !== undefined ? Math.max(0, Math.round(base.offset as number)) : undefined,
    });
  },
  toModel(input) {
    const out = searchTool(["glob", "output_mode", "head_limit", "offset", "multiline"]).toModel(input, { root: "", accepts: () => true });
    if (input.include !== undefined && out.glob === undefined) out.glob = input.include;
    if (out.output_mode === undefined) out.output_mode = "content"; // the Xueness default the old call ran with
    if (input.case_insensitive === true) out["-i"] = true;
    if (num(input.context)) out["-C"] = input.context;
    return out;
  },
};

const STATUS_TO_INTERNAL: Readonly<Record<string, string>> = { pending: "pending", in_progress: "in_progress", completed: "done" };
const STATUS_TO_MODEL: Readonly<Record<string, string>> = { pending: "pending", in_progress: "in_progress", done: "completed" };
const todoWrite: InputAdapter = {
  toInternal(input) {
    const todos = (input.todos as Row[]).map((todo, index) => defined({ id: String(index + 1), text: todo.content, status: STATUS_TO_INTERNAL[String(todo.status)] ?? "pending", priority: todo.priority }));
    return { todos };
  },
  toModel(input) {
    const todos = Array.isArray(input.todos) ? input.todos : [];
    return { todos: todos.map((todo) => { const row = (todo ?? {}) as Row; return { content: row.text ?? row.content ?? "", status: STATUS_TO_MODEL[String(row.status)] ?? "pending", priority: row.priority ?? "medium" }; }) };
  },
};

const askUser: InputAdapter = {
  toInternal(input, context) {
    const questions = input.questions as Row[];
    const out: Row = { question: questions.map((q) => String(q.question ?? "").trim()).filter(Boolean).join("\n").slice(0, 2000) };
    if (context.accepts("ask_user", "questions")) {
      out.questions = questions.slice(0, 3).map((q, index) => ({
        id: `q${index + 1}`, header: String(q.header ?? "").slice(0, 12), question: String(q.question ?? "").slice(0, 500), multiSelect: q.multiSelect === true,
        options: (Array.isArray(q.options) ? q.options as Row[] : []).slice(0, 3).map((option) => ({ label: String(option.label ?? "").slice(0, 80), description: String(option.description ?? "").slice(0, 300) })),
      }));
    }
    return out;
  },
  toModel(input) {
    const questions = Array.isArray(input.questions) ? input.questions as Row[] : [];
    if (questions.length) return { questions: questions.map((q) => ({ question: q.question, header: q.header, options: Array.isArray(q.options) ? q.options : [], multiSelect: q.multiSelect === true })) };
    return { questions: [{ question: input.question ?? "", header: "Question", options: [], multiSelect: false }] };
  },
};

const taskOutput: InputAdapter = {
  toInternal(input) {
    const wait = input.block === false ? 0 : Math.min(EXEC_OUTPUT_MAX_WAIT_MS, Math.max(0, Math.round(num(input.timeout) ?? TASK_OUTPUT_DEFAULT_TIMEOUT_MS)));
    return { task_id: input.task_id, wait_ms: wait };
  },
  toModel(input) {
    const wait = num(input.wait_ms) ?? 0;
    return { task_id: input.task_id ?? "", block: wait > 0, timeout: wait };
  },
};

const taskStop: InputAdapter = {
  toInternal(input) {
    const id = str(input.task_id) ?? str(input.shell_id);
    // ZCode task-stop.ts: neither id given.
    return id ? { task_id: id } : { error: "<tool_use_error>Missing required parameter: task_id</tool_use_error>" };
  },
  toModel(input) {
    return { task_id: input.task_id ?? "" };
  },
};

const same: InputAdapter = { toInternal: (input) => ({ ...input }), toModel: (input) => ({ ...input }) };

export const ADAPTERS: Readonly<Record<string, InputAdapter>> = Object.freeze({
  exec: bash, read, write: pathTool(["content"]), edit: pathTool(["old_string", "new_string", "replace_all"]),
  glob: globTool, grep, todo_read: same, todo_write: todoWrite, ask_user: askUser,
  exec_output: taskOutput, exec_kill: taskStop, exit_plan_mode: same, enter_plan_mode: same, apply_patch: same, skill_read: skillAdapter, task: agentAdapter,
  reply_to_channel: channelReplyAdapter,
});
