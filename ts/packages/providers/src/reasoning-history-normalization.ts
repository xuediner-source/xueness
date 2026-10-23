type Row = Record<string, unknown>;

const EMPTY_ASSISTANT_CONTENT_FALLBACK = "(no content)";
const REJECTED_REASONING_FALLBACK = "[Thinking removed]";

interface ModelIdentity {
  modelId: string;
  providerId: string;
}

/** Remove incompatible signed thinking and repair structural history boundaries. */
export function normalizeReasoningHistory(
  messages: Row[],
  targetModel?: ModelIdentity,
  keepUserBoundary?: (message: Row) => boolean,
): Row[] {
  const compatibleHistory = removeCrossModelReasoning(messages, targetModel);
  const withoutOrphans = removeReasoningOnlyAssistants(compatibleHistory);
  const withoutTrailingReasoning = removeTrailingReasoning(withoutOrphans);
  const withoutWhitespaceOnlyAssistants = removeWhitespaceOnlyAssistants(withoutTrailingReasoning, keepUserBoundary);
  return repairEmptyAssistantContent(withoutWhitespaceOnlyAssistants);
}

/**
 * Repair only a provider's explicit safe signature-rejection classification.
 * The remote error message is deliberately not inspected or retained here.
 */
export function repairReasoningHistoryAfterSignatureRejection(
  projectedMessages: Row[],
  error: unknown,
): Row[] | undefined {
  if (!isReasoningSignatureRejected(error)) return undefined;
  const repaired = removeRejectedReasoning(projectedMessages);
  return repaired === projectedMessages ? undefined : repaired;
}

/** Narrow wording check for a transport that has already bounded its response body. */
export function matchesThinkingSignatureRejection(status: number, rawMessage: unknown): boolean {
  if (status !== 400) return false;
  const message = messageText(rawMessage).toLowerCase();
  if (message.includes("signature in thinking block")) return true;

  const namesThinkingBlock =
    message.includes("thinking block") ||
    message.includes("`thinking`") ||
    message.includes("redacted_thinking");
  const namesSignatureFailure =
    message.includes("cannot be modified") || message.includes("invalid signature");
  return namesThinkingBlock && namesSignatureFailure;
}

function isReasoningSignatureRejected(error: unknown): error is Row {
  if (!isRow(error)) return false;
  return (error.status === 400 || error.statusCode === 400) && error.reasoningSignatureRejected === true;
}

function removeCrossModelReasoning(messages: Row[], targetModel: ModelIdentity | undefined): Row[] {
  if (!targetModel) return messages;
  return filterReasoningBlocks(messages, (block, message) => {
    if (typeof message.providerId !== "string" || typeof message.modelId !== "string") return false;
    if (message.providerId === targetModel.providerId && message.modelId === targetModel.modelId) return false;
    return isSignedOrRedactedReasoning(block);
  });
}

function filterReasoningBlocks(
  messages: Row[],
  shouldRemove: (block: Row, message: Row) => boolean,
): Row[] {
  let result: Row[] | undefined;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const content = message.content.filter(
      (block: unknown) => !isRow(block) || block.type !== "reasoning" || !shouldRemove(block, message),
    );
    if (content.length === message.content.length) continue;
    result ??= messages.slice();
    result[index] = { ...message, content };
  }
  return result ?? messages;
}

function removeReasoningOnlyAssistants(messages: Row[]): Row[] {
  const result = messages.filter((message) => {
    if (message.role !== "assistant" || hasToolCalls(message)) return true;
    if (!Array.isArray(message.content) || message.content.length === 0) return true;
    return !message.content.every((block: unknown) => isRow(block) && block.type === "reasoning");
  });
  return result.length === messages.length ? messages : result;
}

function removeTrailingReasoning(messages: Row[]): Row[] {
  const last = messages.at(-1);
  if (last?.role !== "assistant" || !Array.isArray(last.content)) return messages;
  let end = last.content.length;
  while (end > 0 && isRow(last.content[end - 1]) && last.content[end - 1]?.type === "reasoning") end -= 1;
  if (end === last.content.length) return messages;
  const result = messages.slice();
  result[result.length - 1] = { ...last, content: last.content.slice(0, end) };
  return result;
}

function removeWhitespaceOnlyAssistants(
  messages: Row[],
  keepUserBoundary?: (message: Row) => boolean,
): Row[] {
  const filtered = messages.filter((message) => {
    if (message.role !== "assistant" || hasToolCalls(message)) return true;
    if (!Array.isArray(message.content) || message.content.length === 0) return true;
    return !message.content.every((block: unknown) => {
      if (!isRow(block) || block.type !== "text" || typeof block.text !== "string") return false;
      const text = block.text.trim();
      return text.length === 0 || text === EMPTY_ASSISTANT_CONTENT_FALLBACK;
    });
  });
  return filtered.length === messages.length ? messages : mergeAdjacentUserMessages(filtered, keepUserBoundary);
}

function repairEmptyAssistantContent(messages: Row[]): Row[] {
  let result: Row[] | undefined;
  for (let index = 0; index < messages.length - 1; index += 1) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !Array.isArray(message.content) || message.content.length > 0 || hasToolCalls(message)) {
      continue;
    }
    result ??= messages.slice();
    result[index] = { ...message, content: [{ type: "text", text: EMPTY_ASSISTANT_CONTENT_FALLBACK }] };
  }
  return result ?? messages;
}

function mergeAdjacentUserMessages(messages: Row[], keepUserBoundary?: (message: Row) => boolean): Row[] {
  const result: Row[] = [];
  for (const message of messages) {
    const previous = result.at(-1);
    if (!canMergeAdjacentUserMessages(previous, message, keepUserBoundary)) {
      result.push(message);
      continue;
    }
    const merged: Row = { role: "user", content: mergeUserContent(previous.content, message.content) };
    const cacheControl = message.cacheControl ?? previous.cacheControl;
    if (cacheControl) merged.cacheControl = { ...(cacheControl as Row) };
    result[result.length - 1] = merged;
  }
  return result;
}

function canMergeAdjacentUserMessages(
  previous: Row | undefined,
  next: Row,
  keepUserBoundary?: (message: Row) => boolean,
): previous is Row {
  if (previous?.role !== "user" || next.role !== "user") return false;
  if (isToolResultUserMessage(previous) || isToolResultUserMessage(next)) return false;
  return !keepUserBoundary?.(previous) && !keepUserBoundary?.(next);
}

function isToolResultUserMessage(message: Row): boolean {
  return message.role === "user" && Boolean(message.toolCallId || message.toolName);
}

function mergeUserContent(previous: unknown, next: unknown): Row[] {
  const previousBlocks = contentAsBlocks(previous);
  const nextBlocks = contentAsBlocks(next);
  const previousLast = previousBlocks.at(-1);
  const nextFirst = nextBlocks[0];
  if (previousLast?.type === "text" && nextFirst?.type === "text" && typeof previousLast.text === "string") {
    previousBlocks[previousBlocks.length - 1] = { ...previousLast, text: `${previousLast.text}\n` };
  }
  return [...previousBlocks, ...nextBlocks];
}

function contentAsBlocks(content: unknown): Row[] {
  return typeof content === "string"
    ? [{ type: "text", text: content }]
    : Array.isArray(content) ? [...content].filter(isRow) : [];
}

function removeRejectedReasoning(messages: Row[]): Row[] {
  const filtered = filterReasoningBlocks(messages, (block) => isSignedOrRedactedReasoning(block));
  if (filtered === messages) return messages;
  const result = filtered.slice();
  for (let index = 0; index < filtered.length; index += 1) {
    if (filtered[index] === messages[index]) continue;
    const message = filtered[index]!;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    let content = message.content.filter(
      (block: unknown) => !isRow(block) || block.type !== "text" || typeof block.text !== "string" || block.text.trim().length > 0,
    );
    if (!hasToolCalls(message) && content.every((block: unknown) => isRow(block) && block.type === "reasoning")) {
      content = [...content, { type: "text", text: REJECTED_REASONING_FALLBACK }];
    }
    result[index] = { ...message, content };
  }
  return result;
}

function isSignedOrRedactedReasoning(block: Row): boolean {
  const options = isRow(block.providerOptions) ? block.providerOptions : {};
  const anthropic = isRow(options.anthropic) ? options.anthropic : {};
  return (typeof anthropic.signature === "string" && anthropic.signature.length > 0) ||
    typeof anthropic.redactedData === "string";
}

function hasToolCalls(message: Row): boolean {
  return Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
}

function messageText(rawMessage: unknown): string {
  if (rawMessage instanceof Error) return rawMessage.message;
  if (isRow(rawMessage) && "message" in rawMessage) return String(rawMessage.message ?? "");
  return String(rawMessage ?? "");
}

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
