/** Provider-owned bounded naming transport, using only the completed run's adapter. */
import { isDict, pyLen } from "@xueness/contracts";
import type { AgentProvider, Row } from "@xueness/agent";
import { AnthropicMessages, OpenAICompatible } from "@xueness/providers";
import { cloneHandoffProvider } from "./semantic-model.ts";
function bound(provider: AgentProvider): AgentProvider { const fn = (provider as AgentProvider & { boundProvider?: () => AgentProvider }).boundProvider; return typeof fn === "function" ? fn() : provider; }
export function titleProviderSupported(provider: AgentProvider): boolean { const client = bound(provider); return client instanceof OpenAICompatible || client instanceof AnthropicMessages || (client as { hostAdapter?: unknown }).hostAdapter === true; }
export async function requestConversationTitle(provider: AgentProvider, prompt: Row[], signal: AbortSignal): Promise<string | null> {
  provider = bound(provider); if (!titleProviderSupported(provider)) return null;
  let cap = Math.min(256, provider.maxOutputTokens || 256); if (provider.contextWindow && Number.isInteger(provider.contextWindow) && provider.contextWindow > 0) cap = Math.min(cap, Math.floor(provider.contextWindow / 2));
  const client = cloneHandoffProvider(provider, Math.max(1, cap)); client.requestDeadline = performance.now() / 1000 + 20;
  const chunks: string[] = []; let chars = 0;
  const onDelta = (chunk: unknown): void => { if (typeof chunk !== "string") throw new Error("invalid title stream"); chunks.push(chunk); chars += pyLen(chunk); if (chars > 2000) throw new Error("title output exceeds bound"); };
  const options = { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) };
  const response = client.stream ? await client.stream(prompt, [], { onDelta }, options) : await client.complete(prompt, [], options);
  if (!isDict(response) || Array.isArray(response.tool_calls) && response.tool_calls.length || response._finish_reason != null && response._finish_reason !== "stop") return null;
  const text = typeof response.content === "string" && response.content.trim() ? response.content : chunks.join("");
  return text && pyLen(text) <= 2000 ? text : null;
}
