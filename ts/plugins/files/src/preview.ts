/**
 * Workspace listing and safe previews (`bundled_plugins/files/preview.py`).
 *
 * Office bytes are not parsed here. `.docx` / `.xlsx` / `.pptx` call
 * `officePreview(data, suffix)` when the host injects one (the office
 * plugin's `previewBytes`). A missing callback or a throw becomes
 * `ValueError("invalid or oversized Office document")`, which the HTTP
 * layer reports as `cannot preview file`.
 */
import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { pyDecodeUtf8, pyLen, pySlice, pyStrip, PyValueError } from "@xueness/contracts";
import { isFile, realish } from "@xueness/sessions";
import { compareCodePoints, isWithin } from "./directory-level.ts";

export const MAX_TREE_FILES = 200;
export const MAX_FILE_PREVIEW = 32000;

const RESERVED = new Set(["CON", "PRN", "AUX", "NUL", ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((n) => [`COM${n}`, `LPT${n}`])]);

/** `windows_paths.windows_path_alias`: a Win32 name that is not the path it spells. */
export function windowsPathAlias(name: unknown): string | null {
  if (process.platform !== "win32" || typeof name !== "string") return null;
  let rest = name;
  const drive = /^[A-Za-z]:/u.exec(name);
  if (drive) {
    if (!(name[2] === "\\" || name[2] === "/")) return drive[0];
    rest = name.slice(2);
  }
  for (const part of rest.replaceAll("\\", "/").split("/")) {
    if (part === "" || part === "." || part === "..") continue;
    if (part.includes(":") || part.endsWith(" ") || part.endsWith(".")) return part;
    if (RESERVED.has((part.split(".", 1)[0] ?? part).toUpperCase())) return part;
  }
  return null;
}

/** `PermissionError("path outside workspace")` from `builtin_tools.path_in`. */
export class WorkspacePermissionError extends Error {
  constructor(message = "path outside workspace") {
    super(message);
    this.name = "PermissionError";
  }
}

/** `path_in`: resolve `name` under `root` and refuse anything outside it. */
export function pathIn(root: string, name: string): string {
  if (windowsPathAlias(name)) throw new WorkspacePermissionError();
  const base = realish(root);
  const target = realish(resolve(root, name));
  if (!isWithin(target, base)) throw new WorkspacePermissionError();
  return target;
}

export interface WorkspaceFile { path: string; size: number }
export interface WorkspaceListing { files: WorkspaceFile[]; truncated: boolean; count: number }

/**
 * Breadth-first, name-sorted within each directory. Symlink directories are
 * not descended; a symlink to a file yields the resolved target, as Python's
 * `_walk_files` does. Reparse points that Node reports as symlinks are included.
 */
function* walkFiles(root: string): Generator<string> {
  const queue = [root];
  while (queue.length) {
    const current = queue.shift()!;
    let names: string[];
    try { names = readdirSync(current); } catch { continue; }
    names.sort(compareCodePoints);
    for (const name of names) {
      const entry = joinEntry(current, name);
      try {
        const info = lstatSync(entry);
        if (info.isSymbolicLink()) {
          const resolved = realish(entry);
          if (!isWithin(resolved, root)) continue;
          const target = statSync(resolved);
          if (target.isDirectory()) continue;
          if (target.isFile()) yield resolved;
          continue;
        }
        if (info.isDirectory()) queue.push(entry);
        else if (info.isFile()) yield realish(entry);
      } catch { /* a broken or racing entry is skipped */ }
    }
  }
}

function joinEntry(dir: string, name: string): string {
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

function relativePosix(root: string, target: string): string {
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new PyValueError("path outside workspace");
  return rel.split(sep).join("/");
}

/** `workspace_files`: read-only index, capped in walk order and then sorted. */
export function workspaceFiles(root: string, maxTreeFiles = MAX_TREE_FILES): WorkspaceListing {
  const base = realish(root);
  const files: WorkspaceFile[] = [];
  let truncated = false;
  for (const resolved of walkFiles(base)) {
    let size: number;
    try { size = statSync(resolved).size; } catch { continue; }
    files.push({ path: relativePosix(base, resolved), size });
    if (files.length >= maxTreeFiles) { truncated = true; break; }
  }
  files.sort((a, b) => compareCodePoints(a.path, b.path));
  return { files, truncated, count: files.length };
}

export interface TextPreview { path: string; size: number; truncated: boolean; text: string }

/** `workspace_preview`: a small UTF-8 text file. No writes. */
export function workspacePreview(root: string, relative: string, maxFilePreview = MAX_FILE_PREVIEW): TextPreview {
  if (typeof relative !== "string" || pyStrip(relative) === "" || pyLen(relative) > 1024) {
    throw new PyValueError("path must be a relative workspace path");
  }
  const stripped = pyStrip(relative);
  const target = pathIn(root, stripped);
  if (!isFile(target)) throw new PyValueError("not a file");
  const size = statSync(target).size;
  if (size > 1_000_000) throw new PyValueError("file too large");
  const raw = readFileSync(target).subarray(0, maxFilePreview + 1);
  if (raw.subarray(0, 4096).includes(0)) throw new PyValueError("binary file");
  return { path: stripped, size, truncated: size > maxFilePreview, text: pySlice(pyDecodeUtf8(raw), maxFilePreview) };
}

export interface BinarySpec { mime: string; cap: number }

/** Suffix -> (mime, byte cap). Legacy Office suffixes are refused before this table. */
export const BINARY_PREVIEW_SUFFIXES: Readonly<Record<string, BinarySpec>> = {
  ".docx": { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", cap: 8_000_000 },
  ".xlsx": { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", cap: 8_000_000 },
  ".pptx": { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", cap: 8_000_000 },
  ".png": { mime: "image/png", cap: 2_000_000 },
  ".jpg": { mime: "image/jpeg", cap: 2_000_000 },
  ".jpeg": { mime: "image/jpeg", cap: 2_000_000 },
  ".gif": { mime: "image/gif", cap: 2_000_000 },
  ".webp": { mime: "image/webp", cap: 2_000_000 },
  ".pdf": { mime: "application/pdf", cap: 4_000_000 },
  ".mp3": { mime: "audio/mpeg", cap: 8_000_000 },
  ".wav": { mime: "audio/wav", cap: 8_000_000 },
  ".ogg": { mime: "audio/ogg", cap: 8_000_000 },
  ".mp4": { mime: "video/mp4", cap: 8_000_000 },
  ".webm": { mime: "video/webm", cap: 8_000_000 },
};

const OFFICE = new Set([".docx", ".xlsx", ".pptx"]);
const LEGACY = new Set([".doc", ".xls", ".ppt", ".docm", ".xlsm", ".pptm"]);
const LEGACY_MESSAGE = "Legacy or macro-enabled Office formats are not supported; save a non-macro DOCX, XLSX, or PPTX copy.";

export type OfficePreview = (data: Buffer, suffix: string) => Record<string, unknown>;

/** `workspace_binary_preview`. `officePreview` stands in for `office_preview.preview`. */
export function workspaceBinaryPreview(root: string, relative: string, officePreview?: OfficePreview): Record<string, unknown> {
  if (typeof relative !== "string" || pyStrip(relative) === "" || pyLen(relative) > 1024) {
    throw new PyValueError("path must be a relative workspace path");
  }
  const stripped = pyStrip(relative);
  const suffix = extname(stripped).toLowerCase();
  if (LEGACY.has(suffix)) throw new PyValueError(LEGACY_MESSAGE);
  const spec = BINARY_PREVIEW_SUFFIXES[suffix];
  if (!spec) throw new PyValueError("not a previewable file");
  const target = pathIn(root, stripped);
  if (!isFile(target)) throw new PyValueError("not a file");
  const size = statSync(target).size;
  if (size > spec.cap) throw new PyValueError("file too large");
  if (OFFICE.has(suffix)) {
    if (!officePreview) throw new PyValueError("invalid or oversized Office document");
    let office: Record<string, unknown>;
    try { office = officePreview(readFileSync(target), suffix); } catch { throw new PyValueError("invalid or oversized Office document"); }
    return { path: stripped, size, truncated: office.truncated, office };
  }
  const dataUrl = `data:${spec.mime};base64,${readFileSync(target).toString("base64")}`;
  if (spec.mime.startsWith("image/")) return { path: stripped, size, truncated: false, image: dataUrl };
  return { path: stripped, size, truncated: false, embed: { mime: spec.mime, dataUrl } };
}

/** `workspace_image_preview`: every whitelisted binary kind, not images only. */
export function workspaceImagePreview(root: string, relative: string, officePreview?: OfficePreview): Record<string, unknown> {
  return workspaceBinaryPreview(root, relative, officePreview);
}

/** Suffix Python uses to choose the binary branch (`Path.suffix.lower()`). */
export function previewSuffix(relative: string): string {
  const stripped = typeof relative === "string" ? pyStrip(relative) : "";
  return stripped ? extname(stripped).toLowerCase() : "";
}
