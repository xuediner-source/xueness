import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ScriptedServer } from "../ts/packages/providers/test/support/scripted-server.ts";
import { MESSAGE_START, SSE_HEAD, chunk, event, events, json, messageEnd, textBlock } from "../ts/packages/providers/test/support/http-fixtures.ts";

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
const { OpenAICompatible, AnthropicMessages, ProviderRequestError, reasoningOrigin } = providers;
const { providerActivityExtension, providerRequestShapingExtension } = providerPlugin;

const defaultSchemas = [{ type: "function", function: {
  name: "read", description: "Read a local verification value", parameters: { type: "object", properties: { path: { type: "string" } } },
} }];
const server = await ScriptedServer.start();
const tempRoot = mkdtempSync(join(tmpdir(), "xueness-verify-request-shaping-"));
const runners = new Set();
const activeRuns = new Set();
const checks = [];
let currentScenario = "setup";
const startedAt = performance.now();

function makeOpenAi(id) {
  return new OpenAICompatible({ base: server.base("ts", id), model: "gpt-4o", key: "local-test-key", allowLoopbackHttp: true, env: {} });
}

function makeAnthropic(id, model = "claude-3-5-sonnet-latest") {
  return new AnthropicMessages({ base: server.base("ts", id), model, key: "local-test-key", allowLoopbackHttp: true, env: {} });
}

function createRun(id, provider, { schemas = defaultSchemas, messages, toolCalls = { count: 0, rows: [] }, toolObservations = [], eventsSeen = [] } = {}) {
  const root = join(tempRoot, id);
  mkdirSync(root, { recursive: true });
  const store = new SessionStore(join(root, "state"));
  const session = {
    id: randomBytes(16).toString("hex"), root, task: "Verify provider request shaping", status: "pending", steps: 0,
    messages: structuredClone(messages ?? [
      { role: "system", content: "You are a concise local test assistant." },
      { role: "user", content: "Complete the local test task." },
    ]),
    results: {}, compactions: [], archived_messages: [], completion: null,
  };
  const observer = { id: "files", observeToolDelta(_context, snapshot) { toolObservations.push({ ...snapshot }); } };
  const hooks = {
    enabled: (pluginId) => ["providers", "sessions", "files"].includes(pluginId),
    toolOwner: (name) => name === "read" ? "files" : null,
    tools: async () => schemas,
    extensions: [providerRequestShapingExtension(), providerActivityExtension(), observer],
    propagateCancellation: () => true,
  };
  const toolBridge = {
    async call(call) {
      toolCalls.count += 1;
      toolCalls.rows.push({ id: call.id, name: call.name, input: call.input });
      return { ok: true, content: "local read result" };
    },
    async callAll() { throw new Error("the script does not use batch calls"); },
  };
  const runner = new AgentRunner({ root, store, provider, hooks, toolBridge, onEvent: (item) => eventsSeen.push(item) });
  runners.add({ runner, session });
  return { root, store, session, runner, toolCalls, toolObservations, eventsSeen };
}

function quickRetry(overrides = {}) {
  return { baseDelayMs: 0, jitter: false, maxAttempts: 2, random: () => 0, ...overrides };
}

function beginRun(local, options = {}) {
  const promise = local.runner.run(local.session, { maxWallSeconds: 3, modelRetry: quickRetry(), ...options });
  activeRuns.add(promise);
  promise.then(() => activeRuns.delete(promise), () => activeRuns.delete(promise));
  return promise;
}

async function failureOf(promise, expected) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof expected, `expected ${expected.name}, received ${error?.constructor?.name ?? typeof error}`);
    return error;
  }
  assert.fail(`expected ${expected.name}`);
}

function wireAt(id, index = 0) {
  const request = server.requests("ts", id)[index];
  assert.ok(request, `missing local HTTP request ${index + 1} for ${id}`);
  return JSON.parse(request.body);
}

function capturedCalls(ids) {
  return ids.map((id) => ({ id, requests: server.requests("ts", id).map((request) => ({
    method: request.method, path: request.path, body: JSON.parse(request.body),
  })) }));
}

function record(name, local, ids, extra = {}) {
  checks.push({ name, calls: capturedCalls(ids), status: local.session.status, toolExecutions: local.toolCalls.rows, ...extra });
}

function anthropicReply(text) {
  return SSE_HEAD + MESSAGE_START + textBlock(0, text).join("") + messageEnd("end_turn", 3).join("");
}

function toolResult(session, id) {
  const message = session.messages.find((item) => item.role === "tool" && item.tool_call_id === id);
  assert.ok(message, `tool result ${id} was not journaled`);
  return JSON.parse(message.content);
}

async function scenarioOpenAiSystemAndArguments() {
  currentScenario = "openai_system_prefix_and_argument_safety";
  const id = currentScenario;
  server.script(id, [
    SSE_HEAD + events([chunk({ tool_calls: [
      { index: 0, id: "bom-args", type: "function", function: { name: "  read  ", arguments: "\ufeff{\"path\":\"bom.json\"}" } },
      { index: 1, id: "bad-json", type: "function", function: { name: "read", arguments: "{broken" } },
      { index: 2, id: "duplicate-keys", type: "function", function: { name: "read", arguments: "{\"path\":\"a\",\"path\":\"b\"}" } },
    ] }, "tool_calls")]),
    SSE_HEAD + events([chunk({ content: "continued after invalid tool inputs" }, "stop")]),
  ]);
  const local = createRun(id, makeOpenAi(id), { messages: [
    { role: "system", content: "prefix-one" }, { role: "system", content: "prefix-two" },
    { role: "user", content: "Run the safe read and keep going after invalid calls." },
    { role: "system", content: "middle-system" },
  ] });
  await beginRun(local);
  assert.equal(server.requests("ts", id).length, 2);
  assert.equal(local.session.status, "completed");
  assert.equal(local.session.messages.at(-1)?.content, "continued after invalid tool inputs");
  assert.deepEqual(local.toolCalls.rows, [{ id: "bom-args", name: "read", input: { path: "bom.json" } }]);
  for (const callId of ["bad-json", "duplicate-keys"]) {
    assert.equal((local.session.results[callId]).error_code, "invalid_tool_arguments");
    assert.equal(toolResult(local.session, callId).error_code, "invalid_tool_arguments");
  }
  const sentMessages = wireAt(id).messages;
  const systems = sentMessages.map((message, index) => ({ message, index })).filter(({ message }) => message.role === "system");
  assert.equal(systems[0]?.message.content, "prefix-oneprefix-two", "leading system segments concatenate without a separator");
  assert.equal(systems.length, 2);
  assert.equal(systems[1]?.message.content, "middle-system");
  assert.ok(systems[1].index > sentMessages.findIndex((message) => message.role === "user"), "middle system stays in place");
  record(currentScenario, local, [id], { executedSafeCalls: local.toolCalls.count, rejectedCalls: 2, continued: true });
}

async function strictSchemaRun(id, model, schema) {
  server.script(id, [anthropicReply("schema accepted")]);
  const original = structuredClone(schema);
  const local = createRun(id, makeAnthropic(id, model), { schemas: [{ type: "function", function: {
    name: "read", description: "Read strict-schema input", strict: true, parameters: schema,
  } }] });
  await beginRun(local);
  assert.equal(local.session.status, "completed");
  assert.deepEqual(schema, original, "wire shaping must not mutate the source schema");
  return { local, original, wireTool: wireAt(id).tools[0] };
}

async function scenarioAnthropicStrictTools() {
  currentScenario = "anthropic_strict_tool_eligibility";
  const representable = { type: "object", properties: { nested: { type: "object", properties: {
    count: { type: "integer", minimum: 2 },
  }, required: ["count"] } }, required: ["nested"] };
  const firstPartyId = "anthropic_strict_first_party";
  const firstParty = await strictSchemaRun(firstPartyId, "claude-3-5-sonnet-latest", representable);
  assert.equal(firstParty.wireTool.strict, true);
  assert.equal(firstParty.wireTool.input_schema.additionalProperties, false);
  assert.equal(firstParty.wireTool.input_schema.properties.nested.additionalProperties, false);
  assert.equal(firstParty.wireTool.input_schema.properties.nested.properties.count.description, "minimum 2");
  assert.equal("minimum" in firstParty.wireTool.input_schema.properties.nested.properties.count, false);

  const gatewayId = "anthropic_strict_gateway_fallback";
  const gateway = await strictSchemaRun(gatewayId, "anthropic/claude-3-5-sonnet-latest", representable);
  assert.equal(Object.hasOwn(gateway.wireTool, "strict"), false);
  assert.deepEqual(gateway.wireTool.input_schema, gateway.original);

  const unsupported = { type: "object", properties: { nested: { $ref: "#/$defs/nested" } }, $defs: { nested: { type: "string" } } };
  const unsupportedId = "anthropic_strict_unsupported_schema";
  const fallback = await strictSchemaRun(unsupportedId, "claude-3-5-sonnet-latest", unsupported);
  assert.equal(Object.hasOwn(fallback.wireTool, "strict"), false);
  assert.deepEqual(fallback.wireTool.input_schema, fallback.original);
  record(currentScenario, firstParty.local, [firstPartyId, gatewayId, unsupportedId], {
    strictEnabled: true, gatewayFallback: true, unsupportedFallback: true,
  });
}

async function scenarioSignedThinkingAndToolReplay() {
  currentScenario = "anthropic_signed_thinking_tool_replay";
  const id = currentScenario;
  server.script(id, [
    SSE_HEAD + MESSAGE_START
      + event("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "signed thought ", signature: "start-signature" } })
      + event("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "continues" } })
      + event("content_block_stop", { index: 0 })
      + event("content_block_start", { index: 1, content_block: { type: "tool_use", id: "signed-read", name: "read", input: {} } })
      + event("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":\"signed.txt\"}" } })
      + event("content_block_stop", { index: 1 })
      + event("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 8 } })
      + event("message_stop", {}),
    anthropicReply("answer after signed tool call"),
  ]);
  const local = createRun(id, makeAnthropic(id));
  await beginRun(local);
  assert.equal(server.requests("ts", id).length, 2);
  assert.equal(local.toolCalls.count, 1);
  const assistant = local.session.messages.find((message) => message.role === "assistant" && Array.isArray(message.tool_calls));
  assert.ok(assistant);
  assert.deepEqual(assistant._reasoning_blocks, [{ type: "thinking", thinking: "signed thought continues", signature: "start-signature" }]);
  assert.equal(typeof assistant._reasoning_origin?.modelId, "string");
  const persisted = await local.store.load(local.session.id);
  const persistedAssistant = persisted.messages.find((message) => message.role === "assistant" && Array.isArray(message.tool_calls));
  assert.deepEqual(persistedAssistant._reasoning_blocks, assistant._reasoning_blocks);
  assert.deepEqual(persistedAssistant._reasoning_origin, assistant._reasoning_origin);
  const replay = wireAt(id, 1).messages.flatMap((message) => Array.isArray(message.content) ? message.content : []);
  assert.ok(replay.some((block) => block.type === "thinking" && block.signature === "start-signature"));
  assert.ok(replay.some((block) => block.type === "tool_use" && block.id === "signed-read"));
  record(currentScenario, local, [id], { executedClosedTool: local.toolCalls.count, signedThinkingReplayed: true, privateJournalPersisted: true });
}

function seededReasoning(provider) {
  return {
    role: "assistant", content: "previous assistant answer",
    _reasoning_blocks: [
      { type: "thinking", thinking: "synthetic signed reasoning", signature: "sig-to-repair" },
      { type: "redacted_thinking", data: "synthetic opaque reasoning" },
    ],
    _reasoning_origin: reasoningOrigin(provider),
  };
}

function reasoningBlocks(body) {
  return body.messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .filter((block) => block.type === "thinking" || block.type === "redacted_thinking");
}

const signatureRejection = "invalid signature in thinking block";

async function scenarioUncommittedSignatureRepair() {
  currentScenario = "anthropic_uncommitted_signature_repair";
  const id = currentScenario;
  server.script(id, [
    json(400, { error: { type: "invalid_request_error", message: signatureRejection } }),
    anthropicReply("signature history repaired"),
  ]);
  const provider = makeAnthropic(id);
  const sourceReasoning = seededReasoning(provider);
  const originalBlocks = structuredClone(sourceReasoning._reasoning_blocks);
  const originalOrigin = structuredClone(sourceReasoning._reasoning_origin);
  const local = createRun(id, provider, { messages: [
    { role: "system", content: "Keep this local recovery test brief." }, sourceReasoning,
    { role: "user", content: "Answer after recovering from the old signed context." },
  ] });
  await beginRun(local);
  assert.equal(server.requests("ts", id).length, 2, "an uncommitted signature rejection receives one repair attempt");
  const first = reasoningBlocks(wireAt(id, 0));
  const secondBody = wireAt(id, 1);
  const second = reasoningBlocks(secondBody);
  assert.equal(first.some((block) => block.type === "thinking"), true);
  assert.equal(first.some((block) => block.type === "redacted_thinking"), true);
  assert.equal(second.length, 0, "signed and redacted reasoning is removed from the retry request");
  assert.ok(JSON.stringify(secondBody.messages).includes("previous assistant answer"), "the retry retains the assistant's existing text");
  assert.deepEqual(local.session.messages[1]._reasoning_blocks, originalBlocks, "the durable source journal remains unchanged");
  assert.deepEqual(local.session.messages[1]._reasoning_origin, originalOrigin);
  const persisted = await local.store.load(local.session.id);
  assert.deepEqual(persisted.messages[1]._reasoning_blocks, originalBlocks);
  const requests = local.eventsSeen.filter((item) => item.type === "model_request_started");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].requestId, requests[1].requestId);
  assert.notEqual(requests[0].attemptId, requests[1].attemptId);
  record(currentScenario, local, [id], { signatureRecoveryCalls: 2, originalJournalUnchanged: true, sameRequestDifferentAttempts: true });
}

async function scenarioCommittedOutputBlocksRepair() {
  currentScenario = "anthropic_committed_output_blocks_signature_retry";
  const id = currentScenario;
  const provider = makeAnthropic(id);
  const rawMessage = "invalid signature in thinking block; scripted upstream detail";
  server.script(id, [SSE_HEAD + MESSAGE_START
    + event("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
    + event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "visible partial answer" } })
    + event("error", { error: { status: 400, type: "invalid_request_error", message: rawMessage } })]);
  const sourceReasoning = seededReasoning(provider);
  const local = createRun(id, provider, { messages: [
    { role: "system", content: "Keep this local output-boundary test brief." }, sourceReasoning,
    { role: "user", content: "Try the request once." },
  ] });
  const error = await failureOf(beginRun(local), ProviderRequestError);
  assert.equal(server.requests("ts", id).length, 1, "committed output blocks signature repair and retry");
  assert.equal(local.session.status, "provider_error");
  assert.equal(local.session.streaming?.text, "visible partial answer");
  assert.equal(local.session.streaming?.status, "interrupted");
  const persisted = await local.store.load(local.session.id);
  for (const value of [JSON.stringify(local.session), JSON.stringify(persisted), JSON.stringify(error.toJSON()), JSON.stringify(local.eventsSeen)]) {
    assert.equal(value.includes(rawMessage), false, "raw provider error text must not enter persisted or public error data");
    assert.equal(value.includes("scripted upstream detail"), false);
  }
  assert.equal(error.message.includes(rawMessage), false);
  record(currentScenario, local, [id], { requests: server.requests("ts", id).length, retainedPartial: local.session.streaming.text, rawErrorSuppressed: true });
}

async function scenarioUnclosedAndInternalToolResult() {
  currentScenario = "anthropic_unclosed_and_internal_tool_result_suppressed";
  const id = currentScenario;
  const internalText = "internal tool result must remain hidden";
  server.script(id, [
    SSE_HEAD + MESSAGE_START
      + event("content_block_start", { index: 0, content_block: { type: "tool_use", id: "unclosed-tool", name: "read", input: {} } })
      + event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\":\"private.txt\"}" } })
      + event("content_block_start", { index: 1, content_block: { type: "tool_result", tool_use_id: "internal-call", content: [] } })
      + event("content_block_delta", { index: 1, delta: { type: "text_delta", text: internalText } })
      + event("content_block_stop", { index: 1 })
      + event("message_delta", { delta: { stop_reason: "tool_use" } })
      + event("message_stop", {}),
  ]);
  const local = createRun(id, makeAnthropic(id));
  await beginRun(local);
  assert.equal(server.requests("ts", id).length, 1);
  assert.equal(local.toolCalls.count, 0);
  assert.deepEqual(local.toolObservations, [], "staged snapshots from an unclosed tool block are discarded");
  assert.equal(local.session.messages.some((message) => message.role === "assistant" && Array.isArray(message.tool_calls)), false);
  assert.equal(JSON.stringify(local.session).includes(internalText), false);
  assert.equal(JSON.stringify(local.eventsSeen).includes(internalText), false);

  const openAiId = "openai_done_without_finish_does_not_close_tool";
  server.script(openAiId, [SSE_HEAD + events([{
    id: "missing-finish",
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "must-not-run", type: "function", function: {
      name: "read", arguments: "{\"path\":\"must-not-run.txt\"}",
    } }] } }],
  }])]);
  const openAi = createRun(openAiId, makeOpenAi(openAiId));
  await beginRun(openAi);
  assert.equal(server.requests("ts", openAiId).length, 1);
  assert.equal(openAi.toolCalls.count, 0, "complete fragments followed only by [DONE] stay unclosed without finish_reason");
  assert.equal(Object.hasOwn(openAi.session.results, "must-not-run"), false);
  assert.deepEqual(openAi.toolObservations, [], "unclosed tool snapshots remain staged and are discarded");
  record(currentScenario, local, [id, openAiId], {
    executedTools: 0, leakedToolSnapshots: local.toolObservations.length + openAi.toolObservations.length,
    internalTextSuppressed: true, openAiMissingFinishCalls: server.requests("ts", openAiId).length,
    openAiUnfinishedToolExecuted: openAi.toolCalls.count,
  });
}

try {
  await scenarioOpenAiSystemAndArguments();
  await scenarioAnthropicStrictTools();
  await scenarioSignedThinkingAndToolReplay();
  await scenarioUncommittedSignatureRepair();
  await scenarioCommittedOutputBlocksRepair();
  await scenarioUnclosedAndInternalToolResult();
  process.stdout.write(`${JSON.stringify({
    ok: true, mode, network: "loopback-only", scenarios: checks,
    totalCalls: checks.reduce((sum, check) => sum + check.calls.reduce((callSum, entry) => callSum + entry.requests.length, 0), 0),
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
  if (dirname(tempPath) !== tempParent || !basename(tempPath).startsWith("xueness-verify-request-shaping-")) {
    throw new Error("refusing to remove the unexpected verification temp path");
  }
  rmSync(tempPath, { recursive: true, force: true });
}
