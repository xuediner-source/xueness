/**
 * Request media: the `XUENESS_MULTIMODAL_V1` attachment envelope, strict
 * base64 (`b64decode(validate=True)`), signatures, per-request budgets and
 * the OpenAI / Anthropic message conversions that embed attachments.
 */
import {
  PyTypeError, PyValueError, isDict, pyCasefold, pyDictGet, pyIter, pyJoin, pyJsonDumps, pyJsonLoads, pyStr,
  pyTruthy, pyTypeName,
} from "@xueness/contracts";
import { withReportedUsage } from "./metadata.ts";
import { nativeReasoning, replayableReasoning } from "./reasoning-metadata.ts";
import { normalizeModelToolArguments } from "./tool-input-normalization.ts";

type Dict = Record<string, unknown>;

export const MULTIMODAL_MARKER = "\n\nXUENESS_MULTIMODAL_V1:";
export const SUPPORTED_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const ATTACHMENT_TYPES = new Set([...SUPPORTED_IMAGES, "application/pdf", "video/mp4", "video/quicktime", "video/webm"]);
const MIB = 1024 * 1024;
export const MAX_REQUEST_MEDIA_BYTES = 64 * MIB;
export const MAX_REQUEST_MEDIA_ITEMS = 32;

const TABLE = new Int8Array(128).fill(-1);
"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".split("").forEach((char, index) => {
  TABLE[char.charCodeAt(0)] = index;
});

class Base64Error extends PyValueError {
  override name = "Error";
}

/** `base64.b64decode(value, validate=True)` (binascii strict mode) for JSON values. */
export function b64decodeStrict(value: unknown, dialect: "3.11" | "3.13" = "3.13"): Buffer {
  if (typeof value !== "string") {
    throw new PyTypeError(`argument should be a bytes-like object or ASCII string, not '${pyTypeName(value)}'`);
  }
  if (/[^\x00-\x7f]/.test(value)) throw new PyValueError("string argument should contain only ASCII characters");
  // CPython 3.13 `binascii.a2b_base64(strict_mode=True)`, statement for statement.
  const length = value.length;
  const out = Buffer.alloc(Math.floor((length + 3) / 4) * 3);
  let size = 0;
  let quad = 0;
  let left = 0;
  let pads = 0;
  if (value.startsWith("=")) throw new Base64Error("Leading padding not allowed");
  for (let index = 0; index < length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x3d) {
      if (dialect === "3.11") {
        pads += 1;
        if (quad >= 2 && quad + pads >= 4) {
          if (index + 1 < length) throw new Base64Error("Excess data after padding");
          return out.subarray(0, size);
        }
        continue;
      }
      pads += 1;
      if (quad >= 2 && quad + pads <= 4) continue;
      if (quad === 1) break;
      throw new Base64Error(quad === 0 && index === 0 ? "Leading padding not allowed" : "Excess padding not allowed");
    }
    const digit = TABLE[code] ?? -1;
    if (digit < 0) throw new Base64Error("Only base64 data is allowed");
    if (pads) throw new Base64Error(quad + pads === 4 ? "Excess data after padding" : "Discontinuous padding not allowed");
    if (quad === 0) {
      left = digit;
    } else if (quad === 1) {
      out[size++] = (left << 2) | (digit >> 4);
      left = digit & 0x0f;
    } else if (quad === 2) {
      out[size++] = ((left << 4) | (digit >> 2)) & 0xff;
      left = digit & 0x03;
    } else {
      out[size++] = ((left << 6) | digit) & 0xff;
    }
    quad = (quad + 1) % 4;
  }
  if (quad === 1) {
    const count = Math.floor(size / 3) * 4 + 1;
    throw new Base64Error(`Invalid base64-encoded string: number of data characters (${count}) cannot be 1 more than a multiple of 4`);
  }
  if (quad !== 0 && quad + pads < 4) throw new Base64Error("Incorrect padding");
  return out.subarray(0, size);
}

function startsWith(data: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => data[index] === byte);
}

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

/** `_valid_media_signature`. */
export function validMediaSignature(data: Uint8Array, mime: string): boolean {
  if (mime === "application/pdf") return startsWith(data, ascii("%PDF-"));
  if (mime === "image/png") return startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (mime === "image/jpeg") return startsWith(data, [0xff, 0xd8, 0xff]);
  if (mime === "image/gif") return startsWith(data, ascii("GIF87a")) || startsWith(data, ascii("GIF89a"));
  if (mime === "image/webp") return startsWith(data, ascii("RIFF")) && startsWith(data.subarray(8, 12), ascii("WEBP"));
  return false;
}

/** `_provider_capabilities`: configured capabilities, or the model-family default. */
export function providerCapabilities(model: string, configured: Iterable<string> | null | undefined): Set<string> {
  if (configured !== null && configured !== undefined) return new Set(configured);
  const name = pyCasefold(model || "");
  if (["gpt-4o", "gpt-4.1", "gpt-4.5", "gpt-5", "o1", "o3", "o4"].some((prefix) => name.startsWith(prefix))) {
    return new Set(["image", "video", "pdf"]);
  }
  // Gemini reaches this adapter through its OpenAI-compatible endpoint, which
  // takes PDFs as a `file` part exactly like OpenAI's own families do.
  if (name.startsWith("gemini")) return new Set(["image", "video", "pdf"]);
  return new Set();
}

function memberOf(set: ReadonlySet<string>, value: unknown): boolean {
  if (Array.isArray(value) || isDict(value)) throw new PyTypeError(`unhashable type: '${pyTypeName(value)}'`);
  return typeof value === "string" && set.has(value);
}

function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/** `_split_multimodal`: visible text plus validated attachments. */
export function splitMultimodal(content: unknown): [string, Dict[]] {
  if (typeof content !== "string" || !content.includes(MULTIMODAL_MARKER)) return [typeof content === "string" ? content : "", []];
  const cut = content.lastIndexOf(MULTIMODAL_MARKER);
  const text = content.slice(0, cut);
  const raw = content.slice(cut + MULTIMODAL_MARKER.length);
  if (raw.length > 6_000_000 && codePointLength(raw) > 6_000_000) throw new PyValueError("multimodal attachment payload too large");
  let items: unknown;
  try {
    items = pyJsonLoads(raw);
  } catch {
    throw new PyValueError("malformed multimodal attachment payload");
  }
  if (!Array.isArray(items) || items.length > 4) throw new PyValueError("invalid multimodal attachment list");
  let total = 0;
  for (const item of items) {
    if (!isDict(item) || !memberOf(ATTACHMENT_TYPES, Object.hasOwn(item, "mimeType") ? item["mimeType"] : null)) {
      throw new PyValueError("unsupported multimodal attachment");
    }
    const mime = item["mimeType"] as string;
    const value = Object.hasOwn(item, "data") ? item["data"] : null;
    let rawData: Buffer | null = null;
    if (value !== null && value !== undefined) {
      try {
        rawData = b64decodeStrict(value);
      } catch {
        throw new PyValueError("malformed multimodal attachment data");
      }
      if (rawData.length > 2 * MIB) throw new PyValueError("multimodal attachment data exceeds per-file limit");
      total += rawData.length;
    }
    if (mime.startsWith("video/")) {
      if (rawData !== null) throw new PyValueError("video attachment must contain extracted frames, not raw video");
    } else if (rawData === null || !validMediaSignature(rawData, mime)) {
      throw new PyValueError("multimodal attachment data is missing or does not match its MIME type");
    }
    const frames = Object.hasOwn(item, "framesData") ? item["framesData"] : [];
    if (!Array.isArray(frames) || frames.length > 6 || (frames.length && !mime.startsWith("video/"))) {
      throw new PyValueError("invalid video frame list");
    }
    for (const frame of frames) {
      let rawFrame: Buffer;
      try {
        rawFrame = b64decodeStrict(frame);
      } catch {
        throw new PyValueError("malformed video frame data");
      }
      if (!startsWith(rawFrame, [0xff, 0xd8, 0xff]) || rawFrame.length > 2 * MIB) throw new PyValueError("invalid video frame data");
      total += rawFrame.length;
    }
    if (mime.startsWith("video/") && !frames.length) throw new PyValueError("video attachment contains no extracted frames");
    if (total > 16 * MIB) throw new PyValueError("multimodal attachment set exceeds total size limit");
  }
  return [text, items as Dict[]];
}

export interface MediaProvider {
  readonly capabilities: ReadonlySet<string>;
}

/**
 * Invocation-scoped attachment authority (`media_input.bind_prompt`). The
 * sessions host supplies one for accepted journal messages carrying
 * `_media_refs`; without it such references are refused.
 */
export interface MediaBinding {
  resolve(message: Dict, provider: MediaProvider, media: RequestMedia): Dict[];
}

// Like Python's nonserialized _BoundMediaMessage subclass: stripping private
// journal fields must not let a sanitized object outlive its invocation scope.
const BOUND_MEDIA_MESSAGES = new WeakSet<Dict>();
export function markBoundMediaMessage(message: Dict): void { BOUND_MEDIA_MESSAGES.add(message); }

/** `media_input.RequestMedia`: one body build's shared media budget. */
export class RequestMedia {
  total = 0;
  count = 0;
  readonly binding: MediaBinding | null;
  constructor(binding: MediaBinding | null = null) {
    this.binding = binding;
  }

  account(attachments: readonly Dict[]): void {
    for (const item of attachments) {
      this.count += 1;
      const values = Object.hasOwn(item, "data") ? [item["data"]] : pyIter(Object.hasOwn(item, "framesData") ? item["framesData"] : []);
      for (const value of values) this.total += b64decodeStrict(value).length;
    }
    if (this.total > MAX_REQUEST_MEDIA_BYTES || this.count > MAX_REQUEST_MEDIA_ITEMS) {
      throw new PyValueError("provider request media budget exceeded");
    }
  }

  resolve(message: Dict, provider: MediaProvider): Dict[] {
    if (this.binding) return this.binding.resolve(message, provider, this);
    // Hidden metadata on a bare call is never accepted as authority.
    if (BOUND_MEDIA_MESSAGES.has(message) || pyTruthy(Object.hasOwn(message, "_media_refs") ? message["_media_refs"] : null)) {
      throw new PyValueError("media references require an authorized invocation");
    }
    return [];
  }
}

// Tool-result media (Read images/PDFs) rides on a request-only user message;
// like bound journal media it never serializes, so a copy carries nothing.
const TOOL_MEDIA = new WeakMap<Dict, readonly Dict[]>();
export function hasRequestMedia(message: Dict): boolean { return BOUND_MEDIA_MESSAGES.has(message) || TOOL_MEDIA.has(message) || !!message._media_refs; }
export function bindToolMedia<T extends Dict>(message: T, attachments: readonly Dict[]): T { TOOL_MEDIA.set(message, attachments.map((item) => ({ ...item }))); return message; }
export function transferToolMedia(from: Dict, to: Dict): void { const media = TOOL_MEDIA.get(from); if (media) TOOL_MEDIA.set(to, media); }

function attachmentsFor(message: Dict, content: unknown, provider: MediaProvider, media: RequestMedia): [string, Dict[]] {
  const [text, attachments] = splitMultimodal(content);
  media.account(attachments);
  const tool = TOOL_MEDIA.get(message) ?? [];
  media.account(tool);
  return [text, [...attachments, ...tool, ...media.resolve(message, provider)]];
}

/** `_openai_messages`: drop `_` metadata and embed user attachments as data URLs. */
export function openAiMessages(messages: readonly Dict[], provider: MediaProvider, binding: MediaBinding | null = null): Dict[] {
  const media = new RequestMedia(binding);
  return messages.map((message) => {
    const item: Dict = Object.fromEntries(Object.entries(message).filter(([key]) => !key.startsWith("_")));
    if (item["role"] !== "user") return item;
    const content = Object.hasOwn(item, "content") ? item["content"] : null;
    const [text, attachments] = attachmentsFor(message, pyTruthy(content) ? content : "", provider, media);
    if (!attachments.length) return item;
    const parts: Dict[] = text ? [{ type: "text", text }] : [];
    for (const attachment of attachments) {
      const mime = attachment["mimeType"] as string;
      let images: unknown[];
      if (mime === "application/pdf") {
        if (!provider.capabilities.has("pdf")) throw new PyValueError("selected model does not declare PDF input support");
        // Chat Completions carries a document as a base64 `file` part; the
        // Responses API spells the same bytes `input_file`.
        const name = typeof attachment["placeholder"] === "string" && attachment["placeholder"] ? attachment["placeholder"] : "document.pdf";
        parts.push({ type: "file", file: { filename: name, file_data: `data:${mime};base64,${pyStr(Object.hasOwn(attachment, "data") ? attachment["data"] : "")}` } });
        continue;
      }
      if (mime.startsWith("video/")) {
        if (!provider.capabilities.has("video") || !pyTruthy(attachment["framesData"])) {
          throw new PyValueError("selected model does not declare video-frame input support");
        }
        images = pyIter(attachment["framesData"]);
      } else {
        if (!SUPPORTED_IMAGES.has(mime) || !provider.capabilities.has("image")) {
          throw new PyValueError("selected model does not declare image input support");
        }
        images = [Object.hasOwn(attachment, "data") ? attachment["data"] : ""];
      }
      for (const encoded of images) {
        const type = mime.startsWith("video/") ? "image/jpeg" : mime;
        parts.push({ type: "image_url", image_url: { url: `data:${type};base64,${pyStr(encoded)}` } });
      }
    }
    item["content"] = parts;
    return item;
  });
}

function get(record: Dict, key: string, fallback: unknown = null): unknown {
  return Object.hasOwn(record, key) ? record[key] : fallback;
}

/** `_to_anthropic_messages`: the system prompt and Messages API turns. */
export function anthropicMessages(messages: readonly Dict[], provider: MediaProvider, binding: MediaBinding | null = null): [string, Dict[]] {
  const media = new RequestMedia(binding);
  const system: string[] = [];
  const converted: Dict[] = [];
  const append = (role: string, content: Dict[]): void => {
    const last = converted[converted.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) last.content.push(...content);
    else converted.push({ role, content: [...content] });
  };
  let leading = true;
  for (const message of messages) {
    const role = get(message, "role");
    const raw = get(message, "content");
    const content = pyTruthy(raw) ? raw : "";
    if (role === "system") {
      if (leading) { if (pyTruthy(content)) system.push(pyStr(content)); }
      else converted.push({ role: "system", content: Array.isArray(content) ? nativeReasoning(content) : pyStr(content) });
    } else if (role === "assistant") {
      leading = false;
      const blocks: Dict[] = Array.isArray(content) ? nativeReasoning(content) : pyTruthy(content) ? [{ type: "text", text: pyStr(content) }] : [];
      const calls = get(message, "tool_calls");
      for (const call of pyIter(pyTruthy(calls) ? calls : [])) {
        const fnRaw = pyDictGet(call, "function");
        const fn = pyTruthy(fnRaw) ? fnRaw : {};
        let args: unknown;
        try {
          const text = pyDictGet(fn, "arguments");
          args = pyTruthy(text) ? (typeof text === "string" ? pyJsonLoads(text) : typeError(text)) : pyJsonLoads("{}");
        } catch (error) {
          if (!(error instanceof PyTypeError || error instanceof PyValueError || error instanceof SyntaxError)) throw error;
          args = {};
        }
        blocks.push({ type: "tool_use", id: pyDictGet(call, "id", ""), name: pyDictGet(fn, "name", ""), input: isDict(args) ? args : {} });
      }
      if (blocks.length) append("assistant", blocks);
    } else if (role === "tool") {
      leading = false;
      append("user", [{ type: "tool_result", tool_use_id: get(message, "tool_call_id", ""), content: pyStr(content) }]);
    } else if (role === "user" || role === "developer") {
      leading = false;
      const value = Array.isArray(content) ? content.filter(isDict).filter((block) => block.type === "text").map((block) => String(block.text ?? "")).join("") : pyStr(content);
      const [text, attachments] = attachmentsFor(message, value, provider, media);
      const blocks: Dict[] = text ? [{ type: "text", text }] : [];
      for (const attachment of attachments) {
        const mime = attachment["mimeType"] as string;
        const data = get(attachment, "data", "");
        if (mime.startsWith("image/")) {
          if (!SUPPORTED_IMAGES.has(mime) || !provider.capabilities.has("image")) {
            throw new PyValueError("selected model does not declare image input support");
          }
          blocks.push({ type: "image", source: { type: "base64", media_type: mime, data } });
        } else if (mime === "application/pdf") {
          if (!provider.capabilities.has("pdf")) throw new PyValueError("selected model does not declare PDF input support");
          blocks.push({ type: "document", source: { type: "base64", media_type: mime, data } });
        } else if (mime.startsWith("video/")) {
          if (!provider.capabilities.has("video") || !pyTruthy(attachment["framesData"])) {
            throw new PyValueError("selected model does not declare video-frame input support");
          }
          for (const frame of pyIter(attachment["framesData"])) {
            blocks.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: frame } });
          }
        }
      }
      if (blocks.length) append("user", blocks);
    }
  }
  return [system.join("\n\n"), converted];
}

function typeError(value: unknown): never {
  throw new PyTypeError(`the JSON object must be str, bytes or bytearray, not ${pyTypeName(value)}`);
}

/** `_anthropic_message`: a non-streamed Messages reply in the journal's shape. */
export function anthropicMessage(payload: unknown): Dict {
  const rawBlocks = pyDictGet(payload, "content");
  const text: unknown[] = [];
  const calls: Dict[] = [];
  for (const block of pyIter(pyTruthy(rawBlocks) ? rawBlocks : [])) {
    if (!isDict(block)) continue;
    if (block["type"] === "text") {
      const value = get(block, "text");
      text.push(pyTruthy(value) ? value : "");
    } else if (block["type"] === "tool_use") {
      const input = get(block, "input");
      calls.push({
        id: get(block, "id", ""), type: "function",
        function: { name: get(block, "name", ""), arguments: normalizeModelToolArguments(input) },
      });
    }
  }
  const reasoning = replayableReasoning(rawBlocks);
  return withReportedUsage({ content: pyJoin(text), tool_calls: calls, ...reasoning.length ? { _reasoning_blocks: reasoning } : {} }, payload);
}
