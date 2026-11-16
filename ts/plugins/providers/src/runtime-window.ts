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
  const data = isDict(result.data) ? result.data : null;
  // A page of a stored result is what the model asked for: it is never cut down to a preview of itself.
  if (result.ok === true && data && data.sourceType === "stored_result" && typeof data.tool_call_id === "string" && typeof result.output === "string" && nonnegativeInt(data.offset) && nonnegativeInt(data.totalChars)) {
    return storedResultPage(message, result, data, Math.max(limit, 400));
  }
  if (pyLen(content) <= limit) return { ...message };
  // A file read that is too long for the window becomes a page of whole lines with the line to continue from.
  if (result.ok === true && data && typeof data.path === "string" && typeof result.output === "string" && nonnegativeInt(data.totalLines) && nonnegativeInt(data.startLine)) {
    const paged = fileLinesPage(message, result, data, limit);
    if (paged) return paged;
  }
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
  // Preview the tool's own text when it has one: slicing the JSON spends the preview on keys and escapes.
  if (!Array.isArray(view.sources_untrusted) || !view.sources_untrusted.length) view.preview_untrusted = pySlice(typeof result.output === "string" && result.output ? result.output : content, Math.max(100, limit - 400));
  Object.assign(view, { truncated_in_prompt: true, full_result_tool_call_id: message.tool_call_id ?? null,
    tool_result_read_default_limit: Math.min(resultPageLimit, 4000), tool_result_read_max_limit: 4000,
    read_more: "Use tool_result_read with this exact tool_call_id, offset and limit. Continue at nextOffset; never exceed tool_result_read_max_limit." });
  return { ...message, content: pyJsonDumps(view) };
}
const evidence = (result: Row): Row => typeof result.evidence_id === "string" ? { evidence_id: result.evidence_id } : {};

/**
 * `read` returns numbered lines (`<n>\t<text>`) and line-based paging data. Keep as many whole lines
 * as fit, and tell the model the exact line to continue from, so a long file is read page by page
 * with `read` itself; the stored result is never needed for it.
 */
function fileLinesPage(message: Row, result: Row, data: Row, limit: number): Row | null {
  const lines = (result.output as string).split("\n");
  const budget = Math.max(200, limit - 420);
  let used = 0, kept = 0, lastLine: number | null = null;
  for (const line of lines) {
    const size = pyLen(line) + 1;
    if (kept && used + size > budget) break;
    used += size; kept += 1;
    const number = /^(\d+)\t/.exec(line);
    if (number) lastLine = Number(number[1]);
  }
  // One line longer than the page, or no numbered lines at all (a notice): the generic preview handles it.
  if (lastLine === null || kept === lines.length || used > budget * 2) return null;
  const path = data.path as string, total = data.totalLines as number;
  const next = lastLine < total ? lastLine + 1 : null;
  const shown = lines.slice(0, kept).join("\n");
  return { ...message, content: pyJsonDumps({ ok: true, ...evidence(result), paging_kind: "source_file", path, startLine: data.startLine, endLine: lastLine, totalLines: total, nextOffset: next,
    pageComplete: next === null, truncated_in_prompt: true,
    page_instruction: next === null ? "This page reaches the end of the file." : `This is lines ${String(data.startLine)}-${lastLine} of ${total}. Continue with read(path=${pyRepr(path)}, offset=${next}, limit=${Math.max(20, kept)}); offset is a line number. Do not use tool_result_read for this file.`,
    output_untrusted: shown }) };
}

/** A `tool_result_read` page, kept whole up to `limit` characters; a longer page is cut and its cursor moved back to match. */
function storedResultPage(message: Row, result: Row, data: Row, limit: number): Row {
  const id = data.tool_call_id as string, offset = data.offset as number, total = data.totalChars as number;
  const full = result.output as string, cut = pyLen(full) > limit;
  const output = cut ? pySlice(full, limit) : full;
  const next = cut ? offset + pyLen(output) : nonnegativeInt(data.nextOffset) ? data.nextOffset : null;
  const more = next !== null && next < total;
  return { ...message, content: pyJsonDumps({ ok: true, ...evidence(result), paging_kind: "stored_result", full_result_tool_call_id: id, offset, totalChars: total, nextOffset: more ? next : null,
    pageComplete: !more, truncated_in_prompt: cut,
    page_instruction: offset > total ? `Offset ${offset} is past the end (${total}). Retry with offset 0..${total}.`
      : more ? `Continue with tool_result_read(tool_call_id=${pyRepr(id)}, offset=${next}, limit=${Math.min(4000, Math.max(200, pyLen(output)))}); this offset counts characters of the stored result, not file lines.`
        : "This page reaches the end of the stored result.",
    output_untrusted: output }) };
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
