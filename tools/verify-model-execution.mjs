import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ScriptedServer } from "../ts/packages/providers/test/support/scripted-server.ts";
import {
  MESSAGE_START, SSE_HEAD, chunk, event, events, json, messageEnd,
} from "../ts/packages/providers/test/support/http-fixtures.ts";

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

const [providers, agent, sessions, providerPlugin] = await Promise.all([
  import(packageUrl("@xueness/providers")),
  import(packageUrl("@xueness/agent")),
  import(packageUrl("@xueness/sessions")),
  import(packageUrl("@xueness/plugin-providers")),
]);
const { AgentRunner } = agent;
const { SessionStore } = sessions;
const { OpenAICompatible, AnthropicMessages, ProviderRequestError } = providers;
const { providerActivityExtension } = providerPlugin;

const toolSchemas = [{ type: "function", function: {
  name: "read", description: "Read a local test value", parameters: { type: "object", properties: { path: { type: "string" } } },
} }];
const server = await ScriptedServer.start();
const tempRoot = mkdtempSync(join(tmpdir(), "xueness-verify-model-execution-"));
const runners = new Set();
const activeRuns = new Set();
const checks = [];
let currentScenario = "setup";
const startedAt = performance.now();

function makeOpenAi(id) {
  return new OpenAICompatible({ base: server.base("ts", id), model: "gpt-4o", key: "local-test-key", allowLoopbackHttp: true, env: {} });
}

function makeAnthropic(id) {
  return new AnthropicMessages({ base: server.base("ts", id), model: "claude-3-5-sonnet-latest", key: "local-test-key", allowLoopbackHttp: true, env: {} });
}

function createRun(id, provider, { extensions = [], toolObservations = [], toolCalls = { count: 0 }, eventsSeen = [] } = {}) {
  const root = join(tempRoot, id);
  mkdirSync(root, { recursive: true });
  const store = new SessionStore(join(root, "state"));
  const session = {
    id: randomBytes(16).toString("hex"), root, task: "Verify local model execution", status: "pending", steps: 0,
    messages: [{ role: "system", content: "You are a concise local test assistant." }, { role: "user", content: "Complete the local test task." }],
    results: {}, compactions: [], archived_messages: [], completion: null,
  };
  const observer = { id: "files", observeToolDelta(_context, snapshot) { toolObservations.push(String(snapshot.call_id)); } };
  const hooks = {
    enabled: (id) => ["providers", "sessions", "files"].includes(id),
    toolOwner: (name) => name === "read" ? "files" : null,
    tools: async () => toolSchemas,
    extensions: [...extensions, observer],
    propagateCancellation: () => true,
  };
  const toolBridge = {
    async call() { toolCalls.count += 1; return { ok: true, content: "local read result" }; },
    async callAll() { throw new Error("the script does not use batch calls"); },
  };
  const runner = new AgentRunner({ root, store, provider, hooks, toolBridge, onEvent: (event) => eventsSeen.push(event) });
  runners.add({ runner, session });
  return { root, store, session, runner, toolCalls, toolObservations, eventsSeen };
}

function beginRun(local, options = {}) {
  const promise = local.runner.run(local.session, { maxWallSeconds: 3, ...options });
  activeRuns.add(promise);
  promise.then(() => activeRuns.delete(promise), () => activeRuns.delete(promise));
  return promise;
}

async function failureOf(promise, check) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof check, `expected ${check.name}, received ${error?.constructor?.name ?? typeof error}`);
    return error;
  }
  assert.fail(`expected ${check.name}`);
}

function quickRetry(overrides = {}) {
  return { baseDelayMs: 0, jitter: false, maxAttempts: 2, random: () => 0, ...overrides };
}

function record(name, local, extra = {}) {
  checks.push({
    name, requests: server.requests("ts", name).length,
    status: local.session.status, ...extra,
  });
}

async function waitForRequest(id, timeoutMs = 1_000) {
  const end = performance.now() + timeoutMs;
  while (!server.requests("ts", id).length) {
    if (performance.now() >= end) throw new Error(`local server did not receive ${id} request`);
    await delay(10);
  }
}

async function scenarioEmptyRetry() {
  currentScenario = "openai_empty_finish_zero_usage";
  const id = currentScenario;
  server.script(id, [
    SSE_HEAD + events([
      chunk({}, "length"),
      { id: "empty", choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
    ]),
    SSE_HEAD + events([chunk({ content: "recovered after empty finish" }, "stop")]),
  ]);
  const local = createRun(id, makeOpenAi(id));
  await beginRun(local, { modelRetry: quickRetry() });
  assert.equal(server.requests("ts", id).length, 2);
  assert.equal(local.session.status, "completed");
  assert.equal(local.session.messages.at(-1)?.content, "recovered after empty finish");
  assert.equal(local.eventsSeen.filter((item) => item.type === "model_retry_scheduled").length, 1);
  record(currentScenario, local, { modelRetries: 1, finish: "stop" });
}

async function scenarioToolPreludeRetry() {
  currentScenario = "openai_tool_prelude_error_retry";
  const id = currentScenario;
  const partialTool = chunk({ tool_calls: [{ index: 0, id: "discarded-prelude", type: "function", function: { name: "read", arguments: "{\"path\":" } }] });
  const streamError = events([{ error: { status: 503, message: "local scripted failure" } }], { done: false });
  const acceptedTool = chunk({ tool_calls: [{ index: 0, id: "accepted-tool", type: "function", function: { name: "read", arguments: "{\"path\":\"README.md\"}" } }] }, "tool_calls");
  server.script(id, [
    [SSE_HEAD + events([partialTool], { done: false }), streamError],
    SSE_HEAD + events([acceptedTool]),
    SSE_HEAD + events([chunk({ content: "read complete" }, "stop")]),
  ]);
  const local = createRun(id, makeOpenAi(id));
  await beginRun(local, { modelRetry: quickRetry() });
  assert.equal(server.requests("ts", id).length, 3);
  assert.deepEqual(local.toolObservations, ["accepted-tool"]);
  assert.equal(local.toolCalls.count, 1);
  assert.equal(local.eventsSeen.filter((item) => item.type === "model_retry_scheduled").length, 1);
  assert.equal(local.session.status, "completed");
  record(currentScenario, local, { observedToolIds: local.toolObservations, executedTools: local.toolCalls.count });
}

async function scenarioCommittedPartial() {
  currentScenario = "openai_visible_partial_503_no_replay";
  const id = currentScenario;
  const errorFrame = events([{ error: { status: 503, message: "local scripted failure" } }], { done: false });
  server.script(id, [[
    SSE_HEAD + events([chunk({ content: "visible partial answer" })], { done: false }), errorFrame,
  ]]);
  const local = createRun(id, makeOpenAi(id));
  await failureOf(beginRun(local, { modelRetry: quickRetry() }), ProviderRequestError);
  assert.equal(server.requests("ts", id).length, 1);
  assert.equal(local.eventsSeen.filter((item) => item.type === "model_retry_scheduled").length, 0);
  assert.equal(local.session.status, "provider_error");
  assert.equal(local.session.streaming?.text, "visible partial answer");
  assert.equal(local.session.streaming?.status, "interrupted");
  record(currentScenario, local, { modelRetries: 0, retainedPartial: local.session.streaming.text });
}

async function scenarioLocalizedUnauthorized() {
  currentScenario = "openai_401_localized_persisted";
  const id = currentScenario;
  server.script(id, [json(401, { error: { message: "local scripted unauthorized" } })]);
  const local = createRun(id, makeOpenAi(id), { extensions: [providerActivityExtension()] });
  await failureOf(beginRun(local, { modelRetry: quickRetry() }), ProviderRequestError);
  const failure = local.session.model_failure;
  const persisted = await local.store.load(local.session.id);
  assert.equal(server.requests("ts", id).length, 1);
  assert.equal(local.session.status, "provider_error");
  assert.equal(failure?.errorCode, "provider_not_configured");
  assert.equal(failure?.messageZh, "模型服务认证失败，请检查 API 密钥和账号权限。");
  assert.deepEqual(persisted.model_failure, failure);
  record(currentScenario, local, { errorCode: failure.errorCode, localized: true, persisted: true });
}

async function scenarioIdleTimeoutRetry() {
  currentScenario = "openai_idle_timeout_retry";
  const id = currentScenario;
  const comments = [SSE_HEAD];
  for (let index = 0; index < 10; index += 1) comments.push({ delay: 18 }, ": heartbeat\n\n");
  comments.push({ hang: true });
  server.script(id, [comments, SSE_HEAD + events([chunk({ content: "recovered after idle timeout" }, "stop")])]);
  const local = createRun(id, makeOpenAi(id));
  await beginRun(local, { modelRetry: quickRetry({ streamIdleTimeoutMs: 90 }) });
  assert.equal(server.requests("ts", id).length, 2);
  const failures = local.eventsSeen.filter((item) => item.type === "model_request_failed");
  assert.equal(failures[0]?.reason, "stream_idle_timeout");
  assert.equal(local.eventsSeen.filter((item) => item.type === "model_retry_scheduled").length, 1);
  assert.equal(local.session.status, "completed");
  record(currentScenario, local, { idleFailure: failures[0]?.reason, modelRetries: 1 });
}

async function scenarioAbortDuringIdle() {
  currentScenario = "openai_abort_idle_read";
  const id = currentScenario;
  server.script(id, [[SSE_HEAD, { hang: true }]]);
  const local = createRun(id, makeOpenAi(id));
  const startedAt = performance.now();
  const running = beginRun(local, { modelRetry: quickRetry({ streamIdleTimeoutMs: 600_000 }) });
  await waitForRequest(id);
  await delay(15);
  assert.equal(local.runner.cancel(local.session.id), true);
  await running;
  const elapsedMs = Math.round(performance.now() - startedAt);
  assert.equal(local.session.status, "stopped");
  assert.equal(server.requests("ts", id).length, 1);
  assert.equal(local.eventsSeen.filter((item) => item.type === "model_retry_scheduled").length, 0);
  assert.ok(elapsedMs < 500, `abort took ${elapsedMs} ms`);
  record(currentScenario, local, { abortElapsedMs: elapsedMs, modelRetries: 0 });
}

async function scenarioAnthropicPayloadRefresh() {
  currentScenario = "anthropic_data_refreshes_idle";
  const id = currentScenario;
  server.script(id, [[
    SSE_HEAD,
    { delay: 35 }, MESSAGE_START,
    { delay: 35 }, event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    { delay: 35 }, event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "anthropic payloads reset idle" } }),
    { delay: 35 }, event("content_block_stop", { index: 0 }),
    { delay: 35 }, ...messageEnd(),
  ]]);
  const local = createRun(id, makeAnthropic(id));
  await beginRun(local, { modelRetry: quickRetry({ maxAttempts: 1, streamIdleTimeoutMs: 100 }) });
  assert.equal(server.requests("ts", id).length, 1);
  assert.equal(local.session.status, "completed");
  assert.equal(local.session.messages.at(-1)?.content, "anthropic payloads reset idle");
  record(currentScenario, local, { payloads: 6, timeoutMs: 100 });
}

try {
  await scenarioEmptyRetry();
  await scenarioToolPreludeRetry();
  await scenarioCommittedPartial();
  await scenarioLocalizedUnauthorized();
  await scenarioIdleTimeoutRetry();
  await scenarioAbortDuringIdle();
  await scenarioAnthropicPayloadRefresh();
  process.stdout.write(`${JSON.stringify({
    ok: true, mode, network: "loopback-only", scenarios: checks,
    totalRequests: checks.reduce((sum, check) => sum + check.requests, 0),
    elapsedMs: Math.round(performance.now() - startedAt), temporaryDataCleaned: true,
  }, null, 2)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false, mode, scenario: currentScenario, completed: checks,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  for (const { runner, session } of runners) runner.cancel(String(session.id));
  await Promise.allSettled([...activeRuns]);
  await server.close();
  const tempParent = realpathSync(tmpdir());
  const tempPath = realpathSync(tempRoot);
  if (dirname(tempPath) !== tempParent || !basename(tempPath).startsWith("xueness-verify-model-execution-")) {
    throw new Error("refusing to remove the unexpected verification temp path");
  }
  rmSync(tempPath, { recursive: true, force: true });
}
