/** `_read_pdf`: bounded page text and title of a PDF, Python's limits and errors. */
import { pyLen, pySlice } from "@xueness/contracts";
import { PdfDocument } from "./pdf-document.ts";
import { MAX_STREAM_BYTES, PdfStream } from "./pdf-objects.ts";
import { PageText } from "./pdf-text.ts";

export const MAX_DOCUMENT_CHARS = 400_000;
const MAX_PDF_PAGES = 100;
const MAX_PDF_TOTAL_STREAM_BYTES = 16_000_000;

class Limit extends Error {}

export interface PdfText { title: string; pages: Array<{ number: number; text: string }> }

export function readPdf(data: Buffer): { document: PdfText; truncated: boolean } {
  try {
    const doc = new PdfDocument(data);
    if (doc.encrypted) throw new Limit("encrypted PDFs are not supported");
    const all = doc.pages(), pages: PdfText["pages"] = [];
    let remaining = MAX_DOCUMENT_CHARS, decodedTotal = 0, textTruncated = false;
    for (const [index, { page, resources }] of all.slice(0, MAX_PDF_PAGES).entries()) {
      const contents = doc.resolve(page.get("Contents"));
      const streams = contents instanceof PdfStream ? [contents] : Array.isArray(contents) ? contents.map((item) => doc.resolve(item)).filter((item): item is PdfStream => item instanceof PdfStream) : [];
      let content = Buffer.alloc(0);
      if (streams.length) {
        content = Buffer.concat(streams.flatMap((stream, i) => i ? [Buffer.from("\n"), doc.bytes(stream)] : [doc.bytes(stream)]));
        decodedTotal += content.length;
        if (content.length > MAX_STREAM_BYTES || decodedTotal > MAX_PDF_TOTAL_STREAM_BYTES) throw new Limit("PDF page content exceeds the decompressed read limit");
      }
      const text = streams.length ? new PageText(doc).run(content, resources) : "";
      const clipped = pySlice(text, Math.min(10_000, remaining));
      textTruncated ||= pyLen(clipped) < pyLen(text);
      pages.push({ number: index + 1, text: clipped });
      remaining -= pyLen(clipped);
      if (remaining <= 0) break;
    }
    const rawTitle = doc.title(), title = pySlice(rawTitle, 200);
    textTruncated ||= pyLen(title) < pyLen(rawTitle);
    return { document: { title, pages }, truncated: all.length > pages.length || remaining <= 0 || textTruncated };
  } catch (error) {
    if (error instanceof Limit) throw new Error(error.message);
    throw new Error("invalid PDF document");
  }
}
