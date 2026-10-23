/**
 * Tool-result media (ZCode Read's image and PDF content parts). The journal
 * keeps only references on the tool message (`_tool_media`); the bytes live in
 * a per-session sidecar so a resumed run still shows them. A Chat Completions
 * tool message cannot carry media, so each run of tool results is followed by
 * one request-only user message bound to the attachments (`bindToolMedia`).
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDict, pyJsonDumps } from "@xueness/contracts";
import { writeFileAtomic } from "@xueness/engine-tools";
import { b64decodeStrict, bindToolMedia, MAX_REQUEST_MEDIA_BYTES, MAX_REQUEST_MEDIA_ITEMS, MULTIMODAL_MARKER, splitMultimodal, SUPPORTED_IMAGES, validMediaSignature } from "@xueness/providers";
import type { AgentExtension, AgentProvider, ModelRequest, Row } from "./types.ts";

export interface ToolMediaRef { sha256: string; mimeType: string; size: number; placeholder: string }
export interface ModelInput { image: boolean; pdf: boolean }
/** Per request, newest first; older media reads as a note asking for a fresh Read. */
export const TOOL_MEDIA_MAX_ITEMS = 20;
export const TOOL_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
const MIMES: ReadonlySet<string> = new Set([...SUPPORTED_IMAGES, "application/pdf"]);
const SESSION = /^[0-9a-f]{32}$/, SHA256 = /^[0-9a-f]{64}$/;
const NOTE_BUDGET = "[Media omitted from provider request: tool media budget exceeded; Read the file again to view it.]";
const NOTE_UNAVAILABLE = "[Media omitted from provider request: the stored attachment is unavailable.]";
const unsupportedNote = (mime: string): string => `[Media omitted from provider request because the selected model does not support ${mime === "application/pdf" ? "PDF" : "image"} input.]`;

/** What the provider of the next request accepts (a pending model switch counts). */
export function modelInputOf(provider: AgentProvider): ModelInput {
  const target = (provider as { upcomingProvider?: () => AgentProvider }).upcomingProvider?.() ?? provider;
  const caps = target.capabilities;
  return { image: caps?.has("image") === true, pdf: caps?.has("pdf") === true && target.acceptsPdfDocuments === true };
}

const directory = (stateDir: string, sid: string): string | null => SESSION.test(sid) ? join(stateDir, "tool-media", sid) : null;
const digest = (raw: Uint8Array): string => createHash("sha256").update(raw).digest("hex");

/** Store a tool result's media and return its journal references; invalid items are dropped. */
export async function saveToolMedia(stateDir: string, sid: string, media: unknown): Promise<ToolMediaRef[]> {
  const dir = directory(stateDir, sid);
  if (!dir || !Array.isArray(media)) return [];
  const refs: ToolMediaRef[] = [];
  for (const item of media.slice(0, TOOL_MEDIA_MAX_ITEMS)) {
    if (!isDict(item) || typeof item.mimeType !== "string" || !MIMES.has(item.mimeType) || typeof item.placeholder !== "string") continue;
    let raw: Buffer;
    try { raw = b64decodeStrict(item.data); } catch { continue; }
    if (!raw.length || !validMediaSignature(raw, item.mimeType)) continue;
    const ref: ToolMediaRef = { sha256: digest(raw), mimeType: item.mimeType, size: raw.length, placeholder: item.placeholder.slice(0, 300) };
    // A failed write keeps the reference: the request then says the attachment is unavailable.
    try { await writeFileAtomic(join(dir, ref.sha256), raw); } catch { /* reported at request time */ }
    refs.push(ref);
  }
  return refs;
}

/** The stored bytes (base64) when they still match the reference. */
export async function loadToolMedia(stateDir: string, sid: string, ref: ToolMediaRef): Promise<string | null> {
  const dir = directory(stateDir, sid);
  if (!dir || !SHA256.test(ref.sha256)) return null;
  try {
    const raw = await readFile(join(dir, ref.sha256));
    return raw.length === ref.size && digest(raw) === ref.sha256 && validMediaSignature(raw, ref.mimeType) ? raw.toString("base64") : null;
  } catch { return null; }
}

function refsOf(value: unknown): ToolMediaRef[] {
  if (!Array.isArray(value)) return [];
  return value.filter((ref): ref is ToolMediaRef => isDict(ref) && typeof ref.sha256 === "string" && typeof ref.mimeType === "string" && MIMES.has(ref.mimeType)
    && typeof ref.size === "number" && Number.isInteger(ref.size) && ref.size > 0 && typeof ref.placeholder === "string");
}

/** User attachments in the request share the provider's per-request media budget. */
function userMedia(messages: readonly Row[]): { count: number; bytes: number } {
  let count = 0, bytes = 0;
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "developer") continue;
    if (Array.isArray(message._media_refs)) for (const ref of message._media_refs) { count += 1; bytes += isDict(ref) && typeof ref.size === "number" ? ref.size : 0; }
    if (typeof message.content !== "string" || !message.content.includes(MULTIMODAL_MARKER)) continue;
    try { for (const item of splitMultimodal(message.content)[1]) { count += 1; bytes += Math.ceil(JSON.stringify(item).length * 3 / 4); } } catch { /* the provider reports it */ }
  }
  return { count, bytes };
}

const lineOf = (ref: ToolMediaRef): string => `[Attached ${ref.mimeType}: ${ref.placeholder}]`;
// A microcompacted or rewritten result no longer shows the attachment line, so it gets no media.
const shown = (content: string, ref: ToolMediaRef): boolean => content.includes(lineOf(ref)) || content.includes(pyJsonDumps(lineOf(ref)).slice(1, -1));
function annotate(content: string, ref: ToolMediaRef, note: string): string {
  const line = lineOf(ref);
  return content.includes(line) ? content.replace(line, () => `${line}\n${note}`) : `${content}\n${note}`;
}

interface Entry { index: number; callId: string; ref: ToolMediaRef; data?: string; note?: string }

/** Runs last: it sees the request exactly as the provider will. */
export function toolMediaExtension(): AgentExtension {
  return {
    id: "sessions",
    async prepareRequest(context, request): Promise<ModelRequest> {
      const stored = new Map<string, ToolMediaRef[]>();
      for (const message of context.session.messages as unknown[]) {
        if (!isDict(message) || message.role !== "tool" || typeof message.tool_call_id !== "string") continue;
        const refs = refsOf(message._tool_media);
        if (refs.length) stored.set(message.tool_call_id, refs);
      }
      if (!stored.size) return request;
      const entries: Entry[] = [];
      request.messages.forEach((message, index) => {
        if (message.role !== "tool" || typeof message.tool_call_id !== "string" || typeof message.content !== "string") return;
        for (const ref of stored.get(message.tool_call_id) ?? []) if (shown(message.content, ref)) entries.push({ index, callId: message.tool_call_id, ref });
      });
      if (!entries.length) return request;
      const input = modelInputOf(context.provider);
      const used = userMedia(request.messages);
      let items = Math.min(TOOL_MEDIA_MAX_ITEMS, MAX_REQUEST_MEDIA_ITEMS - used.count);
      let bytes = Math.min(TOOL_MEDIA_MAX_BYTES, MAX_REQUEST_MEDIA_BYTES - used.bytes);
      for (const entry of [...entries].reverse()) {
        if (!(entry.ref.mimeType === "application/pdf" ? input.pdf : input.image)) { entry.note = unsupportedNote(entry.ref.mimeType); continue; }
        if (items < 1 || entry.ref.size > bytes) { entry.note = NOTE_BUDGET; continue; }
        const data = await loadToolMedia(context.stateDir, String(context.session.id), entry.ref);
        if (data === null) { entry.note = NOTE_UNAVAILABLE; continue; }
        entry.data = data; items -= 1; bytes -= entry.ref.size;
      }
      const messages: Row[] = [];
      let pending: Entry[] = [];
      const flush = (): void => {
        const attached = pending.filter((entry) => entry.data !== undefined);
        pending = [];
        if (!attached.length) return;
        const content = "Tool result media: " + attached.map((entry) => `${entry.ref.placeholder} (${entry.callId})`).join(", ");
        // The placeholder is the file's display name (`Read` puts the basename
        // there for a PDF), which the OpenAI `file` part sends as `filename`.
        messages.push(bindToolMedia({ role: "user", content }, attached.map((entry) => ({ mimeType: entry.ref.mimeType, data: entry.data, placeholder: entry.ref.placeholder }))));
      };
      request.messages.forEach((message, index) => {
        if (message.role !== "tool") flush();
        const own = entries.filter((entry) => entry.index === index);
        const noted = own.filter((entry) => entry.note);
        messages.push(noted.length ? { ...message, content: noted.reduce((text, entry) => annotate(text, entry.ref, entry.note!), message.content as string) } : message);
        pending.push(...own);
      });
      flush();
      return { ...request, messages };
    },
  };
}
