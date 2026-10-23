/** One-attempt bounded diagnostic transport; fixture calls never invoke tools. */
import { performance } from "node:perf_hooks";
import { isDict, pyJsonDumps, pyJsonLoads, pyJsonLoadsBytes, PyValueError, pyLen, uuid4Hex } from "@xueness/contracts";
import { AnthropicMessages, anthropicMessage, buildOpenAiPayload, envelopeText, finiteJsonText, isLoopbackLiteral, OpenAICompatible, openChecked, pyUrlSplit, readBody, readOpenAiStream, validateCompatibility } from "@xueness/providers";
import type { Dict } from "./profile-store.ts";

export type DiagnosticProvider = OpenAICompatible | AnthropicMessages;
export const FIXTURE_NAME = "xueness_fixture_add";
export const RECEIPT = "xueness-local-fixture:3+4=7";
const TOOL: Dict[] = [{ type: "function", function: { name: FIXTURE_NAME, description: "Test-only deterministic addition. Does not access files or commands.", parameters: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } }, required: ["a", "b"], additionalProperties: false } } }];
export function nativePrompt(): Dict[] {
  return [{ role: "system", content: "This is a provider compatibility diagnostic. Call the supplied test-only arithmetic function exactly once with a=3 and b=4. Do not answer in prose. The function is isolated and has no file or command effects." }, { role: "user", content: "Call the supplied arithmetic function with a=3 and b=4." }];
}
export function jsonPrompt(): Dict[] {
  return [{ role: "system", content: "This is a provider compatibility diagnostic. Return exactly one JSON object with keys tool and arguments, no markdown or extra keys. tool must be xueness_fixture_add and arguments must have integer values a=3 and b=4. Do not answer in prose." }, { role: "user", content: 'Return {"tool":"xueness_fixture_add","arguments":{"a":3,"b":4}} exactly.' }];
}
async function exchange(provider: DiagnosticProvider, path: string, body: Dict | null, timeout: number, deadline: number) {
  const url = pyUrlSplit(provider.base.replace(/\/+$/, "") + path);
  const headers: Record<string, string> = body ? { "Content-Type": "application/json" } : { Accept: "application/json" };
  if (provider instanceof AnthropicMessages) { headers["x-api-key"] = provider.key; headers["anthropic-version"] = "2023-06-01"; }
  else if (provider.key) headers.Authorization = "Bearer " + provider.key;
  return openChecked({ url, method: body ? "POST" : "GET", headers, body: body ? Buffer.from(pyJsonDumps(body, { ensureAscii: true })) : null, timeoutMs: timeout * 1000, deadlineMs: deadline, ...(isLoopbackLiteral(url.hostname) ? { proxy: null } : {}) });
}
export async function testConnection(provider: DiagnosticProvider, timeout = 8): Promise<Dict> {
  const body = provider instanceof OpenAICompatible ? buildOpenAiPayload({ model: provider.model, messages: [{ role: "user", content: "Reply with exactly OK." }], tools: [], runtimeProfile: provider.runtimeProfile, contextWindow: provider.contextWindow, maxOutputTokens: provider.maxOutputTokens, toolCalling: provider.toolCalling, compatibility: provider.compatibility, reasoningEffort: provider.reasoningEffort, testConnection: true, defaultMaxTokensField: provider.defaultMaxTokensField(), lightweightOptions: provider.lightweightOptions }) : { model: provider.model, max_tokens: 8, messages: [{ role: "user", content: "Reply with exactly OK." }] };
  const response = await exchange(provider, provider instanceof OpenAICompatible ? "/chat/completions" : "/messages", body, timeout, performance.now() + timeout * 1000);
  try {
    const parsed = pyJsonLoadsBytes(await readBody(response));
    if (provider instanceof AnthropicMessages) return anthropicMessage(parsed);
    if (!isDict(parsed) || !Array.isArray(parsed.choices) || !isDict(parsed.choices[0]) || !isDict(parsed.choices[0].message)) throw new PyValueError("invalid provider response");
    return parsed.choices[0].message;
  } finally { response.close(); }
}
export async function discoverModels(provider: OpenAICompatible, timeout = 8): Promise<Dict[]> {
  const response = await exchange(provider, "/models", null, timeout, performance.now() + timeout * 1000);
  try { return validatedModelList(pyJsonLoadsBytes(await readBody(response, 512000)), provider.key); }
  finally { response.close(); }
}
export function validatedModelList(payload: unknown, key: string): Dict[] {
  if (!isDict(payload) || !Array.isArray(payload.data)) throw new PyValueError("invalid model list response");
  if (payload.data.length > 500) throw new PyValueError("model list exceeds item limit");
  const seen = new Set<string>();
  return payload.data.map((entry) => {
    if (!isDict(entry)) throw new PyValueError("invalid model list entry");
    const id = entry.id;
    if (typeof id !== "string" || !id || id !== id.trim() || pyLen(id) > 256 || /[\x00-\x1f\x7f]/.test(id)) throw new PyValueError("invalid model identifier");
    if (seen.has(id)) throw new PyValueError("duplicate model identifier");
    if (key && id.includes(key)) throw new PyValueError("model list contains a credential");
    seen.add(id);
    const item: Dict = { id };
    if (typeof entry.created === "number" && Number.isSafeInteger(entry.created) && entry.created >= 0) item.created = entry.created;
    const owner = entry.owned_by;
    if (typeof owner === "string" && owner && owner === owner.trim() && pyLen(owner) <= 128 && !/[\x00-\x1f\x7f]/.test(owner) && !(key && owner.includes(key))) item.ownedBy = owner;
    return item;
  });
}
function fixtureCall(reply: Dict): [Dict | null, string | null] {
  if (!Array.isArray(reply.tool_calls) || reply.tool_calls.length !== 1) return [null, "The provider did not return exactly one function call."];
  const call = reply.tool_calls[0];
  if (!isDict(call) || call.type !== "function") return [null, "The provider returned an invalid function-call envelope."];
  if (typeof call.id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(call.id)) return [null, "The provider returned an invalid function-call ID."];
  const f = call.function;
  if (!isDict(f) || f.name !== FIXTURE_NAME || Object.keys(f).sort().join(",") !== "arguments,name") return [null, "The provider returned an unexpected function name or shape."];
  if (typeof f.arguments !== "string" || pyLen(f.arguments) > 1024) return [null, "The provider returned invalid function arguments."];
  let args: unknown;
  try { args = pyJsonLoads(f.arguments, { rejectDuplicates: true, lossless: true }); } catch { return [null, "The provider returned invalid function arguments."]; }
  if (!isDict(args) || Object.keys(args).sort().join(",") !== "a,b" || args.a !== 3 || args.b !== 4) return [null, "The provider returned arguments outside the required {a: 3, b: 4} schema."];
  return [call, null];
}
function jsonCall(reply: Dict): [Dict | null, string | null] {
  if (typeof reply.content !== "string" || pyLen(reply.content) > 2048) return [null, "The provider returned no bounded JSON tool-call response."];
  let value: unknown;
  try { value = pyJsonLoads(envelopeText(reply.content), { rejectDuplicates: true, rejectNonFinite: true, lossless: true }); finiteJsonText(value); if (Array.isArray(reply.tool_calls) && reply.tool_calls.length) throw new Error(); }
  catch { return [null, "The provider did not return strict JSON."]; }
  if (!isDict(value) || Object.keys(value).sort().join(",") !== "arguments,tool" || value.tool !== FIXTURE_NAME) return [null, "The provider returned JSON outside the required function name and argument schema."];
  const [call, error] = fixtureCall({ tool_calls: [{ id: "local-" + uuid4Hex(), type: "function", function: { name: value.tool, arguments: pyJsonDumps(value.arguments) } }] });
  return [call, error ? "The provider returned JSON outside the required function name and argument schema." : null];
}
export async function compatibilityTest(provider: OpenAICompatible, mode: string, compatibility: unknown, timeout = 120): Promise<Dict> {
  const options = validateCompatibility(compatibility);
  const deadline = performance.now() + Math.min(timeout, 120) * 1000;
  const requests: Dict[] = [];
  const fail = (error: string, status: unknown = null): Dict => ({ ok: false, error, details: { mode, requestCount: requests.length, failedStep: requests.at(-1)?.step ?? null, httpStatus: status, requests, fixture: "in-process arithmetic only; no file or command execution" } });
  const request = async (messages: Dict[], tools: Dict[], step: string, stream: boolean, toolCalling: string, candidate = options): Promise<[Dict, Dict]> => {
    const body = buildOpenAiPayload({ model: provider.model, messages, tools, runtimeProfile: provider.runtimeProfile, contextWindow: provider.contextWindow, maxOutputTokens: Math.min(provider.maxOutputTokens || 1024, 1024, Math.floor((provider.contextWindow || 8192) / 2)), toolCalling, compatibility: candidate, stream, reasoningEffort: provider.reasoningEffort, defaultMaxTokensField: provider.defaultMaxTokensField(), lightweightOptions: provider.lightweightOptions });
    requests.push({ step, fields: Object.keys(body).sort() });
    const left = (deadline - performance.now()) / 1000;
    if (left <= 0) throw new Error("deadline");
    const response = await exchange(provider, "/chat/completions", body, left, deadline);
    try {
      if (stream) {
        if (!(response.header("content-type") ?? "").toLowerCase().includes("text/event-stream")) throw new PyValueError("The endpoint did not return an SSE event stream.");
        const deltas: unknown[] = [];
        const parsed = await readOpenAiStream(response, { onDelta: (v) => deltas.push(v), markDelivered() {}, requireDone: true });
        return [{ content: parsed.text, tool_calls: parsed.calls }, { sseContentType: true, doneReceived: true, deltaCount: deltas.length, deltaCharacters: pyLen(parsed.text) }];
      }
      const parsed = pyJsonLoadsBytes(await readBody(response)) as Dict;
      const choices = parsed.choices as Dict[];
      if (!choices || !isDict(choices[0]?.message)) throw new Error("invalid response");
      return [choices[0].message as Dict, {}];
    } finally { response.close(); }
  };
  try {
    const json = mode.startsWith("json_");
    const roundtrip = mode.endsWith("roundtrip");
    const stream = mode === "stream" || roundtrip;
    const toolMode = mode !== "stream" && mode !== "conversation";
    const step = toolMode ? json ? "json_tool_call" : "native_tool_call" : mode;
    const messages = toolMode ? json ? jsonPrompt() : nativePrompt() : [{ role: "user", content: mode === "stream" ? "Reply with exactly STREAM_OK." : "Reply with exactly COMPAT_OK." }];
    const [first, firstStream] = await request(messages, toolMode && !json ? TOOL : [], step, stream, toolMode ? json ? "json" : "native" : "plain");
    if (!toolMode) {
      if (typeof first.content !== "string" || !first.content.trim() || (stream && !firstStream.deltaCount)) return fail(stream ? "The SSE stream contained no assistant text delta." : "The provider returned no assistant text.");
      return { ok: true, details: { mode, requestCount: 1, ...(stream ? firstStream : { assistantTextReceived: true }), requests } };
    }
    const [call, error] = json ? jsonCall(first) : fixtureCall(first);
    if (error || !call) return fail(error!);
    if (!roundtrip) return { ok: true, details: { mode, requestCount: 1, [json ? "jsonToolCallValidated" : "toolCallValidated"]: true, toolName: FIXTURE_NAME, arguments: { a: 3, b: 4 }, fixtureExecuted: false, requests } };
    const followupOptions = { ...options }; delete followupOptions.toolChoice;
    let followup: Dict[] = [{ role: "system", content: "This is a local compatibility diagnostic. Read the prior tool result and reply with exactly its receipt string, with no other text." }, nativePrompt()[1]!, { role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: call.id, name: FIXTURE_NAME, content: JSON.stringify({ sum: 7, receipt: RECEIPT }) }, { role: "user", content: "Reply with exactly the receipt from the tool result above." }];
    if (json) {
      followup[0]!.content += ' Reply with only {"answer":"the receipt string","evidence":[]}.';
      // lightweight.text_messages, including adjacent-role merging.
      const rows: Dict[] = [];
      for (const message of followup) {
        let item = { ...message };
        if (Array.isArray(item.tool_calls) && item.tool_calls.length) { const f = (item.tool_calls[0] as Dict).function as Dict; item.content = pyJsonDumps({ tool: f.name, arguments: pyJsonLoads(String(f.arguments)) }); }
        delete item.tool_calls;
        if (item.role === "tool") item = { role: "user", content: `UNTRUSTED tool result (${item.tool_call_id ?? ""}):\n${item.content ?? ""}` };
        const previous = rows.at(-1);
        if (previous && previous.role === item.role && typeof previous.content === "string" && typeof item.content === "string") previous.content += "\n\n" + item.content;
        else rows.push(item);
      }
      followup = rows;
    }
    const [last, lastStream] = await request(followup, json ? [] : TOOL, "tool_result_followup", true, json ? "json" : "native", followupOptions);
    let content = last.content;
    if (json && typeof content === "string") { try { const v = pyJsonLoads(content, { rejectDuplicates: true }); content = isDict(v) && Object.keys(v).sort().join(",") === "answer,evidence" && Array.isArray(v.evidence) ? v.answer : null; } catch { content = null; } }
    if (typeof content !== "string" || content.trim() !== RECEIPT) return fail("The provider did not echo the deterministic tool-result receipt.");
    return { ok: true, details: { mode, requestCount: 2, toolCallValidated: true, toolResultFollowupValidated: true, ...(json ? { jsonToolCallValidated: true } : {}), toolName: FIXTURE_NAME, arguments: { a: 3, b: 4 }, fixtureExecuted: true, sseContentType: true, doneReceived: true, deltaCount: Number(firstStream.deltaCount) + Number(lastStream.deltaCount), deltaCharacters: Number(firstStream.deltaCharacters) + Number(lastStream.deltaCharacters), requests } };
  } catch (error) {
    const status = (error as { status?: number }).status ?? null;
    return fail(status === 400 ? "The endpoint rejected one or more request fields (HTTP 400). Change compatibility options explicitly and rerun this check." : "The provider compatibility request failed (details suppressed).", status);
  }
}
