/** A bounded, tool-free summarizer invocation never mutates the shared client. */
import { isDict, pyJsonLoads, pyLen, PyValueError } from "@xueness/contracts";
import type { AgentProvider, Row } from "@xueness/agent";
import { AnthropicMessages, OpenAICompatible, ProviderCancelled, reportedUsage, type ModelRequestAdmission } from "@xueness/providers";
import { runWithModelAdmission } from "./aux-admission.ts";

export interface HandoffModelOptions { deadline?: number; signal?: AbortSignal; shouldStop?: () => boolean; outputTokens?: number; timeoutSeconds?: number; now?: () => number; admission?: ModelRequestAdmission }
export function cloneHandoffProvider(provider: AgentProvider, cap: number): AgentProvider {
  const bound = (provider as AgentProvider & { boundProvider?: () => AgentProvider }).boundProvider;
  if (typeof bound === "function") { Reflect.get(provider, "complete"); provider = bound(); }
  if (provider instanceof OpenAICompatible) {
    const compatibility = { ...provider.compatibility }; delete compatibility.toolChoice; delete compatibility.parallelToolCalls;
    return new OpenAICompatible({ base: provider.base, model: provider.model, key: provider.key, capabilities: provider.capabilities,
      runtimeProfile: provider.runtimeProfile, contextWindow: provider.contextWindow, maxOutputTokens: cap, toolCalling: "native", compatibility,
      lightweightOptions: provider.lightweightOptions, reasoningEffort: provider.reasoningEffort, allowLoopbackHttp: true, allowEmptyKey: true, clock: provider.clock });
  }
  if (provider instanceof AnthropicMessages) {
    const compatibility = { ...provider.compatibility }; delete compatibility.toolChoice; delete compatibility.parallelToolCalls;
    return new AnthropicMessages({ base: provider.base, model: provider.model, key: provider.key, capabilities: provider.capabilities,
      runtimeProfile: provider.runtimeProfile, contextWindow: provider.contextWindow, maxOutputTokens: cap, maxTokens: cap, toolCalling: "native", compatibility,
      lightweightOptions: provider.lightweightOptions, allowLoopbackHttp: true, clock: provider.clock });
  }
  // Host-owned adapters (subscriptions) are copied like Python's `copy.copy`.
  if ((provider as { hostAdapter?: unknown }).hostAdapter === true) return Object.assign(Object.create(Object.getPrototypeOf(provider) as object) as AgentProvider, provider, { maxOutputTokens: cap });
  // Third-party adapter calls retain their own binding; host bounds and cancellation still apply.
  return { ...provider, complete: provider.complete.bind(provider), ...(provider.stream ? { stream: provider.stream.bind(provider) } : {}) };
}
export async function handoffModelJson(provider: AgentProvider, messages: Row[], config: HandoffModelOptions = {}): Promise<[Row, Row]> {
  const now = config.now ?? (() => performance.now() / 1000);
  const deadline = Math.min(now() + (config.timeoutSeconds ?? 45), config.deadline ?? Infinity);
  const check = (): void => { if (config.signal?.aborted || config.shouldStop?.()) throw new ProviderCancelled(); if (now() >= deadline) throw Object.assign(new Error("model handoff deadline exceeded"), { name: "TimeoutError" }); };
  check();
  let cap = Math.min(config.outputTokens ?? 2048, provider.maxOutputTokens || config.outputTokens || 2048);
  if (provider.contextWindow && Number.isInteger(provider.contextWindow)) cap = Math.min(cap, Math.floor(provider.contextWindow / 2));
  const client = cloneHandoffProvider(provider, Math.max(1, cap)); client.requestDeadline = deadline;
  const chunks: string[] = []; let chars = 0;
  const timeout = AbortSignal.timeout(Math.max(0, Math.ceil((deadline - now()) * 1000)));
  const stop = new AbortController();
  const signal = AbortSignal.any([timeout, stop.signal, ...(config.signal ? [config.signal] : [])]);
  const probe = config.shouldStop ? setInterval(() => { if (config.shouldStop?.()) stop.abort(); }, 50) : null;
  probe?.unref();
  const onDelta = (chunk: unknown): void => { check(); if (typeof chunk !== "string") throw new PyValueError("invalid model handoff stream"); chunks.push(chunk); chars += pyLen(chunk); if (chars > 16000) throw new PyValueError("model handoff output exceeds bound"); };
  let response: Row;
  try { response = await runWithModelAdmission(config.admission, provider, signal, async () => client.stream ? await client.stream(messages, [], { onDelta }, { signal }) : await client.complete(messages, [], { signal })); }
  catch (error) {
    if (timeout.aborted && !config.signal?.aborted && !config.shouldStop?.()) throw Object.assign(new Error("model handoff deadline exceeded", { cause: error }), { name: "TimeoutError" });
    throw error;
  }
  finally { if (probe) clearInterval(probe); }
  check();
  if (!isDict(response) || Array.isArray(response.tool_calls) && response.tool_calls.length || response._finish_reason !== undefined && response._finish_reason !== null && response._finish_reason !== "stop") throw new PyValueError("model handoff did not finish as bounded text");
  let text = typeof response.content === "string" && response.content.trim() ? response.content : chunks.join("");
  if (!text || pyLen(text) > 16000) throw new PyValueError("model handoff has no bounded JSON result");
  text = text.trim(); if (text.startsWith("```json\n") && text.endsWith("\n```")) text = text.slice(8, -4);
  let result: unknown;
  try { result = pyJsonLoads(text, { rejectDuplicates: true }); }
  catch (error) { if (error instanceof Error && error.name === "DuplicateKey") throw new PyValueError("duplicate handoff key"); throw error; }
  if (!isDict(result)) throw new PyValueError("model handoff must be an object");
  return [result, reportedUsage(response._usage)];
}
