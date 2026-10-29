/** Session-scoped tasks and questions are owned by planning, not the agent loop. */
import { isDict, pyJsonDumps, pyLen, pyStrip, PyValueError, type JsonSchema } from "@xueness/contracts";
import type { ToolDefinition } from "@xueness/engine-tools";
import { publicGoal } from "./goal.ts";
import type { Row } from "./delivery.ts";
import { enterPlanModeTool, exitPlanModeTool, type PlanModePort } from "./plan-exit.ts";
export interface PlanningToolsOptions { session(): Row | null; enabled?(id: string): boolean; normalizeQuestions?: (value: unknown) => unknown; questionsSchema?: JsonSchema; planMode?: () => PlanModePort | null }
export function normalizeTodos(value: unknown): Row[] {
  if (!Array.isArray(value)) throw new PyValueError("todos must be an array");
  if (value.length > 50) throw new PyValueError("todos capped at 50 items");
  const seen = new Set<string>();
  return value.map((item) => {
    if (!isDict(item)) throw new PyValueError("each todo must be an object");
    const { id, text } = item, status = Object.hasOwn(item, "status") ? item.status : "pending";
    if (typeof id !== "string" || !pyStrip(id) || pyLen(id) > 64) throw new PyValueError("todo id must be a 1..64 character string");
    if (seen.has(id)) throw new PyValueError("duplicate todo id"); seen.add(id);
    if (typeof text !== "string" || !pyStrip(text) || pyLen(text) > 2000) throw new PyValueError("todo text must be 1..2000 characters");
    if (!["pending", "in_progress", "done"].includes(String(status))) throw new PyValueError("todo status must be one of pending, in_progress, done");
    // ZCode TodoWrite carries a priority; kept when valid (TS only; the Python tool drops it).
    const priority = ["high", "medium", "low"].includes(String(item.priority)) ? item.priority : undefined;
    return { id, text: pyStrip(text), status, ...(priority ? { priority } : {}) };
  });
}
export function planningTaskTools(options: PlanningToolsOptions): ToolDefinition<any, unknown>[] {
  const result = (data: Row) => ({ ok: true, output: pyJsonDumps(data), data, ...data });
  return [
    { name: "goal_read", description: "Read the current session's durable goal and its public status, budget, and reported usage (read-only)", gate: "goal_read", mutating: false, concurrencySafe: true, requires: {}, inputSchema: { type: "object", additionalProperties: false, properties: {} },
      async run() { const session = options.session(); return result({ goal: session ? publicGoal(session) : null }); } },
    { name: "todo_read", description: "Read the session-scoped todo list (no filesystem access)", gate: "todo_read", mutating: false, concurrencySafe: true, requires: {}, inputSchema: { type: "object", additionalProperties: false, properties: {} },
      async run() { const todos = options.session()?.todos; return result({ todos: Array.isArray(todos) ? [...todos] : [] }); } },
    { name: "todo_write", description: "Replace the session-scoped todo list (journal-persisted, capped)", gate: "todo_write", mutating: false, concurrencySafe: false, requires: {}, inputSchema: { type: "object", additionalProperties: false, required: ["todos"], properties: { todos: { type: "array", items: { type: "object" } } } },
      async run(input: Row) { const session = options.session(); if (!session) throw new PyValueError("todo_write needs a session"); const oldTodos = Array.isArray(session.todos) ? [...session.todos] : []; const todos = normalizeTodos(input.todos); session.todos = todos; return { ...result({ todos, count: todos.length }), data: { todos, count: todos.length, oldTodos } }; } },
    { name: "ask_user", description: "Ask the operator a question; pauses the run until answered", gate: "ask_user", mutating: false, concurrencySafe: false, requires: {}, inputSchema: { type: "object", additionalProperties: false, required: ["question"], properties: { question: { type: "string" }, ...(options.questionsSchema ? { questions: options.questionsSchema } : {}) } },
      async run(input: Row) {
        if (typeof input.question !== "string" || !pyStrip(input.question) || pyLen(input.question) > 2000) throw new PyValueError("question must be 1..2000 characters");
        const data: Row = { awaiting_user: true, question: pyStrip(input.question) };
        if (Object.hasOwn(input, "questions")) { if (!options.normalizeQuestions) throw new PyValueError("structured questions require the planning and sessions plugins"); data.questions = options.normalizeQuestions(input.questions); }
        return result(data);
      } },
    exitPlanModeTool(() => options.planMode?.() ?? null),
    enterPlanModeTool(() => options.planMode?.() ?? null),
  ];
}
