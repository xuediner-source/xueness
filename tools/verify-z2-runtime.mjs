import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ScriptedServer } from "../ts/packages/providers/test/support/scripted-server.ts";
import { chunk, events, SSE_HEAD, USAGE_CHUNK } from "../ts/packages/providers/test/support/http-fixtures.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsRoot = join(projectRoot, "ts");
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--built")) throw new Error(`unsupported argument: ${args.find((arg) => arg !== "--built")}`);
const mode = args.includes("--built") ? "built" : "source";
const packageRoot = join(tsRoot, mode === "built" ? "dist/package.json" : "package.json");
const workspaceRequire = createRequire(packageRoot);
const packageUrl = (specifier) => pathToFileURL(workspaceRequire.resolve(specifier)).href;

if (mode === "built" && !existsSync(join(tsRoot, "dist/node_modules/@xueness/providers/src/index.js"))) {
  throw new Error("built output is missing; run the project build, then rerun with --built");
}

const [providers, sessions, sessionsPlugin, engineTools, serverModule] = await Promise.all([
  import(packageUrl("@xueness/providers")),
  import(packageUrl("@xueness/sessions")),
  import(packageUrl("@xueness/plugin-sessions")),
  import(packageUrl("@xueness/engine-tools")),
  // Keep this import canonical: the package alias can resolve to a stale distribution.
  import(pathToFileURL(join(tsRoot, mode === "built" ? "dist/apps/server/src/agent-service.js" : "apps/server/src/agent-service.ts")).href),
]);
const { OpenAICompatible } = providers;
const { SessionStore } = sessions;
const { SteeringInbox } = sessionsPlugin;
const { BackgroundTasks } = engineTools;
const { createAgentService } = serverModule;

const server = await ScriptedServer.start();
const checks = [];
const failures = [];
const activeRuns = new Set();
const scenarioRequestIds = new Map();
const startedAt = performance.now();
let currentScenario = "setup";

function scratch(label) {
  const parent = mkdtempSync(join(tmpdir(), `xueness-verify-z2-runtime-${label}-`));
  const root = join(parent, "workspace");
  const state = join(parent, "state");
  mkdirSync(root, { recursive: true });
  mkdirSync(state, { recursive: true });
  const store = new SessionStore(join(state, "sessions"));
  return {
    parent, root, state, store,
    close() {
      const tempParent = resolve(tmpdir());
      const tempPath = resolve(parent);
      if (dirname(tempPath) !== tempParent || !basename(tempPath).startsWith("xueness-verify-z2-runtime-")) {
        throw new Error("refusing to remove the unexpected verification temp path");
      }
      rmSync(tempPath, { recursive: true, force: true });
    },
  };
}

const policy = () => ({ mode: "build", permissionMode: "build", disallowed: [], selection: {}, request: {} });
const enabled = (id) => ["sessions", "providers", "files", "shell", "verify_probe"].includes(id);

function serviceFor(local, options = {}) {
  return createAgentService({
    store: local.store,
    stateDir: local.state,
    enabled,
    settings: () => ({}),
    allowModelRequests: false,
    approver: () => () => ({ behavior: "allow" }),
    ...(options.extensions ? { extensions: () => options.extensions } : {}),
  });
}

function providerFor(id) {
  return new OpenAICompatible({
    base: server.base("ts", id), model: "z2-runtime-local", key: "local-test-key", allowLoopbackHttp: true, env: {},
  });
}

function toolResponse(id, name, input) {
  return SSE_HEAD + events([chunk({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(input) } }] }, "tool_calls"), USAGE_CHUNK]);
}

function textResponse(text) {
  return SSE_HEAD + events([chunk({ content: text }, "stop"), USAGE_CHUNK]);
}

async function waitForRequest(id, count, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  while (server.requests("ts", id).length < count) {
    if (performance.now() >= deadline) throw new Error(`local HTTP server did not receive request ${count} for ${id}`);
    await delay(10);
  }
}

function requestBody(id, index) {
  const request = server.requests("ts", id)[index - 1];
  assert.ok(request, `missing HTTP request ${index} for ${id}`);
  return JSON.parse(request.body);
}

function probeExtension(turnIds) {
  return { id: "verify_probe", beforeModelRequest(context) { turnIds.push(String(context.session.active_turn_id ?? "")); } };
}

async function runScenario(name, fn) {
  currentScenario = name;
  try {
    checks.push({ name, ...(await fn()) });
  } catch (error) {
    const id = scenarioRequestIds.get(name);
    failures.push({ name, requests: id ? server.requests("ts", id).length : 0, error: error instanceof Error ? error.message : String(error) });
  }
}

async function scenarioReadStateSurvivesServiceRestart() {
  const id = "z2-runtime-read-write";
  scenarioRequestIds.set("read_state_survives_service_restart", id);
  const local = scratch("read-write");
  const path = join(local.root, "memo.txt");
  const original = "read-state-content-世界\n";
  writeFileSync(path, original, "utf8");
  server.script(id, [
    toolResponse("read-call", "Read", { file_path: path }),
    textResponse("Read complete."),
    toolResponse("write-call", "Write", { file_path: path, content: "write-after-restart-世界\n" }),
    textResponse("Write complete."),
  ]);

  let firstService;
  let secondService;
  let running;
  try {
    let session = await local.store.new("Read and then update memo.txt", local.root);
    firstService = serviceFor(local);
    running = firstService.createRunner(session, providerFor(id), policy()).run(session, { maxWallSeconds: 20, maxSteps: 8 });
    activeRuns.add(running);
    await running;
    activeRuns.delete(running);
    assert.equal(session.status, "completed");
    await firstService.dispose();
    firstService = null;

    session = await local.store.load(String(session.id));
    const readMessage = session.messages.find((message) => message.role === "tool" && message.tool_call_id === "read-call");
    assert.ok(readMessage?._read_state, "the successful Read journal message keeps private _read_state");
    assert.equal(readMessage._read_state.snapshot.sha256, createHash("sha256").update(original).digest("hex"));
    assert.equal(Object.hasOwn(session.results["read-call"], "_read_state"), false, "results omit private _read_state");
    assert.equal(JSON.stringify(requestBody(id, 2).messages).includes("_read_state"), false, "the provider wire omits private _read_state");

    const { appendUserTurn } = await import(packageUrl("@xueness/agent"));
    await appendUserTurn(session, local.store, "Update the same file to the requested new text.");
    secondService = serviceFor(local);
    running = secondService.createRunner(session, providerFor(id), policy()).run(session, { maxWallSeconds: 20, maxSteps: 8 });
    activeRuns.add(running);
    await running;
    activeRuns.delete(running);
    assert.equal(session.status, "completed");
    assert.equal(readFileSync(path, "utf8"), "write-after-restart-世界\n");
    assert.equal(session.messages.filter((message) => message.role === "assistant" && Array.isArray(message.tool_calls)
      && message.tool_calls.some((call) => call.id === "read-call")).length, 1, "the old Read call was not repeated");
    assert.equal(session.results["write-call"]?.ok, true);
    assert.equal(server.requests("ts", id).length, 4);
    return { requests: 4, readStateHashRestored: true, readStatePrivate: true, writeSucceededWithoutReread: true };
  } finally {
    if (running) activeRuns.delete(running);
    if (firstService) await firstService.dispose();
    if (secondService) await secondService.dispose();
    local.close();
  }
}

async function scenarioInterruptedHistoryIsPairedWithoutReplay() {
  const id = "z2-runtime-interrupted-history";
  scenarioRequestIds.set("interrupted_history_is_paired_without_replay", id);
  const local = scratch("interrupted-history");
  const forbiddenWrite = join(local.root, "must-not-be-created.txt");
  server.script(id, [textResponse("Resumed without repeating the interrupted tool.")]);
  let service;
  let running;
  try {
    const session = await local.store.new("Resume safely", local.root);
    session.status = "paused";
    session.messages.push({ role: "assistant", content: "", tool_calls: [{ id: "interrupted-write", type: "function", function: {
      name: "Write", arguments: JSON.stringify({ file_path: forbiddenWrite, content: "must not run" }),
    } }] });
    await local.store.save(session);
    service = serviceFor(local);
    running = service.createRunner(session, providerFor(id), policy()).run(session, { maxWallSeconds: 20, maxSteps: 8 });
    activeRuns.add(running);
    await running;
    activeRuns.delete(running);
    const wire = requestBody(id, 1).messages;
    const paired = wire.find((message) => message.role === "tool" && message.tool_call_id === "interrupted-write");
    assert.ok(paired, "resume sends a paired tool result for the interrupted call");
    assert.match(String(paired.content), /Tool execution was interrupted before resume/);
    assert.equal(session.results["interrupted-write"]?.error?.code, "tool_interrupted");
    assert.equal(readFileCheck(forbiddenWrite), false, "the old Write side effect did not run again");
    assert.equal(server.requests("ts", id).length, 1);
    return { requests: 1, interruptedPairSent: true, oldToolEffectReplayed: false };
  } finally {
    if (running) activeRuns.delete(running);
    if (service) await service.dispose();
    local.close();
  }
}

function readFileCheck(path) {
  try { readFileSync(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

async function scenarioSteeringArrivesDuringDelayedRequest() {
  const id = "z2-runtime-steering";
  scenarioRequestIds.set("steering_arrives_during_delayed_request", id);
  const local = scratch("steering");
  const guide = "GUIDE_SENTINEL: keep the answer under twelve words.";
  server.script(id, [[{ delay: 200 }, textResponse("Initial response." )], textResponse("Followed the guide.")]);
  const turnIds = [];
  const probe = probeExtension(turnIds);
  let service;
  let running;
  try {
    const session = await local.store.new("Respond to the request", local.root);
    service = serviceFor(local, { extensions: [probe] });
    running = service.createRunner(session, providerFor(id), policy()).run(session, { maxWallSeconds: 20, maxSteps: 8 });
    activeRuns.add(running);
    await waitForRequest(id, 1);
    const turnId = String(session.active_turn_id ?? "");
    assert.ok(turnId, "the current turn is active while the HTTP response is delayed");
    const inbox = new SteeringInbox(local.store);
    await inbox.locked(String(session.id), () => inbox.admitLocked(
      String(session.id), guide, turnId, randomBytes(16).toString("hex"), createHash("sha256").update(guide).digest("hex"),
    ));
    await running;
    activeRuns.delete(running);
    assert.equal(session.status, "completed");
    assert.equal(server.requests("ts", id).length, 2);
    const secondMessages = requestBody(id, 2).messages;
    assert.ok(secondMessages.some((message) => message.role === "user" && String(message.content).includes(guide)), "the delayed guide appears in the next HTTP request");
    assert.equal(turnIds.length, 2);
    assert.ok(turnIds.every((value) => value === turnId), "both model boundaries keep the same active turn id");
    const receipt = inbox.read(String(session.id)).items[0];
    assert.equal(receipt?.status, "completed");
    return { requests: 2, sameTurn: true, guideIncludedInSecondRequest: true, receipt: receipt.status };
  } finally {
    if (running) activeRuns.delete(running);
    if (service) await service.dispose();
    local.close();
  }
}

async function scenarioBackgroundNoticeDoesNotConsumeOutput() {
  const id = "z2-runtime-background-notice";
  scenarioRequestIds.set("background_notice_does_not_consume_output", id);
  const local = scratch("background-notice");
  const sentinel = "Z2_BACKGROUND_OUTPUT_SENTINEL";
  const source = `setTimeout(()=>process.stdout.write(String.fromCharCode(${[...Buffer.from(sentinel)].join(",")})),300)`;
  server.script(id, [
    // The legacy internal exec name accepts argv directly, so the background
    // child is exactly process.execPath on every host (no shell or external command).
    toolResponse("background-start", "exec", { argv: [process.execPath, "-e", source], background: true }),
    [{ delay: 750 }, textResponse("Second model response after background task completion.")],
    textResponse("The task completed and its output remains available.") ,
  ]);
  const turnIds = [];
  const probe = probeExtension(turnIds);
  const originalRead = BackgroundTasks.prototype.read;
  let readCalls = 0;
  BackgroundTasks.prototype.read = function (...args) {
    readCalls += 1;
    return originalRead.apply(this, args);
  };
  let service;
  let running;
  try {
    const session = await local.store.new("Run a short background task", local.root);
    service = serviceFor(local, { extensions: [probe] });
    running = service.createRunner(session, providerFor(id), policy()).run(session, { maxWallSeconds: 20, maxSteps: 8 });
    activeRuns.add(running);
    await waitForRequest(id, 2);
    await running;
    activeRuns.delete(running);
    assert.equal(session.status, "completed");
    const requestCount = server.requests("ts", id).length;
    assert.ok(requestCount === 2 || requestCount === 3, `expected two or three model requests, got ${requestCount}`);
    const secondMessages = requestBody(id, 2).messages;
    const secondTool = secondMessages.find((message) => message.role === "tool" && message.tool_call_id === "background-start");
    assert.match(String(secondTool?.content), /Command running in background with ID: bg_[0-9a-f]{8}/);
    const taskId = String(String(secondTool.content).match(/bg_[0-9a-f]{8}/)?.[0] ?? "");
    assert.ok(taskId);
    const noticeRequestIndex = Array.from({ length: requestCount - 1 }, (_, index) => index + 2)
      .find((index) => requestBody(id, index).messages.some((message) => message.role === "user" && String(message.content).includes(`Background task ${taskId} reached terminal state`)));
    assert.ok(noticeRequestIndex, `a following HTTP request includes the terminal notice: ${JSON.stringify({ requestCount, turnIds, backgroundTasks: session.background_tasks, notices: session.messages.filter((message) => message._input_kind === "background_notice"), secondTool: requestBody(id, 2).messages.find((message) => message.role === "tool" && message.tool_call_id === "background-start") })}`);
    const terminalMessages = requestBody(id, noticeRequestIndex).messages.filter((message) => message.role === "user" && String(message.content).includes(`Background task ${taskId} reached terminal state`));
    assert.equal(terminalMessages.length, 1, "the following HTTP request contains one terminal notice");
    assert.match(String(terminalMessages[0].content), /TaskOutput/);
    const journalNotices = session.messages.filter((message) => message.role === "user" && message._input_kind === "background_notice");
    assert.equal(journalNotices.length, 1);
    assert.equal(session.messages.filter((message) => message.role === "user" && message._input_kind !== "background_notice").length, 1,
      "the notice did not become a genuine user turn");
    assert.equal(turnIds.length, requestCount);
    assert.ok(turnIds.every((value) => value === turnIds[0] && value.length > 0), "the notification continuation stays in the original turn");
    assert.equal(readCalls, 0, "the notification path never calls TaskOutput's incremental read");
    const summary = session.background_tasks?.find((task) => task.id === taskId);
    assert.ok(summary && summary.state === "exited" && summary.exitCode === 0 && summary.stdoutBytes === Buffer.byteLength(sentinel));
    assert.equal(readFileSync(summary.stdoutPath, "utf8"), sentinel, "the completed task output remains on its log");
    return { requests: requestCount, taskId, terminalNoticeCount: journalNotices.length, noticeRequestIndex, sameTurn: true, taskOutputReadCalls: readCalls, outputLogRetained: true };
  } finally {
    BackgroundTasks.prototype.read = originalRead;
    if (running) activeRuns.delete(running);
    if (service) await service.dispose();
    local.close();
  }
}

try {
  await runScenario("read_state_survives_service_restart", scenarioReadStateSurvivesServiceRestart);
  await runScenario("interrupted_history_is_paired_without_replay", scenarioInterruptedHistoryIsPairedWithoutReplay);
  await runScenario("steering_arrives_during_delayed_request", scenarioSteeringArrivesDuringDelayedRequest);
  await runScenario("background_notice_does_not_consume_output", scenarioBackgroundNoticeDoesNotConsumeOutput);
  const totalRequests = [...scenarioRequestIds.values()].reduce((sum, id) => sum + server.requests("ts", id).length, 0);
  const report = {
    ok: failures.length === 0,
    mode,
    network: "loopback-only",
    scenarios: checks,
    failures,
    totalScenarios: checks.length + failures.length,
    totalRequests,
    elapsedMs: Math.round(performance.now() - startedAt),
  };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (failures.length) process.exitCode = 1;
} finally {
  for (const pending of activeRuns) await Promise.allSettled([pending]);
  await server.close();
}
