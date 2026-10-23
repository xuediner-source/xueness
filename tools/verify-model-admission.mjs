import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ScriptedServer } from "../ts/packages/providers/test/support/scripted-server.ts";
import { SSE_HEAD, chunk, events, json, USAGE_CHUNK } from "../ts/packages/providers/test/support/http-fixtures.ts";

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

const [providers, agent, sessions, providerPlugin, serverPlugin] = await Promise.all([
  import(packageUrl("@xueness/providers")),
  import(packageUrl("@xueness/agent")),
  import(packageUrl("@xueness/sessions")),
  import(packageUrl("@xueness/plugin-providers")),
  import(pathToFileURL(join(tsRoot, mode === "built" ? "dist/apps/server/src/front-door.js" : "apps/server/src/front-door.ts")).href),
]);
const { AgentRunner } = agent;
const { SessionStore } = sessions;
const { OpenAICompatible } = providers;
const { createProvidersApi, providerActivityExtension, providerModelExecutionExtension } = providerPlugin;
const { createFrontDoor } = serverPlugin;

const SERVER_ID = "model-admission-local";
const toolSchemas = [{ type: "function", function: {
  name: "local_read", description: "Local scripted tool", parameters: { type: "object", properties: { path: { type: "string" } } },
} }];
const server = await ScriptedServer.start();
const tempRoot = mkdtempSync(join(tmpdir(), "xueness-verify-model-admission-"));
const workspace = join(tempRoot, "workspace");
mkdirSync(workspace, { recursive: true });
const activeRuns = new Set();
const locals = new Set();
const frontDoors = new Set();
const checks = [];
let currentScenario = "setup";
const startedAt = performance.now();
const envBefore = new Map(["XUENESS_MODEL_MAX_CONCURRENT", "XUENESS_MODEL_DEBUG"].map((key) => [key, process.env[key]]));
process.env.XUENESS_MODEL_MAX_CONCURRENT = "1";
delete process.env.XUENESS_MODEL_DEBUG;

function makeLocal(label, stateDir, store, serverId = SERVER_ID) {
  const session = {
    id: randomBytes(16).toString("hex"), root: workspace, task: `Local model admission ${label}`, status: "pending", steps: 0,
    messages: [{ role: "system", content: `system marker ${label}` }, { role: "user", content: `user marker ${label}` }],
    results: {}, compactions: [], archived_messages: [], completion: null,
  };
  const eventsSeen = [];
  const hooks = {
    enabled: (id) => ["providers", "sessions", "files"].includes(id),
    toolOwner: (name) => name === "local_read" ? "files" : null,
    tools: async () => toolSchemas,
    extensions: [providerModelExecutionExtension(), providerActivityExtension()],
    propagateCancellation: () => true,
  };
  const provider = new OpenAICompatible({ base: server.base("ts", serverId), model: "local-admission-model", key: "local-test-key", allowLoopbackHttp: true, env: {} });
  const runner = new AgentRunner({ root: workspace, stateDir, store, provider, hooks,
    toolBridge: { async call() { return { ok: true, content: "unused local tool result" }; }, async callAll() { return []; } },
    onEvent: (event) => eventsSeen.push(event),
  });
  const local = { label, session, runner, eventsSeen, stateDir };
  locals.add(local);
  return local;
}

function beginRun(local, options = {}) {
  const promise = local.runner.run(local.session, { maxWallSeconds: 6, maxSteps: 3, ...options });
  activeRuns.add(promise);
  promise.then(() => activeRuns.delete(promise), () => activeRuns.delete(promise));
  return promise;
}

function quickRetry(overrides = {}) {
  return { baseDelayMs: 0, maxDelayMs: 0, jitter: false, maxAttempts: 2, random: () => 0, ...overrides };
}

function makeApi(stateDir, enabled = () => true) {
  return createProvidersApi({ stateDir, enabled: (id) => id === "providers" && enabled() });
}

async function apiSnapshot(api) {
  const reply = await api.dispatch("GET", ["api", "providers", "execution"], {}, undefined);
  assert.ok(Array.isArray(reply));
  assert.equal(reply[0], 200);
  return reply[1];
}

async function startApiHttp(api) {
  const front = createFrontDoor({ webappDir: join(projectRoot, "webapp", "dist"), api });
  await new Promise((resolveListen, reject) => {
    front.once("error", reject);
    front.listen(0, "127.0.0.1", resolveListen);
  });
  frontDoors.add(front);
  const address = front.address();
  return { front, base: `http://127.0.0.1:${address.port}` };
}

async function httpExecutionSnapshot(http) {
  const response = await fetch(`${http.base}/api/providers/execution`);
  return { status: response.status, body: await response.json() };
}

async function waitForRequest(id, count = 1, timeoutMs = 2_000) {
  const end = performance.now() + timeoutMs;
  while (server.requests("ts", id).length < count) {
    if (performance.now() >= end) throw new Error(`local server did not receive request ${count} for ${id}`);
    await delay(10);
  }
}

async function waitForSnapshot(api, predicate, timeoutMs = 2_000) {
  const end = performance.now() + timeoutMs;
  let latest;
  while (performance.now() < end) {
    latest = await apiSnapshot(api);
    if (predicate(latest)) return latest;
    await delay(10);
  }
  throw new Error(`provider execution snapshot did not reach expected state: ${JSON.stringify(latest)}`);
}

function requestLabels(id, labels) {
  return server.requests("ts", id).map((request) => {
    const body = JSON.parse(request.body);
    const messages = Array.isArray(body.messages) ? JSON.stringify(body.messages) : "";
    const matched = labels.find((label) => messages.includes(`user marker ${label}`));
    assert.ok(matched, `request did not contain one of the expected local labels: ${messages}`);
    return matched;
  });
}

function record(name, id, extra = {}) {
  checks.push({ name, requests: server.requests("ts", id).length, ...extra });
}

async function scenarioSharedFifo() {
  currentScenario = "shared_state_fifo";
  const id = "admission-fifo";
  const stateDir = join(tempRoot, "fifo-state");
  mkdirSync(stateDir, { recursive: true });
  const store = new SessionStore(stateDir);
  const api = makeApi(stateDir);
  server.script(id, [
    [{ delay: 220 }, SSE_HEAD + events([chunk({ content: "alpha done" }, "stop"), USAGE_CHUNK])],
    SSE_HEAD + events([chunk({ content: "beta done" }, "stop"), USAGE_CHUNK]),
  ]);
  const first = makeLocal("alpha", stateDir, store, id);
  const second = makeLocal("beta", stateDir, store, id);
  const firstRun = beginRun(first);
  await waitForRequest(id);
  const secondRun = beginRun(second);
  const queued = await waitForSnapshot(api, (value) => value.admission?.active === 1 && value.admission?.queued === 1);
  assert.equal(server.requests("ts", id).length, 1, "the second runner must remain queued while the first owns the only slot");
  assert.deepEqual([queued.admission.limit, queued.admission.active, queued.admission.queued], [1, 1, 1]);
  await Promise.all([firstRun, secondRun]);
  assert.deepEqual(requestLabels(id, ["alpha", "beta"]), ["alpha", "beta"]);
  assert.equal(first.session.status, "completed");
  assert.equal(second.session.status, "completed");
  const drained = await apiSnapshot(api);
  assert.deepEqual([drained.admission.active, drained.admission.queued], [0, 0]);
  record(currentScenario, id, { order: ["alpha", "beta"], queuedSnapshot: [1, 1], drained: true });
}

async function scenarioQueuedCancellation() {
  currentScenario = "queued_cancel_no_http";
  const id = "admission-cancel";
  const stateDir = join(tempRoot, "cancel-state");
  mkdirSync(stateDir, { recursive: true });
  const store = new SessionStore(stateDir);
  const api = makeApi(stateDir);
  server.script(id, [[SSE_HEAD, { hang: true }]]);
  const first = makeLocal("holder", stateDir, store, id);
  const second = makeLocal("cancelled", stateDir, store, id);
  const firstRun = beginRun(first);
  await waitForRequest(id);
  const secondRun = beginRun(second);
  await waitForSnapshot(api, (value) => value.admission?.active === 1 && value.admission?.queued === 1);
  assert.equal(second.runner.cancel(second.session.id), true);
  await secondRun;
  const afterCancel = await waitForSnapshot(api, (value) => value.admission?.active === 1 && value.admission?.queued === 0);
  assert.equal(server.requests("ts", id).length, 1, "a cancelled queued runner must not issue HTTP");
  assert.equal(second.session.status, "stopped");
  assert.deepEqual([afterCancel.admission.active, afterCancel.admission.queued], [1, 0]);
  assert.equal(first.runner.cancel(first.session.id), true);
  await firstRun;
  record(currentScenario, id, { requests: server.requests("ts", id).length, queuedCancel: true, cancelledStatus: second.session.status });
}

async function scenarioRetryReacquires() {
  currentScenario = "retry_releases_then_reacquires";
  const id = "admission-retry";
  const stateDir = join(tempRoot, "retry-state");
  mkdirSync(stateDir, { recursive: true });
  const store = new SessionStore(stateDir);
  const api = makeApi(stateDir);
  server.script(id, [
    [{ delay: 150 }, json(503, { error: { message: "local scripted overload" } })],
    SSE_HEAD + events([chunk({ content: "beta before retry" }, "stop"), USAGE_CHUNK]),
    SSE_HEAD + events([chunk({ content: "alpha retry completed" }, "stop"), USAGE_CHUNK]),
  ]);
  const first = makeLocal("retry-alpha", stateDir, store, id);
  const second = makeLocal("retry-beta", stateDir, store, id);
  const firstRun = beginRun(first, { modelRetry: quickRetry({ baseDelayMs: 350, maxDelayMs: 350 }) });
  await waitForRequest(id);
  const secondRun = beginRun(second);
  await waitForSnapshot(api, (value) => value.admission?.active === 1 && value.admission?.queued === 1);
  await Promise.all([firstRun, secondRun]);
  assert.deepEqual(requestLabels(id, ["retry-alpha", "retry-beta"]), ["retry-alpha", "retry-beta", "retry-alpha"]);
  assert.equal(first.eventsSeen.filter((item) => item.type === "model_retry_scheduled").length, 1);
  assert.equal(first.session.status, "completed");
  assert.equal(second.session.status, "completed");
  const drained = await apiSnapshot(api);
  assert.deepEqual([drained.admission.active, drained.admission.queued], [0, 0]);
  record(currentScenario, id, { order: ["retry-alpha", "retry-beta", "retry-alpha"], retries: 1, capacityReleased: true, reacquired: true });
}

async function scenarioDebugAndApi() {
  currentScenario = "debug_counts_and_execution_api";
  const id = "admission-debug";
  const stateDir = join(tempRoot, "debug-state");
  mkdirSync(stateDir, { recursive: true });
  process.env.XUENESS_MODEL_DEBUG = "1";
  let providerEnabled = true;
  const api = makeApi(stateDir, () => providerEnabled);
  const http = await startApiHttp(api);
  const initial = await httpExecutionSnapshot(http);
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.body, {
    admission: { enabled: true, limit: 1, active: 0, queued: 0, buckets: 0 },
    debug: { enabled: true, records: 0, writeFailures: 0 },
  });
  const reasoningSecret = "HIDDEN_REASONING_SENTINEL";
  const outputSecret = "VISIBLE_OUTPUT_SENTINEL";
  server.script(id, [[
    SSE_HEAD + events([chunk({ reasoning_content: reasoningSecret })], { done: false }),
    { delay: 650 },
    events([chunk({ content: outputSecret }, "stop"), USAGE_CHUNK]),
  ]]);
  const store = new SessionStore(stateDir);
  const local = makeLocal("debug-secret", stateDir, store, id);
  const running = beginRun(local, { modelRetry: quickRetry({ maxAttempts: 1 }) });
  await waitForRequest(id);
  const active = await httpExecutionSnapshot(http);
  assert.equal(active.status, 200);
  const activeSnapshot = active.body;
  assert.deepEqual([activeSnapshot.admission.active, activeSnapshot.admission.queued], [1, 0], JSON.stringify({ active, events: local.eventsSeen.map((item) => item.type) }));
  assert.equal(activeSnapshot.debug.enabled, true);
  assert.equal(activeSnapshot.debug.records, 0);
  assert.equal(Object.hasOwn(local.session.streaming ?? {}, "reasoning"), false, "reasoning stays hidden in the live session");
  assert.equal(local.eventsSeen.some((item) => item.type === "reasoning_delta"), false, "hidden reasoning is not emitted as a UI event");
  await running;
  assert.equal(local.session.status, "completed");
  const directory = join(stateDir, "model-debug");
  const names = readdirSync(directory).filter((name) => name.endsWith(".json"));
  assert.equal(names.length, 1);
  const recordValue = JSON.parse(readFileSync(join(directory, names[0]), "utf8"));
  assert.equal(recordValue.schema, "xueness.model-debug.v1");
  assert.equal(recordValue.request.toolCount, 1);
  assert.equal(recordValue.diagnostics.textChunks, 1);
  assert.equal(recordValue.diagnostics.textChars, outputSecret.length);
  assert.equal(recordValue.diagnostics.reasoningChunks, 1);
  assert.equal(recordValue.diagnostics.reasoningChars, reasoningSecret.length);
  assert.ok(Number.isFinite(recordValue.diagnostics.firstReasoningMs) && recordValue.diagnostics.firstReasoningMs >= 0);
  assert.ok(Number.isFinite(recordValue.diagnostics.firstTextMs) && recordValue.diagnostics.firstTextMs >= 0);
  assert.equal(recordValue.response.contentChars, outputSecret.length);
  assert.equal(recordValue.response.toolCalls, 0);
  const serialized = JSON.stringify(recordValue);
  for (const secret of [reasoningSecret, outputSecret, "system marker debug-secret", "user marker debug-secret", "local_read", "local-test-key"]) {
    assert.equal(serialized.includes(secret), false, `debug metadata leaked ${secret}`);
  }
  assert.equal(Object.keys(recordValue.request).sort().join(","), "assistantChars,inputChars,messageCount,systemChars,toolCallCount,toolCount");
  const completed = await httpExecutionSnapshot(http);
  assert.equal(completed.status, 200);
  assert.deepEqual(completed.body.admission, { enabled: true, limit: 1, active: 0, queued: 0, buckets: 0 });
  assert.deepEqual(completed.body.debug, { enabled: true, records: 1, writeFailures: 0 });
  providerEnabled = false;
  const disabled = await httpExecutionSnapshot(http);
  assert.equal(disabled.status, 403);
  assert.deepEqual(disabled.body, { status: 403, error: "plugin disabled or dependency unavailable: providers", plugin: "providers", code: "plugin_disabled" });
  record(currentScenario, id, { hiddenReasoningChars: reasoningSecret.length, textChars: outputSecret.length, records: completed.body.debug.records, apiDisabledStatus: disabled.status });
}

try {
  await scenarioSharedFifo();
  await scenarioQueuedCancellation();
  await scenarioRetryReacquires();
  await scenarioDebugAndApi();
  const totalRequests = checks.reduce((sum, check) => sum + check.requests, 0);
  process.stdout.write(`${JSON.stringify({ ok: true, mode, network: "loopback-only", scenarios: checks, totalScenarios: checks.length, totalRequests, elapsedMs: Math.round(performance.now() - startedAt), temporaryDataCleaned: true })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, mode, scenario: currentScenario, completed: checks, error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
} finally {
  for (const local of locals) local.runner.cancel(String(local.session.id));
  await Promise.allSettled([...activeRuns]);
  for (const front of frontDoors) {
    front.closeAllConnections();
    await new Promise((resolveClose) => front.close(() => resolveClose()));
  }
  await server.close();
  for (const [key, value] of envBefore) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const tempParent = realpathSync(tmpdir());
  const tempPath = realpathSync(tempRoot);
  if (dirname(tempPath) !== tempParent || !basename(tempPath).startsWith("xueness-verify-model-admission-")) {
    throw new Error("refusing to remove the unexpected verification temp path");
  }
  rmSync(tempPath, { recursive: true, force: true });
}
