/**
 * Workflow expression DSL (Python `bundled_plugins/workflows/dsl.py`).
 *
 * Python hands the script to `ast.parse` and interprets an allowlisted subset
 * of the tree; nothing is ever compiled or evaluated. With no Python parser to
 * call, `dsl-lex.ts` tokenises and `dsl-parse.ts` rebuilds that tree shape;
 * this module is the interpreter that walks it exactly as `dsl.py` does.
 */
import { pyLen, pyStrip, setOwn } from "@xueness/contracts";
import { pyCodeCompare } from "@xueness/sessions";
import {
  AGENT_KEYS, DEEP, EXPRESSIONS, LITERALS, MAX_DEPTH, MAX_NODES, MAX_SCRIPT, STATEMENTS, fail, tokenize,
} from "./dsl-lex.ts";
import { Parser, type Expr, type Stmt } from "./dsl-parse.ts";
import type { Row } from "./plan.ts";

class Interpreter {
  readonly #nodes: Row[] = [];
  readonly #names = new Map<string, string[]>();
  #depth = 0;
  #phase: string | null = null;
  #name: string;

  constructor(defaultName: string) {
    this.#name = defaultName;
  }

  run(body: readonly Stmt[]): Row {
    for (const statement of body) this.#statement(statement);
    if (!this.#nodes.length) fail("workflow script must declare at least one agent");
    return { name: this.#name, nodes: this.#nodes };
  }

  #statement(statement: Stmt): void {
    if (statement.k === "bad") fail(STATEMENTS);
    if (statement.k === "assign") {
      // `name = ...` reads a literal; every other target runs `expression()`.
      if (statement.target === "name") {
        const value = this.#literal(statement.v);
        if (typeof value !== "string" || !pyStrip(value) || pyLen(value) > 120) fail("workflow name must be 1..120 characters");
        this.#name = pyStrip(value);
        return;
      }
      this.#names.set(statement.target, this.#expression(statement.v));
      return;
    }
    const value = statement.v;
    // Python only treats a bare `Call` expression statement as a DSL call.
    if (value.k !== "call") fail(STATEMENTS);
    if (value.fn.k === "name" && value.fn.id === "phase") {
      if (value.args.length !== 1 || value.kw.length) fail("phase() accepts one literal title");
      const title = this.#literal(value.args[0]!);
      if (typeof title !== "string" || !pyStrip(title) || pyLen(title) > 120) fail("phase title must be 1..120 characters");
      this.#phase = pyStrip(title);
      return;
    }
    this.#expression(value);
  }

  #expression(node: Expr): string[] {
    this.#enter();
    try {
      if (node.k === "await") return this.#expression(node.value);
      if (node.k === "call") {
        if (node.fn.k !== "name") fail("workflow calls must use a named DSL primitive");
        const primitive = node.fn.id;
        if (primitive === "agent") return this.#addAgent(node);
        if (primitive === "parallel") {
          return this.#stages(node, "parallel() accepts one list of agent stages").flatMap((item) => this.#expression(item));
        }
        if (primitive === "pipeline") {
          let previous: string[] = [];
          const all: string[] = [];
          for (const child of this.#stages(node, "pipeline() accepts one list of sequential stages")) {
            const stage = this.#expression(child);
            for (const id of stage) {
              const row = this.#nodes.find((item) => item.id === id)!;
              const needs = Array.isArray(row.needs) ? (row.needs as string[]) : [];
              row.needs = [...new Set([...needs, ...previous])].sort(pyCodeCompare);
            }
            previous = stage;
            all.push(...stage);
          }
          return all;
        }
        if (primitive === "phase") fail("phase() is only allowed as a top-level statement");
        fail("unsupported workflow primitive: " + primitive);
      }
      if (node.k === "name") {
        const stage = this.#names.get(node.id);
        if (stage === undefined) fail("unknown workflow name: " + node.id);
        return [...stage];
      }
      return fail(EXPRESSIONS);
    } finally {
      this.#depth -= 1;
    }
  }

  #stages(node: Extract<Expr, { k: "call" }>, message: string): Expr[] {
    const argument = node.args[0];
    if (node.args.length !== 1 || node.kw.length || argument === undefined) fail(message);
    if (argument.k !== "list" && argument.k !== "tuple") fail(message);
    return argument.items;
  }

  #addAgent(call: Extract<Expr, { k: "call" }>): string[] {
    const prompt = call.args[0];
    if (call.args.length !== 1 || prompt === undefined || prompt.k !== "const" || typeof prompt.v !== "string") {
      fail("agent() needs one literal prompt string");
    }
    const kwargs: Row = {};
    for (const { key, value } of call.kw) {
      if (key === null || !AGENT_KEYS.has(key) || Object.hasOwn(kwargs, key)) fail("agent() has an unsupported or duplicate option");
      setOwn(kwargs, key, this.#literal(value));
    }
    const id = `agent_${String(this.#nodes.length + 1).padStart(3, "0")}`;
    const row: Row = { id, kind: "agent", prompt: (prompt as { v: unknown }).v, ...kwargs };
    if (this.#phase !== null) row.phase = this.#phase;
    this.#nodes.push(row);
    if (this.#nodes.length > MAX_NODES) fail("workflow has more than 64 agents");
    return [id];
  }

  #literal(node: Expr): unknown {
    this.#enter();
    try {
      if (node.k === "const") return node.v;
      if (node.k === "list" || node.k === "tuple") return node.items.map((item) => this.#literal(item));
      if (node.k === "dict") {
        const out: Row = {};
        for (const [keyNode, valueNode] of node.entries) {
          // A `**` unpack has no key node, which `literal(None)` rejects.
          if (keyNode === null) fail(LITERALS);
          const key = this.#literal(keyNode);
          if (typeof key !== "string" || Object.hasOwn(out, key)) fail("workflow dictionaries need unique string keys");
          setOwn(out, key, this.#literal(valueNode));
        }
        return out;
      }
      return fail(LITERALS);
    } finally {
      this.#depth -= 1;
    }
  }

  #enter(): void {
    this.#depth += 1;
    if (this.#depth > MAX_DEPTH) fail(DEEP);
  }
}

/** `compile_workflow_script`: a validated `{ name, nodes }` plan from DSL source. */
export function compileWorkflowScript(source: string, root: string, defaultName = "Workflow"): Row {
  void root;
  if (typeof source !== "string" || !pyStrip(source) || pyLen(source) > MAX_SCRIPT) {
    fail("workflow script must be 1..32000 characters");
  }
  // Python normalises newlines before parsing: `\r\n` and `\r` both become `\n`.
  const text = source.replace(/\r\n?/g, "\n");
  try {
    return new Interpreter(defaultName).run(new Parser(tokenize(text)).parse());
  } catch (error) {
    // A JavaScript stack overflow stands in for Python's RecursionError.
    if (error instanceof RangeError) fail(DEEP);
    throw error;
  }
}
