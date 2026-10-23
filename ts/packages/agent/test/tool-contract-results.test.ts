/**
 * Step 3 round 2: ZCode result texts for Glob, Grep, TaskOutput, TaskStop,
 * TodoRead and TodoWrite, rendered in the request view from real Xueness
 * results. Expected shapes come from ZCode v3.15.1 (aac4755, Apache-2.0)
 * core/src/tool/handlers/{glob,grep,task-output,task-stop,todo}.ts and
 * core/tests/{grep-tool,task-output-tool,task-stop-tool}.test.ts.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createToolEnv, globTool, grepTool, runTool } from "@xueness/engine-tools";
import { journalCall, modelMessages, type AdapterContext } from "../src/index.ts";

const base = mkdtempSync(join(tmpdir(), "xueness-contract-results-"));
const root = join(base, "ws");
mkdirSync(join(root, "src"), { recursive: true });
writeFileSync(join(root, "src", "a.ts"), "const alpha = 1;\nconst beta = alpha;\n");
writeFileSync(join(root, "src", "b.ts"), "export const alpha = 2;\n");
writeFileSync(join(root, "README.md"), "no match here\n");
after(() => rmSync(base, { recursive: true, force: true }));
const env = createToolEnv({ cwd: root, artifactsDir: join(base, "artifacts") });
const context: AdapterContext = { root, accepts: () => true };
type Row = Record<string, unknown>;

/** A ZCode call → journal call → run the Xueness tool → what the model sees as the result. */
async function roundTrip(model: string, args: Row, run: (input: Row) => Promise<unknown>): Promise<string> {
  const { call, error } = journalCall({ id: "c1", type: "function", function: { name: model, arguments: JSON.stringify(args) } }, context);
  assert.equal(error, null);
  const input = JSON.parse((call.function as { arguments: string }).arguments) as Row;
  const result = await run(input);
  const view = modelMessages([{ role: "assistant", content: "", tool_calls: [call] }, { role: "tool", tool_call_id: "c1", content: JSON.stringify(result) }], context);
  return view[1]!.content as string;
}
const viewOf = (name: string, input: Row, result: Row): string => modelMessages([
  { role: "assistant", content: "", tool_calls: [{ id: "t1", type: "function", function: { name, arguments: JSON.stringify(input) } }] },
  { role: "tool", tool_call_id: "t1", content: JSON.stringify(result) },
], context)[1]!.content as string;

describe("Glob and Grep results", () => {
  it("lists Glob paths and says No files found", async () => {
    const text = await roundTrip("Glob", { pattern: "**/*.ts" }, (input) => runTool(globTool, input, env));
    assert.deepEqual(text.split("\n").sort(), ["src/a.ts", "src/b.ts"]);
    assert.equal(await roundTrip("Glob", { pattern: "**/*.py" }, (input) => runTool(globTool, input, env)), "No files found");
  });

  it("defaults Grep to files_with_matches with the ZCode count line", async () => {
    const text = await roundTrip("Grep", { pattern: "alpha" }, (input) => runTool(grepTool, input, env));
    const [first, ...files] = text.split("\n");
    assert.equal(first, "Found 2 files");
    assert.deepEqual(files.sort(), ["src/a.ts", "src/b.ts"]);
    assert.equal(await roundTrip("Grep", { pattern: "zzz" }, (input) => runTool(grepTool, input, env)), "No files found");
  });

  it("shows content lines, pagination and counts like ZCode", async () => {
    const content = await roundTrip("Grep", { pattern: "alpha", output_mode: "content", path: "src/a.ts" }, (input) => runTool(grepTool, input, env));
    assert.equal(content, "src/a.ts:1:const alpha = 1;\nsrc/a.ts:2:const beta = alpha;");
    const paged = await roundTrip("Grep", { pattern: "alpha", output_mode: "content", head_limit: 1 }, (input) => runTool(grepTool, input, env));
    assert.match(paged, /^src\/a\.ts:1:const alpha = 1;\n\n\[Showing results with pagination = limit: 1\]$/);
    const count = await roundTrip("Grep", { pattern: "alpha", output_mode: "count" }, (input) => runTool(grepTool, input, env));
    assert.match(count, /\n\nFound 3 total occurrences across 2 files\.$/);
    assert.equal(await roundTrip("Grep", { pattern: "zzz", output_mode: "content" }, (input) => runTool(grepTool, input, env)), "No matches found");
  });

  it("maps ripgrep types to globs", async () => {
    const { call } = journalCall({ id: "c2", type: "function", function: { name: "Grep", arguments: JSON.stringify({ pattern: "x", type: "ts" }) } }, context);
    assert.equal(JSON.parse((call.function as { arguments: string }).arguments).glob, "**/*.{ts,tsx,mts,cts}");
  });
});

describe("background task results", () => {
  const info = (state: string, exitCode: number | null) => ({
    id: "bg_1", command: "npm run dev", state, exitCode, timeoutMs: 1_800_000,
    stdout: { path: "/art/tasks/bg_1.stdout.log" }, stderr: { path: "/art/tasks/bg_1.stderr.log" },
  });
  const read = (state: string, exitCode: number | null, text = "ready on :3000\n", truncated = false) => ({
    ok: true, output: "xueness text", data: { info: info(state, exitCode), stdout: { text, truncated }, stderr: { text: "" } },
  });

  it("renders TaskOutput blocks with retrieval status", () => {
    assert.equal(viewOf("exec_output", { task_id: "bg_1", wait_ms: 30_000 }, read("exited", 0)),
      "<retrieval_status>success</retrieval_status>\n\n<task_id>bg_1</task_id>\n\n<task_type>local_bash</task_type>\n\n<status>completed</status>\n\n<exit_code>0</exit_code>\n\n<output>\nready on :3000\n</output>");
    assert.match(viewOf("exec_output", { task_id: "bg_1", wait_ms: 30_000 }, read("running", null)), /^<retrieval_status>timeout<\/retrieval_status>[\s\S]*<status>running<\/status>/);
    assert.match(viewOf("exec_output", { task_id: "bg_1" }, read("running", null, "")), /^<retrieval_status>not_ready<\/retrieval_status>/);
    assert.match(viewOf("exec_output", { task_id: "bg_1" }, read("exited", 2, "tail\n", true)), /<status>failed<\/status>\n\n<exit_code>2<\/exit_code>\n\n<output>\n\[Truncated\. Full output: \/art\/tasks\/bg_1\.stdout\.log\]\n\ntail\n<\/output>/);
  });

  it("renders TaskStop as ZCode JSON and unknown ids with the ZCode message", () => {
    assert.deepEqual(JSON.parse(viewOf("exec_kill", { task_id: "bg_1" }, read("killed", null))), {
      message: "Successfully stopped task: bg_1 (npm run dev)", task_id: "bg_1", task_type: "local_bash", command: "npm run dev",
    });
    assert.equal(viewOf("exec_output", { task_id: "bg_9" }, { ok: false, output: "no background task bg_9", error: { code: "unknown_task", message: "no background task bg_9" } }),
      "<tool_use_error>No task found with ID: bg_9</tool_use_error>");
  });
});

describe("todo results", () => {
  it("renders TodoRead and TodoWrite as ZCode JSON", () => {
    const todos = [{ id: "1", text: "Write tests", status: "done", priority: "high" }, { id: "2", text: "Ship", status: "in_progress" }];
    assert.deepEqual(JSON.parse(viewOf("todo_read", {}, { ok: true, output: "{}", data: { todos } })), {
      todos: [{ content: "Write tests", status: "completed", priority: "high" }, { content: "Ship", status: "in_progress", priority: "medium" }],
    });
    const written = JSON.parse(viewOf("todo_write", { todos }, { ok: true, output: "{}", data: { todos, count: 2, oldTodos: [] } }));
    assert.deepEqual(written.summary, { total: 2, pending: 0, inProgress: 1, completed: 1 });
    assert.deepEqual(written.oldTodos, []);
  });
});
