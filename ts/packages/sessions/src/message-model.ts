/**
 * Canonical message and content-part model (C-SES-01).
 *
 * Journal messages are plain JSON rows shaped by the runtime (`role`,
 * `content`, `tool_calls`, underscore-private metadata). This module gives
 * them one typed projection: stable identities (`_message_id`, `_turn_id`,
 * tool-call ids), an origin, a visibility class, a revision counter and
 * typed content parts (text, documents, reasoning, tool calls and results,
 * media groups, media references, hidden reminders, compaction markers).
 *
 * Decoding is lossless: every byte of the journal row is either consumed by
 * a part (keeping the raw entry when the runtime may add fields) or
 * preserved in `meta`, and `encodeJournalMessage` reassembles an equal row
 * (`jsonEquals`). Private metadata (media payloads, read state, guide
 * flags, hidden reminders) stays in the journal but is excluded from the
 * model-visible payload. Duplicate identities are rejected explicitly.
 */
import { isDict, isPyIntValue, pyDictGet, pyEquals, pyJsonLoads, PyTypeError, PyValueError } from "@xueness/contracts";
import { digest, jsonEquals } from "./history-ops.ts";
import { MULTIMODAL_MARKER } from "./attachments.ts";

export const CANONICAL_MESSAGE_MODEL = "xueness.message-model.v1";
const MESSAGE_ID = /^[0-9a-f]{32}$/;
const TURN_ID = /^turn-[1-9][0-9]*$/;
const TOOL_CALL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ROLES = new Set(["system", "user", "assistant", "tool"]);

export type MessageOrigin = "system" | "user" | "guide" | "assistant" | "tool";
export type MessageVisibility = "visible" | "hidden";

export interface TextPart { type: "text"; text: string }
/** Structured (non-string) content, kept verbatim. */
export interface DocumentPart { type: "document"; content: unknown }
export interface ReasoningPart { type: "reasoning"; text: string }
export interface ToolCallPart { type: "tool_call"; toolCallId: string; name: string; arguments: string; raw: Row }
export interface ToolResultPart { type: "tool_result"; toolCallId: string; content: unknown; hasContent: boolean; isError: boolean }
/** The multimodal marker block of an attachment payload (`with_attachments`). */
export interface MediaGroupPart { type: "media_group"; text: string; encoded: string }
/** A private `_media_refs` entry: identity fields plus the raw entry. */
export interface MediaRefPart { type: "media_ref"; mediaId: string; mimeType: string | null; sha256: string | null; raw: Row }
export interface HiddenReminderPart { type: "hidden_reminder"; text: string }
export interface CompactionPart { type: "compaction"; marker: string; raw: Row }

export type CanonicalPart =
  | TextPart | DocumentPart | ReasoningPart | ToolCallPart | ToolResultPart | MediaGroupPart | MediaRefPart
  | HiddenReminderPart | CompactionPart;

export interface CanonicalMessage {
  model: typeof CANONICAL_MESSAGE_MODEL;
  messageId: string;
  turnId: string;
  role: string;
  origin: MessageOrigin;
  visibility: MessageVisibility;
  /** Message-level revision counter (`_revision`); 0 when the row has none. */
  revision: number;
  parts: CanonicalPart[];
}

/** A decoded journal row: the canonical message plus its private metadata. */
export interface DecodedMessage {
  message: CanonicalMessage;
  meta: Record<string, unknown>;
}

type Row = Record<string, unknown>;

function isMessageId(value: unknown): value is string {
  return typeof value === "string" && MESSAGE_ID.test(value);
}

function isTurnId(value: unknown): value is string {
  return typeof value === "string" && TURN_ID.test(value);
}

function isToolCallId(value: unknown): value is string {
  return typeof value === "string" && TOOL_CALL_ID.test(value);
}

function originOf(row: Row, role: string): MessageOrigin {
  if (role === "user" && pyEquals(pyDictGet(row, "_input_kind"), "guide")) return "guide";
  return role as MessageOrigin;
}

/**
 * `decode`: split a journal row into typed parts and private metadata.
 * Underscore keys the model does not consume are preserved verbatim in
 * `meta`, so `encode(decode(row))` equals `row`.
 */
export function decodeJournalMessage(row: unknown): DecodedMessage {
  if (!isDict(row)) throw new PyTypeError("journal message must be a JSON object");
  const roleRaw = pyDictGet(row, "role");
  if (typeof roleRaw !== "string" || !ROLES.has(roleRaw)) throw new PyValueError("invalid journal message role");
  const messageId = pyDictGet(row, "_message_id");
  const turnId = pyDictGet(row, "_turn_id");
  if (!isMessageId(messageId)) throw new PyValueError("journal message is missing a stable identity");
  if (!isTurnId(turnId)) throw new PyValueError("journal message is missing a stable turn identity");
  const revisionRaw = pyDictGet(row, "_revision", 0);
  const revision = isPyIntValue(revisionRaw) && Number(revisionRaw) >= 0 ? Number(revisionRaw) : 0;
  const hidden = pyDictGet(row, "_hidden") === true || pyEquals(pyDictGet(row, "_visibility"), "hidden");
  const parts: CanonicalPart[] = [];
  const consumed = new Set<string>(["role", "_message_id", "_turn_id"]);
  const content = pyDictGet(row, "content");
  const compaction = pyDictGet(row, "_compaction");
  if (isDict(compaction)) {
    consumed.add("_compaction");
    const marker = pyDictGet(compaction, "marker");
    if (typeof marker !== "string" || !marker) throw new PyValueError("invalid compaction marker");
    parts.push({ type: "compaction", marker, raw: compaction });
  } else if (roleRaw === "tool") {
    const callId = pyDictGet(row, "tool_call_id");
    if (!isToolCallId(callId)) throw new PyValueError("tool result is missing its tool call identity");
    consumed.add("tool_call_id");
    const hasContent = content !== undefined && content !== null;
    if (hasContent) consumed.add("content");
    const isError = pyDictGet(row, "is_error") === true;
    if (isError) consumed.add("is_error");
    parts.push({ type: "tool_result", toolCallId: callId, content: hasContent ? content : null, hasContent, isError });
  } else if (typeof content === "string" && content.includes(MULTIMODAL_MARKER)) {
    consumed.add("content");
    const at = content.indexOf(MULTIMODAL_MARKER);
    const text = content.slice(0, at);
    const encoded = content.slice(at + MULTIMODAL_MARKER.length);
    pyJsonLoads(encoded); // refuse a torn marker block instead of silently losing it
    if (text) parts.push({ type: "text", text });
    parts.push({ type: "media_group", text: "", encoded });
  } else if (content !== undefined && content !== null) {
    consumed.add("content");
    parts.push(typeof content === "string"
      ? (hidden ? { type: "hidden_reminder", text: content } : { type: "text", text: content })
      : { type: "document", content });
  }
  const reasoning = pyDictGet(row, "reasoning");
  if (typeof reasoning === "string" && reasoning) {
    consumed.add("reasoning");
    parts.push({ type: "reasoning", text: reasoning });
  }
  const calls = pyDictGet(row, "tool_calls");
  if (Array.isArray(calls)) {
    consumed.add("tool_calls");
    for (const call of calls) {
      if (!isDict(call)) throw new PyValueError("invalid tool call entry");
      const id = pyDictGet(call, "id");
      const fn = pyDictGet(call, "function");
      if (!isToolCallId(id) || !isDict(fn) || typeof pyDictGet(fn, "name") !== "string") {
        throw new PyValueError("tool call is missing a stable identity");
      }
      const args = pyDictGet(fn, "arguments");
      parts.push({ type: "tool_call", toolCallId: id, name: pyDictGet(fn, "name") as string, arguments: typeof args === "string" ? args : "", raw: call });
    }
  }
  const mediaRefs = pyDictGet(row, "_media_refs");
  if (Array.isArray(mediaRefs)) {
    consumed.add("_media_refs");
    for (const ref of mediaRefs) {
      if (!isDict(ref)) throw new PyValueError("invalid media reference");
      const id = pyDictGet(ref, "id") ?? pyDictGet(ref, "media_id");
      if (typeof id !== "string" || !id) throw new PyValueError("media reference is missing its identity");
      parts.push({
        type: "media_ref", mediaId: id,
        mimeType: typeof pyDictGet(ref, "mimeType") === "string" ? pyDictGet(ref, "mimeType") as string : null,
        sha256: typeof pyDictGet(ref, "sha256") === "string" ? pyDictGet(ref, "sha256") as string : null,
        raw: ref,
      });
    }
  }
  const meta: Row = {};
  for (const key of Object.keys(row)) if (!consumed.has(key)) meta[key] = row[key];
  return {
    message: {
      model: CANONICAL_MESSAGE_MODEL, messageId, turnId, role: roleRaw, origin: originOf(row, roleRaw),
      visibility: hidden || parts.some((part) => part.type === "compaction") ? "hidden" : "visible",
      revision, parts,
    },
    meta,
  };
}

/**
 * `encode`: reassemble the journal row. Everything the model did not
 * consume comes back from `meta`, so the round trip is lossless.
 */
export function encodeJournalMessage(decoded: DecodedMessage): Row {
  const { message, meta } = decoded;
  const row: Row = { ...meta };
  const contentPart = message.parts.find((part): part is ToolResultPart | TextPart | DocumentPart | HiddenReminderPart | MediaGroupPart =>
    part.type === "tool_result" || part.type === "text" || part.type === "document" || part.type === "hidden_reminder" || part.type === "media_group");
  if (contentPart?.type === "tool_result") {
    row.role = "tool";
    row.tool_call_id = contentPart.toolCallId;
    if (contentPart.hasContent) row.content = contentPart.content;
    if (contentPart.isError) row.is_error = true;
  } else {
    row.role = message.role;
    if (contentPart?.type === "document") row.content = contentPart.content;
    else if (contentPart?.type === "hidden_reminder") row.content = contentPart.text;
    else if (contentPart?.type === "text" || contentPart?.type === "media_group") {
      const text = contentPart.type === "text" ? contentPart.text : "";
      const group = message.parts.find((part): part is MediaGroupPart => part.type === "media_group");
      row.content = group ? text + MULTIMODAL_MARKER + group.encoded : text;
    }
  }
  const reasoning = message.parts.find((part): part is ReasoningPart => part.type === "reasoning");
  if (reasoning) row.reasoning = reasoning.text;
  const calls = message.parts.filter((item): item is ToolCallPart => item.type === "tool_call");
  if (calls.length) row.tool_calls = calls.map((call) => call.raw);
  const refs = message.parts.filter((item): item is MediaRefPart => item.type === "media_ref");
  if (refs.length) row._media_refs = refs.map((ref) => ref.raw);
  const compaction = message.parts.find((part): part is CompactionPart => part.type === "compaction");
  if (compaction) row._compaction = compaction.raw;
  row._message_id = message.messageId;
  row._turn_id = message.turnId;
  return row;
}

/** The model-visible payload: role plus the parts a consumer may see. */
export function visiblePayload(message: CanonicalMessage): { role: string; parts: CanonicalPart[] } {
  if (message.visibility === "hidden") return { role: message.role, parts: [] };
  return {
    role: message.role,
    parts: message.parts
      .filter((part) => part.type !== "hidden_reminder" && part.type !== "compaction" && part.type !== "reasoning" && part.type !== "media_ref")
      .map((part) => (part.type === "media_group" ? ({ type: "media_group", text: "", encoded: "" } as MediaGroupPart) : part)),
  };
}

/**
 * Decode every message of a session and reject duplicate identities —
 * message ids and tool call ids reused inside one message (C-SES-01).
 */
export function decodeSessionMessages(session: unknown): DecodedMessage[] {
  if (!isDict(session) || !Array.isArray(pyDictGet(session, "messages"))) {
    throw new PyValueError("session is missing its message history");
  }
  const rows = pyDictGet(session, "messages") as unknown[];
  const seen = new Set<string>();
  const decoded: DecodedMessage[] = [];
  for (const row of rows) {
    const item = decodeJournalMessage(row);
    const { message } = item;
    if (seen.has(message.messageId)) throw new PyValueError(`duplicate message identity: ${message.messageId}`);
    seen.add(message.messageId);
    const callIds = new Set<string>();
    for (const part of message.parts) {
      const id = part.type === "tool_call" || part.type === "tool_result" ? part.toolCallId : null;
      if (id !== null) {
        if (callIds.has(id)) throw new PyValueError(`duplicate tool call identity: ${id}`);
        callIds.add(id);
      }
    }
    decoded.push(item);
  }
  return decoded;
}

/** True when a journal row survives the model round trip unchanged. */
export function roundTrips(row: unknown): boolean {
  return jsonEquals(encodeJournalMessage(decodeJournalMessage(row)), row);
}

/** A stable digest of the canonical projection, for store-migration checks. */
export function canonicalSessionDigest(session: unknown): string {
  const decoded = decodeSessionMessages(session);
  return digest(decoded.map(({ message, meta }) => ({
    messageId: message.messageId, turnId: message.turnId, role: message.role, origin: message.origin,
    visibility: message.visibility, revision: message.revision, parts: message.parts, meta,
  })));
}
