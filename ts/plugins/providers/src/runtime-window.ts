/** Preserve source/result paging cursors when shortening a prompt's tool data. */
import { isDict, pyJsonDumps, pyJsonLoads, pyLen, pyRepr, pySlice, pyStr } from "@xueness/contracts";
type Row = Record<string, unknown>;
const nonnegativeInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
function page(result: Row, source: boolean): boolean {
  return typeof result[source ? "path" : "tool_call_id"] === "string" && typeof result[source ? "output" : "output_untrusted"] === "string"
    && nonnegativeInt(result.offset) && nonnegativeInt(result.totalChars) && Object.hasOwn(result, "nextOffset")
    && (result.nextOffset === null || nonnegativeInt(result.nextOffset)) && (!source || typeof result.truncated === "boolean");
}
export function windowResult(message: Row, limit = 1400, resultPageLimit = 1200): Row {
  if (message.role === "user") return message;
  const content = message.content;
  if (message.role !== "tool" || typeof content !== "string") return { ...message };
  let parsed: unknown; try { parsed = pyJsonLoads(content); } catch { parsed = {}; }
  const result = isDict(parsed) ? parsed : {};
  if (page(result, true)) return sourcePage(message, result);
  if (page(result, false)) return storedPage(message, result);
  if (pyLen(content) <= limit) return { ...message };
  const view: Row = {};
  for (const key of ["ok", "error", "exit_code", "path", "denied", "evidence_id", "error_code", "retryable", "user_reason", "sourceType", "provenance"]) if (Object.hasOwn(result, key)) view[key] = result[key];
  if (Array.isArray(result.output) && result.output.some((row) => isDict(row) && Object.hasOwn(row, "url"))) {
    const sources: Row[] = []; const seen = new Set<string>();
    for (const row of result.output) {
      if (!isDict(row) || typeof row.url !== "string" || seen.has(row.url)) continue;
      seen.add(row.url);
      const item: Row = {};
      for (const key of ["title", "url"]) if (typeof row[key] === "string") item[key] = row[key];
      item.excerpt_untrusted = pySlice(pyStr(row.description ?? row.snippet ?? ""), 300);
      if (pyLen(pyJsonDumps({ ...view, sources_untrusted: [...sources, item] })) > Math.max(100, limit - 400)) break;
      sources.push(item);
    }
    view.sources_untrusted = sources;
  }
  if (!Array.isArray(view.sources_untrusted) || !view.sources_untrusted.length) view.preview_untrusted = pySlice(content, Math.max(100, limit - 400));
  Object.assign(view, { truncated_in_prompt: true, full_result_tool_call_id: message.tool_call_id ?? null,
    tool_result_read_default_limit: Math.min(resultPageLimit, 4000), tool_result_read_max_limit: 4000,
    read_more: "Use tool_result_read with this exact tool_call_id, offset and limit. Continue at nextOffset; never exceed tool_result_read_max_limit." });
  return { ...message, content: pyJsonDumps(view) };
}
function sourcePage(message: Row, result: Row): Row {
  const path = result.path as string; const offset = result.offset as number; const total = result.totalChars as number;
  const output = result.output as string; const next = result.nextOffset;
  const outOfRange = offset > total; const more = typeof next === "number" && next < total;
  const pageLimit = Math.min(12000, Math.max(1, pyLen(output)));
  const instruction = outOfRange ? `This source-file offset ${offset} exceeds totalChars=${total}. Retry read(path=${pyRepr(path)}, offset=0..${total}, limit=1..12000), or stop at EOF.`
    : more ? `This is a source-file page. Continue with read(path=${pyRepr(path)}, offset=${next}, limit=${pageLimit}). Do not use tool_result_read for this file.`
      : "This source-file page reaches EOF; no further source page is available.";
  return { ...message, content: pyJsonDumps({ ok: !!result.ok, paging_kind: "source_file", path, offset, totalChars: total, nextOffset: next,
    source_page_truncated: result.truncated, source_offset_out_of_range: outOfRange, pageComplete: !more && !outOfRange,
    page_instruction: instruction, output_untrusted: output, visibleChars: pyLen(output), truncated_in_prompt: false }) };
}
function storedPage(message: Row, result: Row): Row {
  const id = result.tool_call_id as string; const offset = result.offset as number; const total = result.totalChars as number;
  const output = result.output_untrusted as string; const next = result.nextOffset;
  const outOfRange = offset > total; const more = typeof next === "number" && next < total;
  const pageLimit = Math.min(4000, Math.max(1, pyLen(output)));
  const instruction = outOfRange ? `This stored-result offset ${offset} exceeds totalChars=${total}. Retry tool_result_read with this tool_call_id and offset=0..${total}, or stop at EOF.`
    : more ? `This is a stored-result JSON page, not a source-file page. Continue with tool_result_read(tool_call_id=${pyRepr(id)}, offset=${next}, limit=${pageLimit}). This offset indexes the stored result text.`
      : "This stored-result page reaches EOF; no further result page is available.";
  return { ...message, content: pyJsonDumps({ ok: !!result.ok, paging_kind: "stored_result", full_result_tool_call_id: id, offset, totalChars: total, nextOffset: next,
    pageComplete: !more && !outOfRange, page_instruction: instruction, output_untrusted: output, visibleChars: pyLen(output), truncated_in_prompt: false }) };
}
