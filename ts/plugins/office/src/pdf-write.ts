/**
 * A text-only A4 PDF in the layout `_make_pdf` gets from ReportLab's
 * SimpleDocTemplate: 72 pt margins with 6 pt frame padding, Title 18/22
 * centred, Heading2 14/18 with 12 pt before, body 10/16 with 6 pt before, the
 * same spacers, whitespace collapsed like Paragraph markup and line breaks for
 * "\n". Text uses the standard STSong-Light CID font with UniGB-UCS2-H, whose
 * Latin widths come from ReportLab's CID font metrics (BSD licence, see NOTICE).
 */
import { deflateSync } from "node:zlib";

const PAGE_W = 595.2756, PAGE_H = 841.8898, LEFT = 78, TOP = PAGE_H - 78, BOTTOM = 78, WIDTH = PAGE_W - 156;
const LATIN: number[] = [207, 270, 342, 467, 462, 797, 710, 239, 374, 374, 423, 605, 238, 375, 238, 334, 462, ...Array(9).fill(462), 238, 238, 605, 605, 605,
  344, 748, 684, 560, 695, 739, 563, 511, 729, 793, 318, 312, 666, 526, 896, 758, 772, 544, 772, 628, 465, 607, 753, 711, 972, 647, 620, 607, 374, 333, 374, 606, 500, 239, 417, 503, 427, 529, 415, 264, 444, 518, 241, 230, 495, 228, 793, 527, 524,
  524, 504, 338, 336, 277, 517, 450, 652, 466, 452, 407, 370, 258, 370, 605];
const W_ARRAY = "[1 [207 270 342 467 462 797 710 239 374] 10 [374 423 605 238 375 238 334 462] 18 26 462 27 28 238 29 31 605 32 [344 748 684 560 695 739 563 511 729 793 318 312 666 526 896 758 772 544 772 628 465 607 753 711 972 647 620 607 374 333 374 606 500 239 417 503 427 529 415 264 444 518 241 230 495 228 793 527 524] 81 [524 504 338 336 277 517 450 652 466 452 407 370 258 370 605]]";
const STYLES = { title: { size: 18, leading: 22, before: 0, after: 6, centre: true }, heading: { size: 14, leading: 18, before: 12, after: 6, centre: false }, body: { size: 10, leading: 16, before: 6, after: 0, centre: false } } as const;

export type PdfStyle = keyof typeof STYLES;
const width = (text: string, size: number): number => { let total = 0; for (const char of text) { const code = char.codePointAt(0)!; total += code >= 0x20 && code <= 0x7e ? LATIN[code - 0x20]! : 1000; } return total * size / 1000; };
const num = (value: number): string => { const text = (Math.round(value * 10000) / 10000).toFixed(4).replace(/\.?0+$/, ""); return text === "-0" ? "0" : text; };
const hex = (text: string): string => `<${Buffer.from(text, "utf16le").swap16().toString("hex").toUpperCase()}>`;

/** Paragraph markup lines: whitespace runs collapse, "\n" breaks, long words split. */
export function wrapLines(text: string, size: number): string[] {
  const lines: string[] = [];
  for (const segment of text.split("\n")) {
    const words = segment.split(/[ \t\r\f\v\u001c-\u001f\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\u000b]+/u).filter(Boolean);
    let line = "";
    for (let word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (width(candidate, size) <= WIDTH) { line = candidate; continue; }
      if (line) { lines.push(line); line = ""; }
      while (width(word, size) > WIDTH) {
        let cut = "", rest = "";
        for (const char of word) { if (!rest && width(cut + char, size) <= WIDTH) cut += char; else rest += char; }
        if (!cut) { cut = [...word][0]!; rest = word.slice(cut.length); }
        lines.push(cut); word = rest;
      }
      line = word;
    }
    lines.push(line);
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** PDF bytes for a validated `{title, paragraphs}` document. */
export function makePdf(document: { title: string; paragraphs: Array<{ text: string; style: PdfStyle }> }): Buffer {
  const pages: string[][] = [[]];
  let y = TOP, atTop = true;
  const newPage = (): void => { pages.push([]); y = TOP; atTop = true; };
  const block = (text: string, style: PdfStyle): void => {
    const metrics = STYLES[style];
    let lines = wrapLines(text, metrics.size);
    if (!atTop) y -= metrics.before;
    if (!lines.length) { pages[pages.length - 1]!.push("q\nQ"); atTop = false; y -= metrics.after; return; }
    while (lines.length) {
      let fit = Math.floor((y - BOTTOM + 1e-6) / metrics.leading);
      if (fit <= 0) { newPage(); continue; }
      fit = Math.min(fit, lines.length);
      const part = lines.slice(0, fit); lines = lines.slice(fit);
      const height = part.length * metrics.leading; y -= height;
      // Centred lines move the pen relative to the previous line, then back, as ReportLab does.
      let pen = 0;
      const shown = part.map((line, index) => {
        if (!metrics.centre) return `${hex(line)} Tj T*`;
        const dx = (WIDTH - width(line, metrics.size)) / 2, step = `${num(dx - pen)} 0 Td `;
        pen = dx;
        return `${step}${hex(line)} Tj T*${index === part.length - 1 ? ` ${num(-pen)} 0 Td` : ""}`;
      }).join(" ");
      pages[pages.length - 1]!.push(`q\n1 0 0 1 ${LEFT} ${num(y)} cm\nq\n0 0 0 rg\nBT 1 0 0 1 0 ${num(height - metrics.size)} Tm /F1 ${metrics.size} Tf ${metrics.leading} TL ${shown} ET\nQ\nQ`);
      atTop = false;
      if (lines.length) newPage();
    }
    y -= metrics.after;
  };
  const spacer = (height: number): void => { if (y - height < BOTTOM) newPage(); else y -= height; };
  if (document.title) { block(document.title, "title"); spacer(12); }
  for (const item of document.paragraphs) { block(item.text, item.style); spacer(6); }
  if (pages.length > 1 && !pages[pages.length - 1]!.length) pages.pop();

  const objects: Buffer[] = [];
  const add = (body: string | Buffer): number => { objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1")); return objects.length; };
  const stream = (dict: string, data: Buffer): Buffer => Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream", "latin1")]);
  add("<< /Type /Catalog /Pages 2 0 R /PageMode /UseNone >>");
  add("");
  add("<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /Name /F1 /DescendantFonts [4 0 R] >>");
  add(`<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 0 >> /DW 1000 /W ${W_ARRAY} /FontDescriptor 5 0 R >>`);
  add("<< /Type /FontDescriptor /FontName /STSongStd-Light /Ascent 752 /CapHeight 737 /Descent -271 /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Leading 148 /MaxWidth 1000 /MissingWidth 500 /StemH 91 /StemV 58 /XHeight 553 >>");
  add(`<< /Title ${hex(document.title || "Office document").replace("<", "<FEFF")} /Producer (Xueness) >>`);
  const kids: number[] = [];
  for (const page of pages) {
    const content = add(stream("/Filter /FlateDecode", deflateSync(Buffer.from(page.join("\n") + "\n", "latin1"))));
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R >> /ProcSet [/PDF /Text] >> /Contents ${content} 0 R /Rotate 0 >>`));
  }
  objects[1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`, "latin1");
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%\x93\x8c\x8b\x9e\n", "latin1")];
  const offsets: number[] = [];
  let size = parts[0]!.length;
  objects.forEach((body, index) => {
    offsets.push(size);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1")]);
    parts.push(chunk); size += chunk.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${size}\n%%EOF\n`, "latin1"));
  return Buffer.concat(parts);
}
