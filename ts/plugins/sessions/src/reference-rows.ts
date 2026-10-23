/** Bounded citation metadata beside a journal, without reading file contents. */
import { isDict, pyLen, pySlice, pyStrip } from "@xueness/contracts";
type Row = Record<string, any>;
const KINDS: Record<string, string[]> = { md: [".md", ".markdown"], text: [".txt", ".text"], html: [".html", ".htm"], pdf: [".pdf"], docx: [".docx"], document: [".docx"], xlsx: [".xlsx"], workbook: [".xlsx"], pptx: [".pptx"], presentation: [".pptx"], image: [".png", ".jpg", ".jpeg", ".gif", ".webp"] };
const PREVIEW = new Set([...Object.values(KINDS).flat(), ".py", ".ts", ".tsx", ".js", ".jsx", ".json", ".css", ".mjs", ".cjs"]);
function messageText(m: Row): string {
  if (typeof m.content === "string") return pySlice(m.content, 40000);
  if (!Array.isArray(m.content)) return ""; const parts: string[] = []; let total = 0;
  for (const v of m.content.slice(0, 40)) if (isDict(v) && v.type === "text" && typeof v.text === "string") { const piece = pySlice(v.text, 40000 - total); parts.push(piece); total += pyLen(piece); if (total >= 40000) break; }
  return parts.join("\n");
}
function canonical(raw: unknown): string | null {
  if (typeof raw !== "string") return null; const path = pyStrip(raw);
  if (!path || pyLen(path) > 240 || /[\x00-\x1f\\]/u.test(path) || path.includes("://") || /^[~/]|^[A-Za-z]:/u.test(path)) return null;
  const parts: string[] = []; for (const part of path.split("/")) { if (!part || part === "..") return null; if (part !== ".") parts.push(part); }
  return parts.length && pyLen(parts.join("/")) <= 240 ? parts.join("/") : null;
}
function span(p: Row): [number, number] | [] | null {
  let a: number, b: number;
  if (Object.hasOwn(p, "lines")) { const match = /^(\d{1,6})(?:-(\d{1,6}))?$/u.exec(p.lines); if (!match) return null; a = Number(match[1]); b = Number(match[2] ?? match[1]); }
  else if (Object.hasOwn(p, "start") || Object.hasOwn(p, "end")) { if (!/^\d+$/u.test(p.start ?? "") || !/^\d+$/u.test(p.end ?? p.start ?? "")) return null; a = Number(p.start || 0); b = Number(p.end || p.start || 0); }
  else return [];
  return a >= 1 && a <= b && b <= 100000 && b - a + 1 <= 40 ? [a, b] : null;
}
function directives(text: string): Row[] {
  const ranges: [number, number][] = []; let open: number | null = null, char = "";
  for (const match of text.matchAll(/^(`{3,}|~{3,})/gm)) { if (open === null) { open = match.index; char = match[1]![0]!; } else if (match[1]![0] === char) { ranges.push([open, match.index + match[0].length]); open = null; } }
  if (open !== null) ranges.push([open, text.length]); const result: Row[] = [];
  for (const match of text.matchAll(/:{1,2}(zcode-file-citation|xueness-file|xueness-artifact)\{([^{}\r\n]{0,400})\}/gu)) {
    const begin = match.index, end = begin + match[0].length; if (ranges.some(([a, b]) => begin < b && end > a)) continue;
    const params: Row = {}; let invalid = false;
    const remaining = match[2]!.replace(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"\r\n\\]{0,240})"/gu, (_all, key: string, value: string) => { if (Object.hasOwn(params, key)) invalid = true; params[key] = value; return " "; });
    if (invalid || pyStrip(remaining) || !Object.hasOwn(params, "path")) continue; const path = canonical(params.path); if (path === null) continue;
    const lines = span(params), artifact = match[1] === "xueness-artifact", rawLabel = artifact ? params.name || params.purpose : params.purpose || params.name;
    const label = pySlice(typeof rawLabel === "string" && rawLabel.split(/\s+/u).filter(Boolean).join(" ") || path.split("/").at(-1)!, 80);
    const name = path.split("/").at(-1)!.toLowerCase(), dot = name.lastIndexOf("."), suffix = dot > 0 ? name.slice(dot) : "", kind = typeof params.artifact_kind === "string" ? pyStrip(params.artifact_kind).toLowerCase() : "";
    result.push({ start: pyLen(text.slice(0, begin)), end: pyLen(text.slice(0, end)), path, label, role: artifact ? "artifact" : "citation", span: lines ?? [], preview: !artifact && lines !== null && PREVIEW.has(suffix) && (!kind || KINDS[kind]?.includes(suffix)) });
  }
  return result;
}
export function projectReferences(messages: unknown, options: { root?: string; filesEffective?: boolean; stat?: (root: string, relative: string) => number | null } = {}): Row[] {
  if (!Array.isArray(messages)) return []; const result: Row[] = []; let total = 0;
  for (const [index, message] of messages.slice(0, 500).entries()) {
    if (!isDict(message)) continue; const text = messageText(message); if (!text || !text.includes("xueness-") && !text.includes("zcode-file-citation")) continue;
    const parsed = directives(text).slice(0, 8); if (!parsed.length) continue; const replacements: Row[] = [], references: Row[] = [];
    for (const item of parsed) {
      let size: number | null = null; try { if (options.filesEffective && options.root && total < 48) size = options.stat?.(options.root, item.path) ?? null; } catch { /* Invalid references render as plain text. */ }
      if (size !== null && total < 48) {
        const base = { path: item.path, label: item.label, ...(item.span.length ? { start_line: item.span[0], end_line: item.span[1] } : {}) };
        const rows = (item.role === "artifact" ? [{ ...base, kind: "artifact", size_bytes: size }] : [{ ...base, kind: "citation" }, ...(item.preview ? [{ ...base, kind: "preview" }] : [])]).slice(0, 48 - total);
        if (rows.length) { references.push(...rows); total += rows.length; replacements.push({ start: item.start, end: item.end, text: " " }); continue; }
      }
      const shown = item.span.length ? `${item.path}:${item.span[0]}-${item.span[1]}` : item.path;
      replacements.push({ start: item.start, end: item.end, text: pySlice(item.role === "artifact" || item.label !== item.path.split("/").at(-1) ? `${item.label} (${shown})` : shown, 300) });
    }
    const entry: Row = { message_index: index, replacements, references }; const id = message._message_id;
    if (typeof id === "string" && id && pyLen(id) <= 80 && !id.includes("\0")) entry.message_id = id;
    result.push(entry); if (result.length >= 80) break;
  }
  return result;
}
