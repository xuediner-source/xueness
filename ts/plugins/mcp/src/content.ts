/**
 * Rich MCP content projection (F06.03): images, audio, embedded resources,
 * resource links and attachment references.
 *
 * `names.ts` keeps Python's exact `_extract_text` for parity; this module is
 * the model/UI projection used on the live call path. Attachable images leave
 * as `ToolMedia` with the `[Attached <mime>: <placeholder>]` line the agent's
 * tool-media binder looks for, so MIME and bytes survive into model requests
 * and the journal sidecar. Everything the model cannot consume (audio,
 * non-image blobs, oversized media) stays a labeled reference with MIME, size
 * and source URI, so a large resource can still be loaded by reference through
 * the `_xueness_resources_read` special. MCP output is untrusted server
 * content; attachment metadata says so.
 */
import { isDict, pyJsonDumps } from "@xueness/contracts";
import { b64decodeStrict, validMediaSignature } from "@xueness/providers";
import { CATALOG_CHARS, clipBytes, clipChars, MCP_MODEL_BYTES, type Row } from "./names.ts";

/** Mirrors the agent's per-request tool-media budget (`TOOL_MEDIA_MAX_*`). */
export const MCP_MEDIA_MAX_ITEMS = 20;
export const MCP_MEDIA_MAX_BYTES = 20 * 1024 * 1024;

export interface McpMedia { mimeType: string; data: string; placeholder: string }
/** Journal metadata for one attachment; `data` bytes never appear here. */
export interface McpAttachmentMeta { mimeType: string; size: number; placeholder: string; source: string; untrusted: true }
export interface RichProjection { parts: string[]; media: McpMedia[]; attachments: McpAttachmentMeta[] }
export interface CallProjection { ok: boolean; text: string; media: McpMedia[]; attachments: McpAttachmentMeta[] }

export const attachmentLine = (media: { mimeType: string; placeholder: string }): string => `[Attached ${media.mimeType}: ${media.placeholder}]`;

/** One shared attachment budget per tool result; over-budget items degrade to references. */
class Budget {
  readonly #media: McpMedia[] = [];
  readonly #attachments: McpAttachmentMeta[] = [];
  #items = 0;
  #bytes = 0;
  get media(): readonly McpMedia[] { return this.#media; }
  get attachments(): readonly McpAttachmentMeta[] { return this.#attachments; }
  /** Returns the attachment line, or `null` when the item is invalid or over budget. */
  attach(source: string, kind: string, index: number, mimeType: unknown, data: unknown): string | null {
    if (typeof mimeType !== "string" || typeof data !== "string") return null;
    let raw: Buffer;
    try { raw = b64decodeStrict(data); } catch { return null; }
    if (!raw.length || !validMediaSignature(raw, mimeType)) return null;
    if (this.#items >= MCP_MEDIA_MAX_ITEMS || this.#bytes + raw.length > MCP_MEDIA_MAX_BYTES) return null;
    this.#items += 1;
    this.#bytes += raw.length;
    const media: McpMedia = { mimeType, data: raw.toString("base64"), placeholder: `mcp-${source}-${kind}-${index}` };
    this.#media.push(media);
    this.#attachments.push({ mimeType, size: raw.length, placeholder: media.placeholder, source, untrusted: true });
    return attachmentLine(media);
  }
}

/** Decoded byte count as a string, or `null` when the base64 payload does not decode. */
function decodedBytes(data: unknown): string | null {
  if (typeof data !== "string") return null;
  try { const raw = b64decodeStrict(data); return raw.length ? String(raw.length) : null; } catch { return null; }
}

function typedLine(label: string, mimeType: unknown, data: unknown): string {
  const size = decodedBytes(data);
  return size === null ? `[${label}: ${String(mimeType)}]` : `[${label}: ${String(mimeType)}, ${size} bytes]`;
}

/** A blob/link reference keeps the URI so the model can re-read it by reference. */
function referenceLine(label: string, uri: unknown, mimeType: unknown, data: unknown): string {
  const size = decodedBytes(data);
  const mime = typeof mimeType === "string" ? ` (${mimeType}${size === null ? "" : `, ${size} bytes`})` : "";
  const target = typeof uri === "string" && uri ? uri : "unknown uri";
  return `[${label}: ${target}${mime}]`;
}

/** Project blocks into shared parts/budget; the image/resource counters are per result. */
function projectInto(budget: Budget, parts: string[], source: string, counters: { image: number; resource: number }, blocks: readonly unknown[]): void {
  for (const block of blocks) {
    if (!isDict(block)) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "image") {
      counters.image += 1;
      parts.push(budget.attach(source, "image", counters.image, block.mimeType, block.data) ?? typedLine("Image", block.mimeType, block.data));
    } else if (block.type === "audio") parts.push(typedLine("Audio", block.mimeType, block.data));
    else if (block.type === "resource_link") {
      const uri = typeof block.uri === "string" ? block.uri : "";
      const name = typeof block.name === "string" && block.name && block.name !== uri ? ` (${block.name})` : "";
      parts.push(`[Resource link: ${uri || "unknown uri"}${name}]`);
    } else if (block.type === "resource" && isDict(block.resource)) {
      const resource = block.resource;
      if (typeof resource.text === "string") parts.push(resource.text);
      else if (typeof resource.blob === "string") {
        counters.resource += 1;
        parts.push(budget.attach(source, "resource", counters.resource, resource.mimeType, resource.blob) ?? referenceLine("Resource", resource.uri, resource.mimeType, resource.blob));
      } else parts.push("MCP resource: " + pyJsonDumps(resource, { ensureAscii: false }));
    }
  }
}

/** One content block list (tools/call, prompts/get messages) as model text plus attachments. */
export function projectBlocks(source: string, blocks: readonly unknown[]): RichProjection {
  const budget = new Budget();
  const parts: string[] = [];
  projectInto(budget, parts, source, { image: 0, resource: 0 }, blocks);
  return { parts, media: [...budget.media], attachments: [...budget.attachments] };
}

/** A `tools/call` result projected for the model; mirrors `callResultText` plus rich blocks. */
export function projectCallContent(source: string, result: Row, maxBytes = MCP_MODEL_BYTES): CallProjection {
  const content = result.content;
  const projection = typeof content === "string"
    ? { parts: [content], media: [] as McpMedia[], attachments: [] as McpAttachmentMeta[] }
    : Array.isArray(content) ? projectBlocks(source, content)
      : { parts: [], media: [] as McpMedia[], attachments: [] as McpAttachmentMeta[] };
  let text = projection.parts.join("\n");
  const structured = result.structuredContent;
  if ((Array.isArray(structured) && structured.length) || (isDict(structured) && Object.keys(structured).length)) {
    const block = "Structured content:\n" + pyJsonDumps(structured, { ensureAscii: false, indent: 2 });
    text = text ? text + "\n\n" + block : block;
  }
  return { ok: result.isError !== true, text: clipBytes(text, maxBytes), media: projection.media, attachments: projection.attachments };
}

const RICH_BLOCK = new Set(["image", "audio", "resource_link"]);
const richBlock = (item: unknown): boolean => isDict(item) && (RICH_BLOCK.has(String(item.type))
  || item.type === "resource" && isDict(item.resource) && typeof item.resource.blob === "string");

/** True when a read result carries more than plain text (blob bytes or rich block types). */
export function hasRichContent(value: unknown): boolean {
  if (!isDict(value)) return false;
  if (Array.isArray(value.contents)) return value.contents.some((item) => isDict(item) && (typeof item.blob === "string" || richBlock(item)));
  if (Array.isArray(value.messages)) {
    return value.messages.some((message) => {
      if (!isDict(message)) return false;
      const content = message.content;
      return Array.isArray(content) ? content.some(richBlock) : richBlock(content);
    });
  }
  return false;
}

/**
 * A `resources/read` or `prompts/get` result projected for the model; `null`
 * keeps the legacy JSON dump when everything is plain text (the source stays
 * verbatim). Blob resources become attachments or byte references.
 */
export function projectResourceContents(source: string, value: Row): { text: string; media: McpMedia[]; attachments: McpAttachmentMeta[] } | null {
  if (!hasRichContent(value)) return null;
  const budget = new Budget();
  const parts: string[] = [];
  const counters = { image: 0, resource: 0 };
  if (Array.isArray(value.contents)) {
    for (const item of value.contents) {
      if (!isDict(item)) continue;
      if (typeof item.text === "string") parts.push(item.text);
      else if (typeof item.blob === "string") {
        counters.resource += 1;
        parts.push(budget.attach(source, "resource", counters.resource, item.mimeType, item.blob) ?? referenceLine("Resource", item.uri, item.mimeType, item.blob));
      }
    }
  }
  if (Array.isArray(value.messages)) {
    for (const message of value.messages) {
      if (!isDict(message)) continue;
      const content = message.content;
      projectInto(budget, parts, source, counters, Array.isArray(content) ? content : [content]);
    }
  }
  return { text: clipChars(parts.join("\n"), CATALOG_CHARS), media: [...budget.media], attachments: [...budget.attachments] };
}
