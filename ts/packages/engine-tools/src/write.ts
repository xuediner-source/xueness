/**
 * write: create a file or replace one the agent has read.
 *
 * An existing file keeps its encoding, BOM and dominant line ending, and must
 * be unchanged since it was read. A new file is UTF-8 with the content's own
 * line endings. Parent directories are created.
 */
import { readFile } from "node:fs/promises";
import { unifiedDiff } from "./diff.ts";
import { detectLineEnding, toLf, withLineEnding } from "./line-endings.ts";
import { resolveWorkspacePath } from "./paths.ts";
import { decodeText, detectEncoding, encodeText, type TextEncodingName } from "./text-codec.ts";
import { createPersistedFileReadState } from "./file-state.ts";
import { NodeWorkspaceFileSystem, snapshotFromRevision } from "./filesystem.ts";
import { failure, statOrNull, WRITES_WORKSPACE, type ToolDefinition } from "./tool.ts";

export const WRITE_MAX_BYTES = 16 * 1024 * 1024;
export const WRITE_STORAGE_SUFFIX = " (file state is current in your context \u2014 no need to Read it back)";

export interface WriteInput {
  path: string;
  content: string;
}

export interface WriteData {
  path: string;
  created: boolean;
  bytes: number;
  encoding: TextEncodingName;
  lineEnding: "LF" | "CRLF";
  added: number;
  removed: number;
  diff: string;
}

export const writeTool: ToolDefinition<WriteInput, WriteData> = {
  name: "write",
  gate: "write",
  mutating: true,
  concurrencySafe: false,
  requires: WRITES_WORKSPACE,
  description: [
    "Write a whole file. Creates parent directories. To change part of a file prefer edit.",
    "Overwriting requires reading the file first; its encoding and line endings are kept.",
  ].join(" "),
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "content"],
    properties: {
      path: { type: "string", minLength: 1 },
      content: { type: "string", description: "Complete new file content." },
    },
  },
  async run(input, env) {
    const target = await resolveWorkspacePath(input.path, env.cwd, env.roots);
    const info = await statOrNull(target.absolute);
    if (info?.isDirectory()) return failure("is_directory", `Path is a directory: ${target.absolute}`);
    let encoding: TextEncodingName = "utf-8";
    let content = input.content;
    let before = "";
    if (info) {
      await env.tracker.assertFresh(target.absolute, target.display);
      const bytes = await readFile(target.absolute);
      encoding = detectEncoding(bytes);
      const raw = decodeText(bytes, encoding).text;
      before = toLf(raw);
      if (raw.includes("\n")) content = withLineEnding(content, detectLineEnding(raw));
    }
    const data = encodeText(content, encoding);
    if (data.length > WRITE_MAX_BYTES) return failure("file_too_large", `content is ${data.length} bytes; the limit is ${WRITE_MAX_BYTES}`);
    const fs = new NodeWorkspaceFileSystem({ cwd: env.cwd, roots: env.roots });
    const previous = env.tracker.get(target.absolute);
    const written = await fs.writeTextFile(target.absolute, content, {
      encoding,
      expectedRevision: info ? previous?.sha256 ?? null : null,
      signal: env.signal,
    });
    env.tracker.restore(target.absolute, snapshotFromRevision(written));
    const snapshot = env.tracker.get(target.absolute);
    const diff = unifiedDiff(before, toLf(content), target.display, { maxChars: 8000 });
    const lineEnding = detectLineEnding(content) === "\r\n" ? "CRLF" : "LF";
    // ZCode formatWriteModelContent (handlers/write.ts); the diff stays in data for the UI.
    const output = info
      ? `The file ${target.absolute} has been updated successfully.${WRITE_STORAGE_SUFFIX}`
      : `File created successfully at: ${target.absolute}${WRITE_STORAGE_SUFFIX}`;
    return {
      ok: true,
      output,
      ...(snapshot
        ? { _read_state: createPersistedFileReadState(target.absolute, "write", snapshot, false) }
        : {}),
      data: { path: target.display, created: !info, bytes: data.length, encoding, lineEnding, added: diff.added, removed: diff.removed, diff: diff.unified },
    };
  },
};
