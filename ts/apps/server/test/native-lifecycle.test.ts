import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createApplicationApi } from "../src/application-api.ts";
import { createFrontDoor } from "../src/front-door.ts";
import { PROJECT_ROOT } from "../../../test-support/python-oracle.ts";
type Row = Record<string, any>;
it("runs the integrated local provider lifecycle with workspace grants, exact approvals and receipts", async () => {
  const base = mkdtempSync(join(tmpdir(), "xue-native-life-")), root = join(base, "selected-workspace"), state = join(base, "state"), runs = join(base, "runs");
  mkdirSync(root); mkdirSync(state);
  writeFileSync(join(state, "settings.json"), JSON.stringify({ workspace: { selectedRoots: [root], defaultRoot: root }, general: { sessionsAutoTitleEnabled: false } }));
  let providerCalls = 0;
  const provider = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")); assert.equal(req.url, "/v1/chat/completions");
    assert.equal(body.model, "local-fixture"); providerCalls++;
    const delta = providerCalls === 1 ? { tool_calls: [{ index: 0, id: "write-one", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "result.txt", content: "approved 中\n" }) } }] } : { content: "Applied update.\nEvidence: E1" };
    res.setHeader("Content-Type", "text/event-stream");
    res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
  const api = await createApplicationApi({ projectRoot: PROJECT_ROOT, stateDir: state, webRuns: runs, allowReal: true });
  const front = createFrontDoor({ webappDir: join(PROJECT_ROOT, "webapp/dist"), api });
  await new Promise<void>((done) => front.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(front.address() as { port: number }).port}`;
  const request = async (path: string, data?: unknown) => {
    const response = await fetch(origin + path, { method: data === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": api.csrfToken }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const value = await response.json() as Row; assert.equal(response.status, 200, JSON.stringify(value)); return value;
  };
  try {
    await request("/api/providers", { id: "local", name: "Scripted localhost", baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`, model: "local-fixture", apiKey: "fixture", allowLoopbackHttp: true });
    const { id, root: actualRoot } = await request("/api/sessions", { task: "Apply update" });
    assert.equal(actualRoot, root);
    // In-process approval: the run waits on the write; answering it finishes the same run.
    const running = request(`/api/sessions/${id}/run`, { provider_id: "local", steps: 3 });
    let waiting: Row | undefined;
    for (let round = 0; round < 400 && !waiting; round += 1) {
      waiting = ((await request(`/api/sessions/${id}`)).pending ?? []).find((row: Row) => row.waiting === true);
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(waiting); assert.equal(waiting.tool_call_id, "write-one"); assert.equal(waiting.granted, false); assert.equal(providerCalls, 1);
    const answer = await request(`/api/sessions/${id}/approvals`, { kind: "write", tool_call_id: "write-one", subject: "result.txt" }); assert.equal(answer.resumed, true);
    const completed = await running; assert.equal(completed.status, "completed", JSON.stringify({ completed, stats: front.stats(), journal: await request(`/api/sessions/${id}/journal`) })); assert.equal(completed.completion.verified, true);
    assert.equal(providerCalls, 2); assert.equal(readFileSync(join(root, "result.txt"), "utf8"), "approved 中\n");
    const commandId = `c_${Date.now()}_${"1".repeat(32)}`, command = { commandId, type: "send", payload: { text: "Explain the update" } };
    const sent = await request(`/api/sessions/${id}/commands`, command); assert.equal(sent.status, "accepted");
    const duplicate = await request(`/api/sessions/${id}/commands`, command); assert.equal(duplicate.status, "duplicate");
    const journal = await request(`/api/sessions/${id}/journal`); assert.equal(journal.messages.filter((row: Row) => row.role === "user" && row.content === "Explain the update").length, 1);
  } finally {
    front.closeAllConnections(); await new Promise<void>((done) => front.close(() => done()));
    await api.close(); provider.closeAllConnections(); await new Promise<void>((done) => provider.close(() => done()));
    rmSync(base, { recursive: true, force: true });
  }
});
