/**
 * edit: replace text in a file the agent has read.
 *
 * The match runs on LF text; the splice is applied to the raw text through an
 * offset map, so line endings, BOM and encoding outside the replaced region
 * stay byte-for-byte identical. The new text uses the file's line ending.
 */
import { readFile } from "node:fs/promises";
import { unifiedDiff } from "./diff.ts";
import { locateEdit } from "./edit-locate.ts";
import type { EditMatchStrategy } from "./edit-matchers.ts";
import { LfOffsetMap, detectLineEnding, toLf, withLineEnding } from "./line-endings.ts";
import { resolveWorkspacePath } from "./paths.ts";
import { decodeText, detectEncoding } from "./text-codec.ts";
import { createPersistedFileReadState } from "./file-state.ts";
import { NodeWorkspaceFileSystem, snapshotFromRevision } from "./filesystem.ts";
import { failure, statOrNull, WRITES_WORKSPACE, type ToolDefinition, type ToolEnv, type ToolResult } from "./tool.ts";
import { WRITE_STORAGE_SUFFIX } from "./write.ts";
import { missingFileMessage } from "./zcode-text.ts";

export interface EditInput {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface EditData {
  path: string;
  replacements: number;
  strategy: EditMatchStrategy;
  encoding: string;
  added: number;
  removed: number;
  diff: string;
}

export const editTool: ToolDefinition<EditInput, EditData> = {
  name: "edit",
  gate: "edit",
  mutating: true,
  concurrencySafe: false,
  requires: WRITES_WORKSPACE,
  description: [
    "Replace `old_string` with `new_string` in a file. Read the file first; the edit is refused if it changed since.",
    "`old_string` must match exactly one place unless `replace_all` is true; include surrounding lines to make it unique.",
    "Line endings and the file's encoding are preserved; the unified diff is in the result data.",
  ].join(" "),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "old_string", "new_string"],
    properties: {
      path: { type: "string", minLength: 1 },
      old_string: { type: "string", description: "Exact text to replace; empty creates the file (or fills an empty one)." },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace every occurrence." },
    },
  },
  async run(input, env) {
    // Order and texts follow ZCode v3.15.1 (aac4755, Apache-2.0) core/src/tool/handlers/edit.ts.
    if (input.old_string === input.new_string) return failure("no_change", "No changes to make: old_string and new_string are exactly the same.");
    const target = await resolveWorkspacePath(input.path, env.cwd, env.roots);
    const info = await statOrNull(target.absolute);
    if (!info) {
      if (input.old_string === "") return createWithEdit(target, input.new_string, env);
      return failure("not_found", await missingFileMessage(target.absolute, env.cwd));
    }
    if (info.isDirectory()) return failure("is_directory", `Path is a directory: ${target.absolute}`);
    const bytes = await readFile(target.absolute);
    if (input.old_string === "") {
      if (toLf(decodeText(bytes, detectEncoding(bytes)).text).trim() !== "") return failure("file_exists", "Cannot create new file - file already exists.");
      await env.tracker.assertFresh(target.absolute, target.display);
      return createWithEdit(target, input.new_string, env, env.tracker.get(target.absolute)?.sha256 ?? "");
    }
    await env.tracker.assertFresh(target.absolute, target.display);
    const encoding = detectEncoding(bytes);
    const raw = decodeText(bytes, encoding).text;
    const content = toLf(raw);
    const search = toLf(input.old_string);
    const replacement = toLf(input.new_string);

    // ZCode edit-matchers strategies plus the guards documented in edit-locate.ts.
    const match = locateEdit(content, search, replacement, input.replace_all === true);
    if (match.status === "not_found") return failure("not_found", `String to replace not found in file.\nString: ${input.old_string}`);
    if (match.status === "ambiguous") return failure("ambiguous_match", ambiguousMessage(match.count, input.old_string));

    const eol = detectLineEnding(raw);
    const offsets = new LfOffsetMap(raw);
    let nextRaw = raw;
    let nextContent = content;
    for (const span of [...match.spans].reverse()) {
      const text = match.actualNewString;
      nextContent = nextContent.slice(0, span.start) + text + nextContent.slice(span.end);
      nextRaw = nextRaw.slice(0, offsets.toRaw(span.start)) + withLineEnding(text, eol) + nextRaw.slice(offsets.toRaw(span.end));
    }
    if (nextRaw === raw) return failure("no_change", "No changes to make: old_string and new_string are exactly the same.");

    const fs = new NodeWorkspaceFileSystem({ cwd: env.cwd, roots: env.roots });
    const expectedRevision = env.tracker.get(target.absolute)?.sha256 ?? "";
    const written = await fs.writeTextFile(target.absolute, nextRaw, { encoding, expectedRevision, signal: env.signal });
    env.tracker.restore(target.absolute, snapshotFromRevision(written));
    const snapshot = env.tracker.get(target.absolute);
    const diff = unifiedDiff(content, nextContent, target.display);
    const count = match.spans.length;
    return {
      ok: true,
      output: input.replace_all
        ? `The file ${target.absolute} has been updated. All occurrences were successfully replaced.${WRITE_STORAGE_SUFFIX}`
        : `The file ${target.absolute} has been updated successfully.${WRITE_STORAGE_SUFFIX}`,
      ...(snapshot
        ? { _read_state: createPersistedFileReadState(target.absolute, "edit", snapshot, false) }
        : {}),
      data: {
        path: target.display, replacements: count, strategy: match.strategy, encoding,
        added: diff.added, removed: diff.removed, diff: diff.unified,
      },
    };
  },
};

export function ambiguousMessage(count: number, oldString: string): string {
  return `Found ${count} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${oldString}`;
}

/** ZCode: an empty old_string writes new_string as the whole (new or empty) file. */
async function createWithEdit(target: { absolute: string; display: string }, text: string, env: ToolEnv, expectedRevision: string | null = null): Promise<ToolResult<EditData>> {
  const fs = new NodeWorkspaceFileSystem({ cwd: env.cwd, roots: env.roots });
  const written = await fs.writeTextFile(target.absolute, text, { encoding: "utf-8", expectedRevision, signal: env.signal });
  env.tracker.restore(target.absolute, snapshotFromRevision(written));
  const snapshot = env.tracker.get(target.absolute);
  const diff = unifiedDiff("", toLf(text), target.display);
  return {
    ok: true,
    output: `The file ${target.absolute} has been updated successfully.${WRITE_STORAGE_SUFFIX}`,
    ...(snapshot
      ? { _read_state: createPersistedFileReadState(target.absolute, "edit", snapshot, false) }
      : {}),
    data: { path: target.display, replacements: 1, strategy: "exact", encoding: "utf-8", added: diff.added, removed: diff.removed, diff: diff.unified },
  };
}
