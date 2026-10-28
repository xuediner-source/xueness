/** Chunked writes belong to the files plugin; all mutations use the versioned writer. */
import { readFile } from "node:fs/promises";
import { decodeText, detectEncoding, resolveWorkspacePath, statOrNull, writeTool, type ToolDefinition, type WriteData, type WriteInput } from "@xueness/engine-tools";

export interface ChunkWriteInput extends WriteInput { append?: boolean }
export const chunkWriteTool: ToolDefinition<ChunkWriteInput, WriteData> = {
  ...writeTool,
  description: "Create or replace a file, or append the next chunk with append=true. Creates parent directories. For long files, aim for roughly 4000 characters per call: write the first chunk, then append remaining chunks without resending the prefix. Existing files must be current in your read/write state; encoding, BOM, line endings and atomic revision checks are preserved. For local changes prefer edit.",
  inputSchema: { ...writeTool.inputSchema, properties: {
    ...writeTool.inputSchema.properties as Record<string, unknown>,
    content: { type: "string", description: "New file content, or the next chunk when append=true." },
    append: { type: "boolean", description: "Append this chunk at EOF; defaults to false (replace/create)." },
  } },
  async run(input, env) {
    if (!input.append) return writeTool.run(input, env);
    const target = await resolveWorkspacePath(input.path, env.cwd, env.roots);
    const info = await statOrNull(target.absolute);
    if (!info || info.isDirectory()) return writeTool.run(input, env);
    await env.tracker.assertFresh(target.absolute, target.display);
    const bytes = await readFile(target.absolute);
    const prefix = decodeText(bytes, detectEncoding(bytes)).text;
    return writeTool.run({ path: input.path, content: prefix + input.content }, env);
  },
};
