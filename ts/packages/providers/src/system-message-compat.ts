type Dict = Record<string, unknown>;

/**
 * Older OpenAI-compatible templates accept only one leading system message.
 * Merge that prefix at serialization time; leave every later message intact.
 */
export function normalizeOpenAiCompatibleSystemMessages(messages: readonly Dict[]): Dict[] {
  let leadingSystemCount = 0;
  while (messages[leadingSystemCount]?.role === "system") leadingSystemCount += 1;

  if (leadingSystemCount <= 1) return [...messages];

  const leadingSystemMessages = messages.slice(0, leadingSystemCount);
  const lastLeadingSystem = leadingSystemMessages.at(-1);
  const lastCacheControl = lastLeadingSystem?.cacheControl;

  return [
    {
      role: "system",
      content: leadingSystemMessages.map((message) => modelMessageContentToText(message.content)).join(""),
      ...(lastCacheControl ? { cacheControl: { ...(lastCacheControl as Dict) } } : {}),
    },
    ...messages.slice(leadingSystemCount),
  ];
}

function modelMessageContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(modelMessageContentBlockToText).filter(Boolean).join("\n\n");
}

function modelMessageContentBlockToText(block: unknown): string {
  if (!isRecord(block)) return "";
  const source = isRecord(block.source) ? block.source : undefined;
  const mediaType = typeof block.mediaType === "string" ? block.mediaType : "";
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? block.text : "";
    case "reasoning":
      return "";
    case "image":
    case "video":
      return attachmentPlaceholder("Attached", mediaType, source?.placeholder);
    case "file":
      if (typeof block.text === "string" && block.text.length > 0) return block.text;
      return attachmentPlaceholder("Attached", mediaType,
        typeof block.name === "string" ? block.name : source?.placeholder);
    case "resource_link":
      return `[Resource: ${String(block.title ?? block.name ?? block.uri)}]`;
    default:
      return "";
  }
}

function attachmentPlaceholder(prefix: string, mediaType: string, name: unknown): string {
  return typeof name === "string" && name.length > 0
    ? `[${prefix} ${mediaType}: ${name}]`
    : `[${prefix} ${mediaType}]`;
}

function isRecord(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
