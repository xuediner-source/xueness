/** Private journal metadata projected only at the Anthropic request boundary. */
import { createHash } from "node:crypto";
import { isDict } from "@xueness/contracts";
import { normalizeReasoningHistory } from "./reasoning-history-normalization.ts";

type Row = Record<string, unknown>;
export interface ReasoningProvider { model?: string; base?: string }

export function reasoningOrigin(provider: ReasoningProvider): { modelId: string; providerId: string } {
  return { modelId: provider.model ?? "", providerId: createHash("sha256").update(provider.base?.replace(/\/+$/, "") ?? "").digest("hex") };
}

/** Only authenticated/replayable thinking is retained; unsigned text remains display-only. */
export function replayableReasoning(value: unknown): Row[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isDict).flatMap((block): Row[] => {
    if (block.type === "thinking" && typeof block.thinking === "string" && typeof block.signature === "string" && block.signature.length) {
      return [{ type: "thinking", thinking: block.thinking, signature: block.signature }];
    }
    if (block.type === "redacted_thinking" && typeof block.data === "string") return [{ type: "redacted_thinking", data: block.data }];
    return [];
  });
}

export function canonicalReasoning(blocks: unknown): Row[] {
  return replayableReasoning(blocks).map((block) => ({ type: "reasoning", text: block.thinking ?? "",
    providerOptions: { anthropic: block.type === "thinking" ? { signature: block.signature } : { redactedData: block.data } } }));
}

export function nativeReasoning(content: unknown): Row[] {
  if (!Array.isArray(content)) return [];
  return content.filter(isDict).flatMap((block): Row[] => {
    if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
    if (block.type !== "reasoning") return [];
    const options = isDict(block.providerOptions) && isDict(block.providerOptions.anthropic) ? block.providerOptions.anthropic : {};
    if (typeof options.redactedData === "string") return [{ type: "redacted_thinking", data: options.redactedData }];
    if (typeof options.signature === "string" && options.signature) return [{ type: "thinking", thinking: String(block.text ?? ""), signature: options.signature }];
    return [];
  });
}

export function projectAnthropicHistory(messages: readonly Row[], provider: ReasoningProvider, keepUserBoundary?: (message: Row) => boolean): Row[] {
  const projected = messages.map((message) => {
    if (message.role !== "assistant") return message;
    const reasoning = canonicalReasoning(message._reasoning_blocks);
    if (!reasoning.length) return message;
    const text = typeof message.content === "string" && message.content ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content : [];
    const origin = isDict(message._reasoning_origin) ? message._reasoning_origin : {};
    return { ...message, modelId: origin.modelId, providerId: origin.providerId, content: [...reasoning, ...text] };
  });
  return normalizeReasoningHistory(projected, reasoningOrigin(provider), keepUserBoundary);
}

export function withReasoningMetadata(response: Row, provider: ReasoningProvider): Row {
  const blocks = replayableReasoning(response._reasoning_blocks);
  return blocks.length ? { ...response, _reasoning_blocks: blocks, _reasoning_origin: reasoningOrigin(provider) } : response;
}

/** Keep replay data separate from assistant text and visible request status. */
export function retainReasoningMetadata(response: Row, message: Row): void {
  const blocks = replayableReasoning(response._reasoning_blocks);
  if (!blocks.length) return;
  message._reasoning_blocks = blocks;
  if (isDict(response._reasoning_origin)) message._reasoning_origin = { ...response._reasoning_origin };
}
