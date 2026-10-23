import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createApplicationApi } from "../src/application-api.ts";
import { createFrontDoor, type FrontDoor } from "../src/front-door.ts";
import { PROJECT_ROOT } from "../../../test-support/python-oracle.ts";
import { SessionStore } from "@xueness/sessions";
type Row = Record<string, any>;
function reply(res: ServerResponse, message: Row): void {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const delta = message.tool_calls ? { tool_calls: message.tool_calls.map((call: Row, index: number) => ({ index, ...call })) } : { content: message.content ?? "" };
  res.end("data: " + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: message.tool_calls ? "tool_calls" : "stop" }] }) + "\n\ndata: [DONE]\n\n");
}
const call = (id: string, name: string, args: Row): Row => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
describe("production native HTTP agent lifecycle", () => {
  let base: string, workspace: string, origin: string, token: string;
  let api: Awaited<ReturnType<typeof createApplicationApi>>, front: FrontDoor;
  const script: ((request: Row, res: ServerResponse) => void)[] = [];
  const modelFailures: string[] = [];
  const model = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on("data", (chunk: Buffer) => chunks.push(chunk)); req.on("end", () => {
      const next = script.shift(); if (!next) { res.writeHead(500); res.end("script exhausted"); return; }
      try { next(JSON.parse(Buffer.concat(chunks).toString("utf8")), res); }
      catch (error) { modelFailures.push(String(error)); res.writeHead(500); res.end(String(error)); }
    });
  });
  before(async () => {
    base = mkdtempSync(join(tmpdir(), "xueness-http-agent-")); workspace = join(base, "workspace"); mkdirSync(workspace); mkdirSync(join(base, "state"));
    writeFileSync(join(base, "state", "settings.json"), JSON.stringify({ general: { sessionsAutoTitleEnabled: false } }));
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
    api = await createApplicationApi({ projectRoot: PROJECT_ROOT, projectDir: workspace, stateDir: join(base, "state"), webRuns: join(base, "runs"), workspaceRoots: [workspace], allowReal: true });
    token = api.csrfToken; front = createFrontDoor({ webappDir: join(PROJECT_ROOT, "webapp/dist"), api });
    await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve)); origin = `http://127.0.0.1:${(front.address() as { port: number }).port}`;
    const saved = await request("/api/providers", { id: "local-agent", name: "Isolated scripted endpoint", baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`, model: "local-scripted", apiKey: "local-key", allowLoopbackHttp: true });
    assert.equal(saved.status, 200, await saved.text());
  });
  after(async () => {
    front?.closeAllConnections(); if (front) await new Promise<void>((resolve) => front.close(() => resolve()));
    await api?.close(); model.closeAllConnections(); await new Promise<void>((resolve) => model.close(() => resolve()));
    if (base) rmSync(base, { recursive: true, force: true });
  });
  const request = (path: string, data?: unknown) => fetch(origin + path, { method: data === undefined ? "GET" : "POST", headers: { "X-CSRF-Token": token, ...(data === undefined ? {} : { "Content-Type": "application/json" }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const create = async (task: string): Promise<string> => {
    const response = await request("/api/sessions", { task, root: workspace }); assert.equal(response.status, 200, await response.clone().text()); return (await response.json() as Row).id;
  };
  const run = (id: string, extra: Row = {}) => request(`/api/sessions/${id}/run`, { model_selection: { provider_id: "local-agent" }, allow_mcp: true, steps: 4, ...extra });

  it("runs provider→file plugin→journal entirely through native HTTP with the webapp's empty MCP opt-in", async () => {
    writeFileSync(join(workspace, "sample.txt"), "Production HTTP fixture\n");
    const id = await create("Read sample.txt");
    script.push((_req, res) => reply(res, { tool_calls: [call("http-read", "read", { path: "sample.txt" })] }), (req, res) => {
      assert.ok(req.messages.some((row: Row) => row.role === "tool" && String(row.content).includes("Production HTTP fixture")));
      reply(res, { content: "The file was read.\nEvidence: E1" });
    });
    const response = await run(id); assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json() as Row; assert.equal(result.status, "completed"); assert.equal(result.completion.verified, true);
    const journal = JSON.parse(readFileSync(join(base, "state", id + ".json"), "utf8")); assert.equal(journal.status, "completed"); assert.equal(journal.results["http-read"].ok, true);
  });
  // ZCode permission-flow.ts / broker.ts: the call waits in process and the same turn continues.
  it("answers a waiting HTTP approval in the same turn without a new run", async () => {
    const id = await create("Perform the pending action");
    script.push((_req, res) => reply(res, { tool_calls: [call("http-write", "write", { path: "./approved.txt", content: "approved via HTTP\n" })] }),
      (_req, res) => { assert.equal(readFileSync(join(workspace, "approved.txt"), "utf8"), "approved via HTTP\n"); reply(res, { content: "The approved action completed.\nEvidence: E1" }); });
    const running = run(id);
    let waiting: Row | undefined;
    for (let round = 0; round < 400 && !waiting; round += 1) {
      const detail = await (await request(`/api/sessions/${id}`)).json() as Row;
      waiting = (detail.pending ?? []).find((row: Row) => row.waiting === true);
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(waiting, "the waiting call is listed while the run is in flight");
    assert.deepEqual([waiting.tool_call_id, waiting.kind, waiting.subject], ["http-write", "write", "approved.txt"]);
    const approved = await request(`/api/sessions/${id}/approvals`, { kind: "write", tool_call_id: "http-write" }); assert.equal(approved.status, 200, await approved.clone().text());
    const answer = await approved.json() as Row; assert.equal(answer.resumed, true); assert.equal(answer.approved.tool_call_id, "http-write");
    const response = await running; assert.equal(response.status, 200, (await response.clone().text()) + JSON.stringify(modelFailures));
    const result = await response.json() as Row; assert.equal(result.status, "completed"); assert.equal(result.steps, 2); assert.deepEqual(result.pending, []);
    const journal = JSON.parse(readFileSync(join(base, "state", id + ".json"), "utf8"));
    assert.equal(journal.messages.filter((row: Row) => row.role === "user").length, 1, "no new turn");
    assert.deepEqual(journal.approval_log.map((row: Row) => row.action), ["granted", "consumed"]);
    const again = await request(`/api/sessions/${id}/approvals`, { kind: "write", tool_call_id: "http-write" }); assert.equal(again.status, 200);
    assert.equal((await again.json() as Row).duplicate, true, "a repeated answer is idempotent");
    const changed = await request(`/api/sessions/${id}/approvals`, { kind: "write", tool_call_id: "http-write", decision: "reject" }); assert.equal(changed.status, 409);
  });
  // ZCode permission-response.ts (deny carries the user's reason) and permission/service.ts
  // grantSessionPermission (in-memory session rules): reject feedback and "allow for this session" over HTTP.
  it("carries reject feedback to the model and allows identical calls for the session", async () => {
    const id = await create("Write twice, then try another file");
    const args = { path: "./session.txt", content: "session\n" };
    script.push((_req, res) => reply(res, { tool_calls: [call("s-1", "write", args)] }),
      (_req, res) => reply(res, { tool_calls: [call("s-2", "write", args)] }),
      (req, res) => { assert.ok(req.messages.some((row: Row) => row.role === "tool" && row.tool_call_id === "s-2" && !String(row.content).includes("approval_required"))); reply(res, { tool_calls: [call("s-3", "write", { path: "./other.txt", content: "no\n" })] }); },
      (req, res) => { assert.ok(req.messages.some((row: Row) => row.role === "tool" && row.tool_call_id === "s-3" && String(row.content).includes("The user's feedback: 不要建新文件"))); reply(res, { content: "Done without other.txt.\nEvidence: E1" }); });
    const running = run(id);
    const waitFor = async (callId: string): Promise<void> => {
      for (let round = 0; round < 400; round += 1) {
        const detail = await (await request(`/api/sessions/${id}`)).json() as Row;
        if ((detail.pending ?? []).some((row: Row) => row.waiting === true && row.tool_call_id === callId)) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.fail(`${callId} never waited`);
    };
    await waitFor("s-1");
    const allowed = await request(`/api/sessions/${id}/approvals`, { kind: "write", tool_call_id: "s-1", scope: "session" }); assert.equal(allowed.status, 200, await allowed.clone().text());
    await waitFor("s-3");
    const rejected = await request(`/api/sessions/${id}/approvals`, { kind: "write", tool_call_id: "s-3", decision: "reject", message: "  不要建新文件  " }); assert.equal(rejected.status, 200, await rejected.clone().text());
    const response = await running; assert.equal(response.status, 200, (await response.clone().text()) + JSON.stringify(modelFailures));
    assert.equal((await response.json() as Row).status, "completed");
    assert.equal(existsSync(join(workspace, "other.txt")), false);
    const journal = JSON.parse(readFileSync(join(base, "state", id + ".json"), "utf8"));
    assert.deepEqual(journal.approval_log.map((row: Row) => `${row.tool_call_id}:${row.action}`), ["s-1:granted", "s-1:consumed", "s-2:granted", "s-2:consumed", "s-3:denied"]);
  });
  it("still replays an approval for an older paused session with no waiting call", async () => {
    const id = await create("Perform the old pending action");
    const store = new SessionStore(join(base, "state"));
    const old = await store.load(id);
    const args = { path: "./replayed.txt", content: "replayed\n" };
    const paused = { ok: false, output: "write requires explicit approval; waiting for the user to approve this call", error: { code: "approval_required", message: "write requires explicit approval" },
      user_reason: "等待你批准工具调用；批准后继续。", data: { awaitingApproval: true, reason: "approval_required", kind: "write", subject: "replayed.txt" } };
    (old.messages as Row[]).push({ role: "assistant", content: "", tool_calls: [call("old-write", "write", args)] }, { role: "tool", tool_call_id: "old-write", content: JSON.stringify(paused) });
    old.results = { "old-write": paused }; old.status = "paused"; old.steps = 1; old.pause_code = "approval_required";
    await store.save(old);
    const approved = await request(`/api/sessions/${id}/approvals`, { kind: "write", tool_call_id: "old-write" }); assert.equal(approved.status, 200, await approved.clone().text());
    assert.equal((await approved.json() as Row).resumed, undefined, "no call was waiting: the grant waits for the next run");
    script.push((req, res) => {
      assert.equal(readFileSync(join(workspace, "replayed.txt"), "utf8"), "replayed\n");
      assert.ok(req.messages.some((row: Row) => row.role === "tool" && String(row.content).includes("replayed.txt") && !String(row.content).includes("approval_required")));
      reply(res, { content: "The replayed action completed.\nEvidence: E1" });
    });
    const second = await run(id); assert.equal(second.status, 200, await second.clone().text()); assert.equal((await second.json() as Row).status, "completed");
  });
  it("accepts a queued turn during an active HTTP run and drains it under the native lifecycle", async () => {
    const id = await create("Hello"); let ready!: () => void; const arrived = new Promise<void>((resolve) => { ready = resolve; });
    let pending!: ServerResponse;
    script.push((_req, res) => { pending = res; ready(); }, (req, res) => { assert.ok(req.messages.some((row: Row) => row.role === "user" && String(row.content).includes("Follow-up message"))); reply(res, { content: "Second answer" }); });
    const running = run(id); await arrived;
    const queued = await request(`/api/sessions/${id}/queue`, { text: "Follow-up message", request_id: "e".repeat(32) });
    assert.equal(queued.status, 202, await queued.clone().text()); reply(pending, { content: "First answer" });
    const response = await running; assert.equal(response.status, 200, await response.clone().text()); const result = await response.json() as Row;
    assert.equal(result.status, "completed"); assert.equal(result.steps, 2);
    const journal = JSON.parse(readFileSync(join(base, "state", id + ".json"), "utf8")); assert.equal(journal.messages.filter((row: Row) => row.role === "user" && row.content === "Follow-up message").length, 1);
    const queue = await (await request(`/api/sessions/${id}/queue`)).json() as Row; assert.equal(queue.queued_messages.length, 0);
  });
  it("registers requested outputs and checks actual generated content through the planning plugin", async () => {
    const id = await create("Write output/report.md containing Requested section");
    script.push((req, res) => {
      assert.ok(req.tools.some((tool: Row) => tool.function.name === "delivery_plan"));
      assert.ok(req.messages.some((row: Row) => row.role === "system" && String(row.content).includes("Work execution policy (planning plugin):")), "host instructions travel as their own system message");
      reply(res, { tool_calls: [call("delivery-plan", "delivery_plan", { items: [{ id: "contents", label: "Requested report contents", path: "output/report.md", contains: ["Requested section"], min_links: 1 }] })] });
    }, (_req, res) => reply(res, { tool_calls: [call("delivery-write", "write", { path: "output/report.md", content: "# Requested section\nhttps://source.test/report\n" })] }), (_req, res) => reply(res, { content: "The requested report was saved and checked.\nEvidence: E2" }));
    const response = await run(id, { permission_mode: "yolo", acknowledge_yolo: true }); assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json() as Row; assert.equal(result.status, "completed"); assert.equal(result.completion.delivery_checks.planning.status, "passed");
    const checks = result.completion.delivery_checks.planning.items; assert.deepEqual(checks.map((item: Row) => item.id), ["output_1", "contents"]); assert.ok(checks.every((item: Row) => item.passed));
  });
  it("switches a running session on its next provider request and persists the model history", async () => {
    const saved = await request("/api/providers", { id: "local-next", name: "Next scripted adapter", baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`, model: "next-model", apiKey: "local-key", allowLoopbackHttp: true }); assert.equal(saved.status, 200);
    const id = await create("Read sample.txt");
    let ready!: () => void, pending!: ServerResponse; const arrived = new Promise<void>((resolve) => { ready = resolve; });
    script.push((req, res) => { assert.equal(req.model, "local-scripted"); pending = res; ready(); }, (req, res) => { assert.equal(req.model, "next-model"); reply(res, { content: "The next model read the tool result.\nEvidence: E1" }); });
    const running = run(id); await arrived;
    const switched = await request(`/api/sessions/${id}/model`, { selection: "local-next/next-model" }); assert.equal(switched.status, 200, await switched.clone().text()); assert.equal((await switched.json() as Row).applied, "next_request");
    const compactBusy = await request(`/api/sessions/${id}/compact`, {}); assert.equal(compactBusy.status, 409);
    reply(pending, { tool_calls: [call("switch-read", "read", { path: "sample.txt" })] });
    const result = await running; assert.equal(result.status, 200, await result.clone().text()); assert.equal((await result.json() as Row).status, "completed");
    const description = await (await request(`/api/sessions/${id}/model`)).json() as Row;
    assert.equal(description.model_selection.provider_id, "local-next"); assert.equal(description.model_history.at(-1).effect, "next_request");
  });
  // Step 4: with a saved model selection the route asks that model for the ZCode summary.
  it("manually compacts with the session model through the ZCode summary", async () => {
    const id = await create("Original manual requirement"); const store = new SessionStore(join(base, "state")); const session = await store.load(id);
    session.model_selection = { provider_id: "local-agent", model: "local-scripted", reasoning_effort: null };
    (session.messages as Row[]).push({ role: "assistant", content: "First answer" }, { role: "user", content: "Second question" }, { role: "assistant", content: "Second answer" }); await store.save(session);
    let summaryPrompt = "";
    script.push((req, res) => { summaryPrompt = String(req.messages.at(-1).content); reply(res, { content: "<summary>1. Primary Request and Intent: Original manual requirement</summary>" }); });
    const response = await request(`/api/sessions/${id}/compact`, { instructions: "Retain the questions" });
    assert.equal(response.status, 200, await response.clone().text()); const result = await response.json() as Row;
    assert.equal(result.kind, "zcode"); assert.equal(result.compacted, true); assert.equal(result.source, "http"); assert.equal(result.compactions[0].trigger, "manual");
    assert.ok(summaryPrompt.includes("Additional Instructions:\nRetain the questions"));
    const compacted = await store.load(id); assert.equal((compacted.messages as Row[]).length, 2); assert.equal((compacted.messages as Row[])[1]!._compact_summary, true);
    assert.ok(String((compacted.messages as Row[])[1]!.content).includes("Summary:\n1. Primary Request and Intent: Original manual requirement"));
  });
  // Without a saved model selection the route keeps the deterministic Xueness compaction.
  it("manually compacts the durable journal deterministically when the session has no model selection", async () => {
    const id = await create("Keep this original requirement"); const store = new SessionStore(join(base, "state")); const session = await store.load(id);
    (session.messages as Row[]).push(...Array.from({ length: 16 }, (_, i) => ({ role: "assistant", content: `Observation ${i}: ` + "verified text ".repeat(300) })), { role: "user", content: "Keep this latest constraint" }); await store.save(session);
    const response = await request(`/api/sessions/${id}/compact`, { instructions: "Retain observed verification" });
    assert.equal(response.status, 200, await response.clone().text()); const result = await response.json() as Row; assert.equal(result.compacted, true); assert.equal(result.source, "http");
    const compacted = await store.load(id); assert.deepEqual((compacted.messages as Row[]).filter((row) => row.role === "user").map((row) => row.content), ["Keep this original requirement", "Keep this latest constraint"]);
    assert.ok((compacted.archived_messages as Row[]).length > 0);
  });
  it("independently verifies and continues a native goal before draining queued user turns", async () => {
    const id = await create("Explain both criteria");
    const goal = await request(`/api/sessions/${id}/goal`, { text: "Explain criterion one and criterion two", budget: { maxRounds: 3, maxWallSeconds: 120 } }); assert.equal(goal.status, 200, await goal.clone().text());
    let ready!: () => void, pending!: ServerResponse; const arrived = new Promise<void>((resolve) => { ready = resolve; });
    script.push((_req, res) => { pending = res; ready(); }, (req, res) => {
      const payload = JSON.parse(req.messages[1].content); assert.ok(req.messages[0].content.includes("independent completion verifier"));
      reply(res, { content: JSON.stringify({ passed: false, reason: "Criterion two is missing.", remaining: ["Explain criterion two"], evidenceIds: [payload.evidence.at(-1).id] }) });
    }, (req, res) => {
      assert.ok(req.messages.at(-1).content.includes("核验发现仍需处理")); assert.ok(!req.messages.some((row: Row) => row.content === "Queued question")); reply(res, { content: "Criterion one is explained. Criterion two is also explained." });
    }, (req, res) => {
      const payload = JSON.parse(req.messages[1].content); reply(res, { content: JSON.stringify({ passed: true, reason: "Both requested criteria are explained.", remaining: [], evidenceIds: [payload.evidence.at(-1).id] }) });
    }, (req, res) => { assert.equal(req.messages.at(-1).content, "Queued question"); reply(res, { content: "Queued answer" }); });
    const running = run(id); await arrived;
    const queued = await request(`/api/sessions/${id}/queue`, { text: "Queued question", request_id: "f".repeat(32) }); assert.equal(queued.status, 202, await queued.clone().text());
    const busyEdit = await request(`/api/sessions/${id}/goal`, { action: "pause" }); assert.equal(busyEdit.status, 409);
    reply(pending, { content: "Criterion one is explained." });
    const response = await running; assert.equal(response.status, 200, await response.clone().text()); const result = await response.json() as Row; assert.equal(result.status, "completed"); assert.equal(result.steps, 3);
    const persisted = await (await request(`/api/sessions/${id}/goal`)).json() as Row; assert.equal(persisted.goal.status, "complete"); assert.equal(persisted.goal.runtime.rounds, 2); assert.equal(persisted.goal.verification.kind, "independent_model_verifier");
  });
  it("runs planning task tools, pauses for a structured question and admits its exact answer once", async () => {
    const id = await create("Choose a color");
    script.push((req, res) => {
      const ask = req.tools.find((tool: Row) => tool.function.name === "AskUserQuestion"); assert.ok(ask.function.parameters.properties.questions); assert.ok(!req.tools.some((tool: Row) => tool.function.name === "ask_user"));
      reply(res, { tool_calls: [call("todo", "todo_write", { todos: [{ id: "choice", text: "Get the explicit color choice", status: "in_progress" }] }), call("question", "ask_user", { question: "Which color?", questions: [{ id: "color", header: "Color", question: "Choose a color", options: [{ label: "Blue", description: "Use blue" }, { label: "Green", description: "Use green" }] }] })] });
    });
    const paused = await run(id); assert.equal(paused.status, 200, await paused.clone().text()); assert.equal((await paused.json() as Row).status, "awaiting_user");
    const pending = await (await request(`/api/sessions/${id}/question`)).json() as Row; assert.equal(pending.question.questions[0].id, "color");
    const body = { questionId: pending.question.id, answers: { color: { selected: ["Blue"] } } };
    const accepted = await request(`/api/sessions/${id}/answer-question`, body); assert.equal(accepted.status, 200, await accepted.clone().text()); assert.equal((await accepted.json() as Row).alreadyAnswered, false);
    const duplicate = await request(`/api/sessions/${id}/answer-question`, body); assert.equal(duplicate.status, 200); assert.equal((await duplicate.json() as Row).alreadyAnswered, true);
    script.push((req, res) => { assert.ok(req.messages.at(-1).content.includes("[color] Color: Blue")); reply(res, { content: "Blue is selected." }); });
    const result = await run(id); assert.equal(result.status, 200, await result.clone().text()); assert.equal((await result.json() as Row).status, "completed");
    const journal = await new SessionStore(join(base, "state")).load(id); assert.equal((journal.todos as Row[])[0]!.id, "choice"); assert.equal((journal.messages as Row[]).filter((row) => row.role === "user" && String(row.content).includes("[color] Color: Blue")).length, 1);
  });
  it("generates one bounded background title with the completed run's local adapter", async () => {
    writeFileSync(join(base, "state", "settings.json"), JSON.stringify({ general: { sessionsAutoTitleEnabled: true } }));
    const id = await create("A greeting exchange");
    script.push((_req, res) => reply(res, { content: "Hello from the completed exchange" }), (req, res) => {
      assert.ok(!req.tools || req.tools.length === 0); assert.ok(req.max_tokens <= 256); assert.ok(req.messages[0].content.includes("Generate a short conversation title"));
      reply(res, { content: '{"title":"Local conversation title"}' });
    });
    const response = await run(id); assert.equal(response.status, 200, await response.clone().text());
    let detail: Row = {}; const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { detail = await (await request(`/api/sessions/${id}`)).json() as Row; if (detail.title === "Local conversation title") break; await new Promise((resolve) => setTimeout(resolve, 25)); }
    assert.equal(detail.title, "Local conversation title"); assert.equal((await new SessionStore(join(base, "state")).load(id)).title_source, "generated"); assert.deepEqual(modelFailures, []);
    writeFileSync(join(base, "state", "settings.json"), JSON.stringify({ general: { sessionsAutoTitleEnabled: false } }));
  });
});
