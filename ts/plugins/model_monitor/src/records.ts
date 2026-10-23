/** Passive model observations. Never sends a request or stores conversation text. */
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { pyEncodeUtf8, pyJsonDumps, pyJsonLoads, uuid4Hex } from "@xueness/contracts";
import { exists, fsyncDirectory, isLink, mkstemp, protectPrivateDirectory, protectPrivateFile, replaceFile, writeAll } from "@xueness/sessions";

export const MAX_RECORDS = 200;
const MAX_BYTES = 400_000;
const SESSION = /^[0-9a-f]{32}$/;

export interface Observation {
  id: string;
  at: string;
  providerId: string;
  requestedModel: string;
  returnedModels: string[];
  protocol: string;
  outcome: "success" | "error";
  sessionId?: string;
}

function refuse(message: string): never {
  const error = new Error(message);
  error.name = "ValueError";
  throw error;
}

function atomicJson(path: string, value: unknown): void {
  const parent = join(path, "..");
  mkdirSync(parent, { recursive: true });
  const temp = mkstemp(parent, ".resource-");
  try {
    try {
      protectPrivateFile(temp.fd);
      writeAll(temp.fd, pyEncodeUtf8(pyJsonDumps(value, { ensureAscii: false, indent: 2 })));
      fsyncSync(temp.fd);
    } finally { closeSync(temp.fd); }
    replaceFile(temp.path, path);
  } finally { if (exists(temp.path)) unlinkSync(temp.path); }
  try { fsyncDirectory(parent); } catch { /* directory fsync is best-effort */ }
}

export function observationsPath(stateDir: string, create = false): string {
  const root = join(stateDir);
  const target = join(root, "model-monitor");
  const file = join(target, "observations.json");
  for (const part of [root, target, file]) if (isLink(part)) refuse("model monitor path must not be a link");
  if (create) {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    protectPrivateDirectory(target);
  }
  return file;
}

function modelName(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && [...value].every((char) => char.charCodeAt(0) >= 32) ? value : null;
}

export function cleanObservation(row: Record<string, unknown>): Observation {
  const models = Array.isArray(row.returnedModels) ? row.returnedModels : [];
  const sessionId = typeof row.sessionId === "string" && SESSION.test(row.sessionId) ? row.sessionId : undefined;
  const seen = new Set<string>();
  const returned: string[] = [];
  for (const item of models.slice(0, 8)) {
    const name = modelName(item);
    if (name && !seen.has(name)) { seen.add(name); returned.push(name); }
  }
  const outcome = row.outcome === "success" || row.outcome === "error" ? row.outcome : "success";
  return {
    ...(sessionId ? { sessionId } : {}),
    id: String(row.id ?? "").slice(0, 64),
    at: String(row.at ?? "").slice(0, 40),
    providerId: String(row.providerId ?? "").slice(0, 64),
    requestedModel: modelName(row.requestedModel) ?? "",
    returnedModels: returned,
    protocol: String(row.protocol ?? "").slice(0, 32),
    outcome,
  };
}

export function readObservations(stateDir: string, sessionId?: string | null): Observation[] {
  const path = observationsPath(stateDir);
  let original;
  try { original = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  if (!original.isFile()) refuse("invalid monitoring document");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    const current = lstatSync(path);
    if (!current.isFile() || current.dev !== original.dev || current.ino !== original.ino) refuse("monitoring document changed during read");
    while (size <= MAX_BYTES) {
      const block = Buffer.allocUnsafe(Math.min(65536, MAX_BYTES + 1 - size));
      const count = readSync(fd, block, 0, block.length, null);
      if (count === 0) break;
      chunks.push(block.subarray(0, count));
      size += count;
    }
  } finally { closeSync(fd); }
  if (size > MAX_BYTES) refuse("monitoring document too large");
  const value = pyJsonLoads(Buffer.concat(chunks).toString("utf8"));
  if (!Array.isArray(value)) refuse("invalid monitoring document");
  const rows = value.slice(-MAX_RECORDS).filter((row): row is Record<string, unknown> => row !== null && typeof row === "object" && !Array.isArray(row)).map(cleanObservation);
  return sessionId == null ? rows : rows.filter((row) => row.sessionId === sessionId);
}

export function clearObservations(stateDir: string): void {
  atomicJson(observationsPath(stateDir, true), []);
}

function stamp(): string {
  const date = new Date();
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}000+00:00`;
}

/** Append one observation. Failures are swallowed: a monitor must not drop the model reply. */
export function recordObservation(stateDir: string, input: { providerId?: unknown; requestedModel?: unknown; returnedModels?: unknown; protocol?: unknown; outcome?: unknown; sessionId?: unknown }, enabled: boolean): void {
  if (!enabled) return;
  const row = cleanObservation({
    id: uuid4Hex(), at: stamp(), providerId: input.providerId ?? "", sessionId: input.sessionId,
    requestedModel: input.requestedModel ?? "", returnedModels: input.returnedModels ?? [],
    protocol: input.protocol ?? "openai", outcome: input.outcome ?? "success",
  });
  try {
    const rows = readObservations(stateDir);
    rows.push(row);
    atomicJson(observationsPath(stateDir, true), rows.slice(-MAX_RECORDS));
  } catch { /* same as Python: monitoring failure is not a reply failure */ }
}
