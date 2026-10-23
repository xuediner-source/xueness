/**
 * apply_patch: apply a multi-file structured patch after every hunk verifies.
 *
 * Ported from ZCode v3.15.1 `apps/zcode-cli/packages/core/src/tool/handlers/apply-patch.ts`
 * and `packages/contracts/src/tools/apply-patch.ts`
 * (commit aac4755666d09fdcd70272fcf063c077a639015f).
 * Nothing is written until every section verifies. The model-facing text matches
 * ZCode `formatApplyPatchModelContent`. ZCode does not require a prior Read;
 * a successful write records the new bytes on the read tracker.
 */
import { readFile, unlink } from "node:fs/promises";
import { writeFileAtomic } from "./atomic-write.ts";
import { unifiedDiff } from "./diff.ts";
import { detectLineEnding, toLf, withLineEnding, type LineEnding } from "./line-endings.ts";
import { derivePatchedContent } from "./patch-apply.ts";
import { parseStructuredPatch, type ParsedPatch } from "./patch-parser.ts";
import { resolveWorkspacePath } from "./paths.ts";
import { decodeText, detectEncoding, encodeText, type TextEncodingName } from "./text-codec.ts";
import { failure, statOrNull, WRITES_WORKSPACE, type ToolDefinition, type ToolEnv, type ToolResult } from "./tool.ts";

/** Provider-facing description: ZCode metadata description plus model instructions. */
export const APPLY_PATCH_DESCRIPTION = [
  "Apply structured file patches with verification before writing.",
  "",
  "Usage:",
  "- Use ApplyPatch for structured, reviewable edits that are easier to express as local diff hunks than exact old_string replacements.",
  "- The patch must start with `*** Begin Patch` and end with `*** End Patch`.",
  "- Use `*** Update File: <path>` with `@@` hunks for existing files. Prefix context lines with a space, removed lines with `-`, and added lines with `+`.",
  "- Use `*** Add File: <path>` for new files and prefix every content line with `+`.",
  "- Use `*** Delete File: <path>` only when deleting the file is intentional.",
  "- Patch hunks are logical Unicode text, just like Read output. Updates preserve each existing file's detected original text encoding and line endings when possible, including GB2312, GBK, and GB18030.",
  "- If verification fails, re-read the relevant range and provide more exact context; do not switch to Python or shell replacement scripts.",
].join("\n");

/** ZCode `ApplyPatchErrorCode`. The handler emits every code except `IO_ERROR`, which ZCode also leaves unused. */
export const ApplyPatchErrorCode = {
  INVALID_PATCH: "apply_patch_invalid_patch",
  EMPTY_PATCH: "apply_patch_empty_patch",
  FILE_NOT_EXIST: "apply_patch_file_not_exist",
  FILE_EXISTS: "apply_patch_file_exists",
  HUNK_NOT_FOUND: "apply_patch_hunk_not_found",
  IO_ERROR: "apply_patch_io_error",
} as const;

export interface ApplyPatchInput {
  patch_text: string;
}

export interface ApplyPatchFileChange {
  /** Absolute path named in the patch (the created path for an add). */
  filePath: string;
  /** Workspace-relative path with forward slashes. */
  path: string;
  type: "add" | "update" | "delete" | "move";
  /** Absolute destination. Set only when `type` is `move`. */
  movePath?: string;
  /** Workspace-relative destination. Set only when `type` is `move`. */
  moveDisplay?: string;
  diff: string;
  added: number;
  removed: number;
  encoding: TextEncodingName;
  lineEnding: "LF" | "CRLF";
}

export interface ApplyPatchData {
  files: ApplyPatchFileChange[];
  summary: string;
}

const APPLY_PATCH_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["patch_text"],
  properties: {
    patch_text: { type: "string", description: "The full structured patch text to apply" },
  },
} as const;

class PatchRejected extends Error {
  override name = "PatchRejected";
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface ExistingText {
  absolute: string;
  display: string;
  raw: string;
  lf: string;
  encoding: TextEncodingName;
  lineEnding: LineEnding;
  revision: { mtimeMs: number; size: number };
}

interface PlannedWrite {
  type: "add" | "update" | "move";
  absolute: string;
  display: string;
  moveAbsolute?: string;
  moveDisplay?: string;
  oldLf: string;
  newLf: string;
  encoding: TextEncodingName;
  lineEnding: LineEnding;
  bytes: Uint8Array;
  revision?: { mtimeMs: number; size: number };
}

interface PlannedDelete {
  type: "delete";
  absolute: string;
  display: string;
  oldLf: string;
  newLf: "";
  encoding: TextEncodingName;
  lineEnding: LineEnding;
}

type PlannedChange = PlannedWrite | PlannedDelete;

function patchPaths(patchText: string): string[] {
  return parseStructuredPatch(patchText).flatMap((section) =>
    section.type === "update" && section.movePath ? [section.path, section.movePath] : [section.path],
  );
}

/**
 * Every path the patch names, in header order (update: source, then `Move to`).
 * The bridge resolves and authorizes each one, so a deny or ask rule on any
 * touched file applies. An unparseable patch fails here with the parser text.
 */
function applyPatchSubjectPaths(input: ApplyPatchInput): string[] {
  try {
    const paths = patchPaths(input.patch_text);
    if (paths.length) return paths;
  } catch (error) {
    throw new PatchRejected(ApplyPatchErrorCode.INVALID_PATCH, error instanceof Error ? error.message : String(error));
  }
  throw new PatchRejected(ApplyPatchErrorCode.EMPTY_PATCH, "patch rejected: empty patch");
}

/** Xueness hardening: two sections on one file would verify against stale text and could half-apply. */
function duplicateTarget(planned: readonly PlannedChange[]): string | null {
  const seen = new Set<string>();
  for (const change of planned) {
    const targets = change.type === "move" && change.moveAbsolute && change.moveAbsolute !== change.absolute ? [change.absolute, change.moveAbsolute] : [change.absolute];
    for (const target of targets) {
      if (seen.has(target)) return target;
      seen.add(target);
    }
  }
  return null;
}

async function runApplyPatch(input: ApplyPatchInput, env: ToolEnv): Promise<ToolResult<ApplyPatchData>> {
  let sections: ParsedPatch[];
  try {
    sections = parseStructuredPatch(input.patch_text);
  } catch (error) {
    return failure(ApplyPatchErrorCode.INVALID_PATCH, error instanceof Error ? error.message : String(error));
  }
  if (sections.length === 0) return failure(ApplyPatchErrorCode.EMPTY_PATCH, "patch rejected: empty patch");

  let planned: PlannedChange[];
  try {
    planned = [];
    for (const section of sections) planned.push(await verifySection(section, env));
  } catch (error) {
    if (error instanceof PatchRejected) return failure(error.code, error.message);
    throw error;
  }
  const duplicate = duplicateTarget(planned);
  if (duplicate) return failure(ApplyPatchErrorCode.INVALID_PATCH, `patch rejected: more than one section touches ${duplicate}`);

  try {
    for (const change of planned) await commitChange(change, env);
  } catch (error) {
    if (error instanceof PatchRejected) return failure(error.code, error.message);
    throw error;
  }

  const files = planned.map(toFileChange);
  const summary = planned.map(summaryLine).join("\n");
  return { ok: true, output: `Patch applied successfully.\n${summary}`, data: { files, summary } };
}

export function createApplyPatchTool(): ToolDefinition<ApplyPatchInput, ApplyPatchData> {
  return {
    name: "apply_patch",
    gate: "edit",
    mutating: true,
    concurrencySafe: false,
    requires: WRITES_WORKSPACE,
    description: APPLY_PATCH_DESCRIPTION,
    inputSchema: APPLY_PATCH_INPUT_SCHEMA,
    subjectPaths: applyPatchSubjectPaths,
    run: runApplyPatch,
  };
}

export const applyPatchTool = createApplyPatchTool();

async function verifySection(section: ParsedPatch, env: ToolEnv): Promise<PlannedChange> {
  switch (section.type) {
    case "add":
      return verifyAdd(section, env);
    case "delete":
      return verifyDelete(section, env);
    case "update":
      return verifyUpdate(section, env);
  }
}

async function verifyAdd(section: Extract<ParsedPatch, { type: "add" }>, env: ToolEnv): Promise<PlannedWrite> {
  const target = await resolveWorkspacePath(section.path, env.cwd, env.roots);
  const info = await statOrNull(target.absolute);
  if (info) throw new PatchRejected(ApplyPatchErrorCode.FILE_EXISTS, `File already exists: ${target.absolute}`);
  const lineEnding = detectLineEnding(section.contents);
  return {
    type: "add",
    absolute: target.absolute,
    display: target.display,
    oldLf: "",
    newLf: section.contents,
    encoding: "utf-8",
    lineEnding,
    bytes: encodeText(withLineEnding(section.contents, lineEnding), "utf-8"),
  };
}

async function verifyDelete(section: Extract<ParsedPatch, { type: "delete" }>, env: ToolEnv): Promise<PlannedDelete> {
  const existing = await readExisting(section.path, env);
  return {
    type: "delete",
    absolute: existing.absolute,
    display: existing.display,
    oldLf: existing.lf,
    newLf: "",
    encoding: existing.encoding,
    lineEnding: existing.lineEnding,
  };
}

async function verifyUpdate(section: Extract<ParsedPatch, { type: "update" }>, env: ToolEnv): Promise<PlannedWrite> {
  if (section.chunks.length === 0) {
    throw new PatchRejected(ApplyPatchErrorCode.INVALID_PATCH, "Update file section has no hunks");
  }
  const existing = await readExisting(section.path, env);
  let patched: string;
  try {
    patched = derivePatchedContent(existing.raw, section.chunks).content;
  } catch (error) {
    throw new PatchRejected(
      ApplyPatchErrorCode.HUNK_NOT_FOUND,
      error instanceof Error ? error.message : String(error),
    );
  }
  const move = section.movePath ? await resolveWorkspacePath(section.movePath, env.cwd, env.roots) : undefined;
  // Xueness hardening: a move never overwrites another file.
  if (move && move.absolute !== existing.absolute && (await statOrNull(move.absolute))) {
    throw new PatchRejected(ApplyPatchErrorCode.FILE_EXISTS, `File already exists: ${move.absolute}`);
  }
  const bytes = encodeText(withLineEnding(patched, existing.lineEnding), existing.encoding);
  return {
    type: move ? "move" : "update",
    absolute: existing.absolute,
    display: existing.display,
    ...(move ? { moveAbsolute: move.absolute, moveDisplay: move.display } : {}),
    oldLf: existing.lf,
    newLf: patched,
    encoding: existing.encoding,
    lineEnding: existing.lineEnding,
    bytes,
    revision: existing.revision,
  };
}

async function readExisting(inputPath: string, env: ToolEnv): Promise<ExistingText> {
  const target = await resolveWorkspacePath(inputPath, env.cwd, env.roots);
  const info = await statOrNull(target.absolute);
  if (!info) throw new PatchRejected(ApplyPatchErrorCode.FILE_NOT_EXIST, `File not found: ${target.absolute}`);
  if (info.isDirectory()) {
    throw new PatchRejected("is_directory", `Cannot read directory as text file: ${target.absolute}`);
  }
  if (!info.isFile()) {
    throw new PatchRejected("not_file", `Cannot read non-file path as text: ${target.absolute}`);
  }
  let bytes: Uint8Array;
  try {
    bytes = await readFile(target.absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PatchRejected(ApplyPatchErrorCode.FILE_NOT_EXIST, `File not found: ${target.absolute}`);
    }
    throw error;
  }
  const encoding = detectEncoding(bytes);
  const raw = decodeText(bytes, encoding).text;
  return {
    absolute: target.absolute,
    display: target.display,
    raw,
    lf: toLf(raw),
    encoding,
    lineEnding: detectLineEnding(raw),
    revision: { mtimeMs: info.mtimeMs, size: info.size },
  };
}

async function commitChange(change: PlannedChange, env: ToolEnv): Promise<void> {
  if (change.type === "delete") {
    await unlink(change.absolute);
    env.tracker.forget(change.absolute);
    return;
  }
  if (change.type === "update" && change.revision) await assertSameRevision(change.absolute, change.revision);
  const destination = change.moveAbsolute ?? change.absolute;
  const written = await writeFileAtomic(destination, change.bytes);
  const after = await statOrNull(written);
  if (after) env.tracker.record(written, after, change.bytes);
  if (change.type === "move" && change.moveAbsolute !== change.absolute) {
    await unlink(change.absolute);
    env.tracker.forget(change.absolute);
  }
}

/** ZCode update writes pass `expectedRevision` (`mtime` + size). Moves and adds do not. */
async function assertSameRevision(absolute: string, revision: { mtimeMs: number; size: number }): Promise<void> {
  const info = await statOrNull(absolute);
  if (!info || Math.trunc(info.mtimeMs) !== Math.trunc(revision.mtimeMs) || info.size !== revision.size) {
    throw new PatchRejected("stale_write", `File changed since it was read: ${absolute}`);
  }
}

function summaryLine(change: PlannedChange): string {
  const marker = change.type === "add" ? "A" : change.type === "delete" ? "D" : "M";
  const path = change.type === "delete" ? change.absolute : change.moveAbsolute ?? change.absolute;
  return `${marker} ${path}`;
}

function toFileChange(change: PlannedChange): ApplyPatchFileChange {
  const label = change.type === "delete" ? change.display : change.moveDisplay ?? change.display;
  const diff = unifiedDiff(change.oldLf, change.newLf, label);
  const file: ApplyPatchFileChange = {
    filePath: change.absolute,
    path: change.display,
    type: change.type,
    diff: diff.unified,
    added: diff.added,
    removed: diff.removed,
    encoding: change.encoding,
    lineEnding: change.lineEnding === "\r\n" ? "CRLF" : "LF",
  };
  if (change.type === "move" && change.moveAbsolute && change.moveDisplay) {
    file.movePath = change.moveAbsolute;
    file.moveDisplay = change.moveDisplay;
  }
  return file;
}
