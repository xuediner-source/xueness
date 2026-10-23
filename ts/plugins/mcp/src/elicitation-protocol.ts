/**
 * In-process elicitation waiters (Python `elicitation.py` bind / response / resolve).
 * The TS process has no CLI prompt: plan mode, children, and missing sessions decline.
 * A web session parks the request and the HTTP handler resolves it.
 */
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDict, pyEncodeUtf8, pyJsonDumps } from "@xueness/contracts";
import { exists, fsyncDirectory, isLink, mkstemp, protectPrivateFile, replaceFile, writeAll } from "@xueness/sessions";
import { validateContent, validateRequested } from "./elicitation-schema.ts";
import type { Row } from "./names.ts";

export const ELICITATION_PROTOCOL = "2025-06-18";
export const USER_WAIT_SECONDS = 600;
const MAX_NAME = 64;
const MAX_DIAGNOSTICS = 50;
const SESSION = /^[0-9a-f]{32}$/;
interface Waiter { public: Row; action: string | null; content: Row | null; done: boolean; wake: (signaled: boolean) => void }

const pending = new Map<string, Waiter>();
const diagnostics: Row[] = [];

export function elicitationEnabled(server: unknown): boolean {
  return isDict(server) && server.elicitation === true;
}

export function initializeCapabilities(server: unknown): Row {
  return elicitationEnabled(server) ? { elicitation: {} } : {};
}

function stateKey(stateDir: string | null): string {
  if (stateDir === null) return "";
  try {
    const abs = resolve(stateDir);
    return process.platform === "win32" ? abs.toLowerCase() : abs;
  } catch { return String(stateDir); }
}

function pendingKey(stateDir: string | null, sessionId: string): string {
  return `${stateKey(stateDir)}\0${sessionId}`;
}

function note(serverId: string, code: string): void {
  if (!code) return;
  diagnostics.push({ at: Math.trunc(Date.now() / 1000), serverId: String(serverId || "").slice(0, MAX_NAME), code: code.slice(0, 64) });
  if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.splice(0, diagnostics.length - MAX_DIAGNOSTICS);
}

function serverIdOf(server: unknown): string {
  return isDict(server) && typeof server.id === "string" ? server.id.slice(0, MAX_NAME) : "";
}

function serverName(server: unknown): string {
  const raw = isDict(server) ? typeof server.name === "string" && server.name.trim() ? server.name : typeof server.id === "string" ? server.id : "" : "";
  const cleaned = [...raw].filter((char) => char >= " " && char !== "\u007f").join("").trim();
  return cleaned.slice(0, 120) || "MCP";
}

function publicCopy(row: Row): Row {
  return { id: row.id, serverId: row.serverId, serverName: row.serverName, message: row.message, requestedSchema: row.requestedSchema, expiresAt: row.expiresAt };
}

function writePrivate(path: string, item: Row): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temp = mkstemp(parent, ".resource-");
  try {
    try { protectPrivateFile(temp.fd); writeAll(temp.fd, pyEncodeUtf8(pyJsonDumps(item, { ensureAscii: false, indent: 2 }))); fsyncSync(temp.fd); }
    finally { closeSync(temp.fd); }
    replaceFile(temp.path, path);
  } finally { if (exists(temp.path)) unlinkSync(temp.path); }
  try { fsyncDirectory(parent); } catch { /* directory fsync is best-effort */ }
}

function pendingPath(stateDir: string | null, sessionId: string): string | null {
  if (stateDir === null || !SESSION.test(sessionId)) return null;
  const directory = resolve(stateDir, "mcp-elicitations");
  const path = resolve(directory, `${sessionId}.json`);
  if (isLink(stateDir) || isLink(directory) || isLink(path)) return null;
  return path;
}

function writePublic(stateDir: string | null, sessionId: string, row: Row): void {
  const path = pendingPath(stateDir, sessionId);
  if (!path) return;
  try { writePrivate(path, publicCopy(row)); } catch { /* a failed publication still lets the in-memory waiter answer */ }
}

export function deleteElicitationPublic(stateDir: string | null, sessionId: string): void {
  const path = pendingPath(stateDir, sessionId);
  if (!path || !exists(path)) return;
  try { unlinkSync(path); } catch { /* already gone */ }
}

function lookup(sessionId: string, stateDir: string | null): string | null {
  if (stateDir !== null) return pendingKey(stateDir, sessionId);
  const matches = [...pending.keys()].filter((key) => key.endsWith(`\0${sessionId}`));
  return matches.length === 1 ? matches[0]! : null;
}

export function pendingPublic(sessionId: string, stateDir: string | null): Row | null {
  const key = lookup(sessionId, stateDir);
  const waiter = key ? pending.get(key) : undefined;
  if (!waiter || waiter.done) return null;
  return publicCopy(waiter.public);
}

export function resolveElicitation(sessionId: string, rpcId: unknown, action: unknown, content: unknown, stateDir: string | null): "ok" | "missing" | "mismatch" | [string, string, string | null] {
  if (action !== "accept" && action !== "decline" && action !== "cancel") return ["invalid", "action", null];
  const key = lookup(sessionId, stateDir);
  const waiter = key ? pending.get(key) : undefined;
  if (!waiter || waiter.done) return "missing";
  if (waiter.public.id !== rpcId) return "mismatch";
  if (action === "accept") {
    const [clean, code, field] = validateContent(waiter.public.requestedSchema, content);
    if (code) return ["invalid", code, field];
    waiter.content = clean;
  } else waiter.content = null;
  waiter.action = action;
  waiter.done = true;
  waiter.wake(true);
  return "ok";
}

function sessionUnattended(session: unknown): boolean {
  if (!isDict(session)) return true;
  if (session.permission_mode === "plan" || session.mode === "plan" || session.read_only === true || session.parent) return true;
  return typeof session.id === "string" && session.id.startsWith("sub-");
}

function rpcResult(id: unknown, action: string, content?: Row | null): Row {
  const result: Row = { action };
  if (action === "accept") result.content = isDict(content) ? content : {};
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string): Row {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function park(sessionId: string, stateDir: string | null, row: Row, timeout: number): Promise<[string, Row | null]> {
  const key = pendingKey(stateDir, sessionId);
  let wake!: (signaled: boolean) => void;
  const event = new Promise<boolean>((resolve) => { wake = resolve; });
  const waiter: Waiter = { public: row, action: null, content: null, done: false, wake };
  const current = pending.get(key);
  if (current && !current.done) { note(String(row.serverId ?? ""), "busy"); return ["decline", null]; }
  pending.set(key, waiter);
  writePublic(stateDir, sessionId, row);
  const timer = setTimeout(() => wake(false), timeout * 1000);
  try {
    const signaled = await event;
    const action = waiter.action;
    const content = waiter.content;
    waiter.content = null;
    if (!signaled || (action !== "accept" && action !== "decline" && action !== "cancel")) return ["timeout", null];
    return [action, content];
  } finally {
    clearTimeout(timer);
    if (pending.get(key) === waiter) pending.delete(key);
    deleteElicitationPublic(stateDir, sessionId);
  }
}

/** Answer one server request. The caller must not await this inside the read loop. */
export async function responseFor(server: Row, message: Row): Promise<Row> {
  const id = message.id;
  const sid = serverIdOf(server);
  try {
    if (message.method !== "elicitation/create") { note(sid, "unsupported"); return rpcError(id, -32601, "method not found"); }
    if (!elicitationEnabled(server)) { note(sid, "disabled"); return rpcError(id, -32601, "elicitation is disabled"); }
    const [schema, text, code] = validateRequested(message.params);
    if (code || !schema || text === null) { note(sid, code ?? "invalid_schema"); return rpcResult(id, "decline"); }
    const session = server._elicitation_session;
    const stateDir = typeof server._state_dir === "string" ? server._state_dir : null;
    if (sessionUnattended(session) || !isDict(session) || typeof session.id !== "string" || !SESSION.test(session.id) || stateDir === null) {
      note(sid, "unattended");
      return rpcResult(id, "decline");
    }
    const row = { id, serverId: sid, serverName: serverName(server), message: text, requestedSchema: schema, expiresAt: Math.trunc(Date.now() / 1000 + USER_WAIT_SECONDS) };
    let [action, content] = await park(session.id, stateDir, row, USER_WAIT_SECONDS);
    if (action === "timeout") { note(sid, "timeout"); action = "cancel"; }
    else if (action === "decline" || action === "cancel") note(sid, action === "decline" ? "declined" : "cancelled");
    return rpcResult(id, action === "accept" || action === "decline" || action === "cancel" ? action : "cancel", action === "accept" ? content : null);
  } catch {
    note(sid, "internal");
    return rpcResult(id, "decline");
  }
}

export function resetElicitationState(stateDir: string | null = null): void {
  const state = stateDir === null ? null : stateKey(stateDir);
  for (const [key, waiter] of [...pending.entries()]) {
    if (state !== null && !key.startsWith(`${state}\0`)) continue;
    waiter.content = null;
    waiter.action = "cancel";
    waiter.done = true;
    waiter.wake(true);
    pending.delete(key);
  }
  if (state === null) diagnostics.length = 0;
}

export function elicitationTopic(stateDir: string | null, sessionId: string): string {
  return `mcp-elicitation:${createHash("sha256").update(`${stateKey(stateDir)}\0${sessionId}`).digest("hex").slice(0, 32)}`;
}
