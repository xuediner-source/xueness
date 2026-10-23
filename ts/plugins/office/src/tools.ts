/**
 * office_read / office_create / office_replace with Python's names, schemas,
 * gates, path rules, write lock, atomic install and per-session read proofs
 * (`_office_read_proofs` on the session, at most 20, cleared by truncation).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { pyJsonDumps, pyLen } from "@xueness/contracts";
import type { ToolDefinition, ToolResult } from "@xueness/engine-tools";
import { FORMATS, type OfficeFormat } from "./document.ts";
import { buildDocument, MAX_FILE_BYTES, readDocument } from "./read.ts";
import { MODEL_SCHEMAS } from "./schemas.ts";

type Row = Record<string, unknown>;
export interface OfficeToolsOptions { session: () => Row | null }
const MAX_READ_PROOFS = 20, SHA256 = /^[0-9a-f]{64}$/;
const valueError = (message: string): Error => Object.assign(new Error(message), { code: "invalid_argument" });
const permissionError = (message: string): Error => Object.assign(new Error(message), { code: "permission_denied" });
const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");
const same = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** `_target`: a workspace-relative path that never crosses a symlink. */
export function officeTarget(root: string, path: unknown, mustExist: boolean): string {
  if (typeof path !== "string" || !path || pyLen(path) > 2000 || path.includes("\0") || path.includes("\\")) throw valueError("path must be a workspace-relative path");
  if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.startsWith("/") || path.split("/").some((part) => part === "" || part === "." || part === "..")) throw valueError("path must be a workspace-relative path without traversal");
  let workspace: string;
  try { workspace = realpathSync(root); if (!statSync(workspace).isDirectory()) throw new Error(); } catch { throw valueError("workspace is unavailable"); }
  const parts = path.split("/");
  let current = workspace;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const info = lstatOrNull(current);
    if (info?.isSymbolicLink()) throw permissionError("office paths must not cross symlinks or reparse points");
    if (!info) throw valueError("parent directory must already exist");
    if (!info.isDirectory()) throw valueError("parent path is not a directory");
  }
  const target = join(current, parts[parts.length - 1]!), info = lstatOrNull(target);
  if (info?.isSymbolicLink()) throw permissionError("office files must not be symlinks or reparse points");
  if (info && !info.isFile()) throw valueError("office path must be a regular file");
  if (mustExist && !info) throw valueError("office file not found");
  const rel = relative(workspace, target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw permissionError("path outside workspace");
  return target;
}

export function readOfficeBytes(target: string): Buffer {
  const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw valueError("office path must be a regular file");
    if (info.size > MAX_FILE_BYTES) throw valueError("office file exceeds the 8 MB read limit");
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    for (let n = 1; n > 0 && length < buffer.length;) { n = readSync(fd, buffer, length, buffer.length - length, null); length += n; }
    if (length > MAX_FILE_BYTES) throw valueError("office file exceeds the 8 MB read limit");
    return Buffer.from(buffer.subarray(0, length));
  } finally { closeSync(fd); }
}

const locks = new Map<string, string>();
function acquire(target: string, owner: string): boolean { const held = locks.get(target); if (held !== undefined && held !== owner) return false; locks.set(target, owner); return true; }

function writeAtomic(target: string, data: Buffer, createOnly: boolean, root: string, path: string, expected?: string): void {
  const parent = dirname(target), info = lstatOrNull(parent);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) throw permissionError("office parent directory must be a real workspace directory");
  let temporary = "", fd = -1;
  for (let attempt = 0; fd < 0; attempt += 1) {
    temporary = join(parent, `.xueness-office-${randomBytes(6).toString("base64url")}.tmp`);
    try { fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 100) throw error; }
  }
  try {
    try { for (let at = 0; at < data.length;) at += writeSync(fd, data, at); fsyncSync(fd); } finally { closeSync(fd); }
    officeTarget(root, path, !createOnly);
    if (createOnly) { linkSync(temporary, target); unlinkSync(temporary); }
    else {
      officeTarget(root, path, true);
      if (expected && !same(sha256(readOfficeBytes(target)), expected)) throw valueError("office file changed after office_read; read it again before replacing");
      renameSync(temporary, target);
    }
    try { const dir = openSync(parent, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0)); try { fsyncSync(dir); } finally { closeSync(dir); } } catch { /* best effort */ }
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

function formatFor(path: string, format: unknown): OfficeFormat {
  if (typeof format !== "string" || !(FORMATS as readonly string[]).includes(format)) throw valueError("format must be docx, pptx, xlsx or pdf");
  const name = path.split("/").pop() ?? "", dot = name.lastIndexOf(".");
  const suffix = dot > 0 && dot < name.length - 1 ? name.slice(dot).toLowerCase() : "";
  if (suffix !== `.${format}`) throw valueError("format must match the file extension");
  return format as OfficeFormat;
}

function suffixFormat(path: string): string {
  const name = path.split("/").pop() ?? "", dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
}

function proofsOf(session: Row | null, create: boolean): Row | null {
  if (!session || typeof session !== "object") return null;
  let proofs = session._office_read_proofs;
  if (!proofs || typeof proofs !== "object" || Array.isArray(proofs)) { if (!create) return null; proofs = {}; session._office_read_proofs = proofs; }
  return proofs as Row;
}

const done = (result: Row): ToolResult => ({ ok: true, output: pyJsonDumps(result), data: result });
const busy = (): ToolResult => { const result = { ok: false, conflict: true, error: "path busy" }; return { ok: false, output: pyJsonDumps(result), data: result, error: { code: "conflict", message: "path busy" } }; };
const exists = (target: string): boolean => lstatOrNull(target) !== null;

type Input = Record<string, unknown>;
const base = { inputSchema: { type: "object" } as const, subject: (input: Input): string => typeof input.path === "string" ? input.path : "", subjectKind: "path" as const };

export function officeTools(options: OfficeToolsOptions): ToolDefinition<Input>[] {
  const read: ToolDefinition<Input> = {
    ...base, name: "office_read", description: "Read bounded structured text from a DOCX, PPTX, XLSX or PDF in the workspace",
    modelSchema: MODEL_SCHEMAS.office_read, gate: "read", mutating: false, concurrencySafe: true, requires: { fs: { read: ["workspace"] } },
    async run(input, env) {
      const path = input.path;
      if (typeof path !== "string") throw valueError("path must be a string");
      const target = officeTarget(env.cwd, path, true), format = suffixFormat(target);
      if (!(FORMATS as readonly string[]).includes(format)) throw valueError("supported formats are DOCX, PPTX, XLSX and PDF");
      const data = readOfficeBytes(target), digest = sha256(data);
      const { document, truncated } = readDocument(data, format as OfficeFormat);
      const session = options.session();
      if (truncated) { const proofs = proofsOf(session, false); if (proofs) delete proofs[path]; }
      else {
        const proofs = proofsOf(session, true);
        if (proofs) { proofs[path] = { format, sha256: digest }; const keys = Object.keys(proofs); for (const key of keys.slice(0, Math.max(0, keys.length - MAX_READ_PROOFS))) delete proofs[key]; }
      }
      return done({ ok: true, path, format, sha256: digest, document, truncated });
    },
  };
  const create: ToolDefinition<Input> = {
    ...base, name: "office_create", description: "Create a structured DOCX, PPTX, XLSX or PDF in the workspace (approval required)",
    modelSchema: MODEL_SCHEMAS.office_create, gate: "write", mutating: true, concurrencySafe: false, requires: { fs: { write: ["workspace"] } },
    async run(input, env) {
      const path = input.path;
      if (typeof path !== "string") throw valueError("path must be a string");
      const format = formatFor(path, input.format), target = officeTarget(env.cwd, path, false);
      if (exists(target)) throw valueError("office_create only creates a new file; use office_read then office_replace");
      const data = buildDocument(format, input.document), owner = ownerOf(env.owner, options.session());
      if (!acquire(target, owner)) return busy();
      try {
        if (exists(target)) throw valueError("target appeared before document creation");
        writeAtomic(target, data, true, env.cwd, path);
      } finally { if (locks.get(target) === owner) locks.delete(target); }
      return done({ ok: true, path, format, bytes: data.length, sha256: sha256(data) });
    },
  };
  const replace: ToolDefinition<Input> = {
    ...base, name: "office_replace", description: "Replace a structured Office document after reading the same path and supplying its sha256 (approval required)",
    modelSchema: MODEL_SCHEMAS.office_replace, gate: "edit", mutating: true, concurrencySafe: false, requires: { fs: { write: ["workspace"] } },
    async run(input, env) {
      const path = input.path;
      if (typeof path !== "string") throw valueError("path must be a string");
      const format = formatFor(path, input.format), expected = input.expected_sha256;
      if (typeof expected !== "string" || !SHA256.test(expected)) throw valueError("expected_sha256 from office_read is required");
      const target = officeTarget(env.cwd, path, true), session = options.session(), proofs = proofsOf(session, false);
      const proof = proofs?.[path] as Row | undefined;
      if (!proof || typeof proof !== "object" || proof.format !== format || typeof proof.sha256 !== "string" || !same(expected, proof.sha256)) throw permissionError("read this exact path in the current session before replacing it");
      if (!same(sha256(readOfficeBytes(target)), expected)) throw valueError("office file changed after office_read; read it again before replacing");
      const data = buildDocument(format, input.document), owner = ownerOf(env.owner, session);
      if (!acquire(target, owner)) return busy();
      try {
        officeTarget(env.cwd, path, true);
        if (!same(sha256(readOfficeBytes(target)), expected)) throw valueError("office file changed after office_read; read it again before replacing");
        writeAtomic(target, data, false, env.cwd, path, expected);
      } finally { if (locks.get(target) === owner) locks.delete(target); }
      if (proofs) delete proofs[path];
      return done({ ok: true, path, format, bytes: data.length, sha256: sha256(data) });
    },
  };
  return [read, create, replace];
}

function ownerOf(owner: string | undefined, session: Row | null): string {
  if (owner) return owner;
  const id = session?.id;
  return typeof id === "string" && id ? id : "default";
}
