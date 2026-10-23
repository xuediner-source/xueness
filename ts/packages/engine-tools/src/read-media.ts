/**
 * Read's image and PDF branches: ZCode v3.15.1 (aac4755, Apache-2.0)
 * `core/src/tool/handlers/read-image.ts`, `read-pdf.ts`,
 * `contracts/src/tools/read-pdf.ts` and the file-system adapter's
 * `readBinaryFile`. Attachments leave as `ToolResult.media`; `output` names
 * each one (`[Attached image/png: Read image]`) where ZCode puts the block.
 */
import type { Stats } from "node:fs";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import { ImagePrepareError, READ_IMAGE_MAX_INPUT_BYTES, type PreparedImage } from "./image/prepare.ts";
import { prepareImage } from "./image/prepare-async.ts";
import { PdfError, pdfPageCount, READ_PDF_MAX_PAGES_PER_REQUEST, renderPdfPages } from "./pdf-render.ts";
import { failure, type ToolEnv, type ToolMedia, type ToolResult } from "./tool.ts";
import { formatFileSize } from "./zcode-text.ts";

export const READ_PDF_NATIVE_MAX_INPUT_BYTES = 20 * 1024 * 1024;
export const READ_PDF_EXTRACT_MAX_INPUT_BYTES = 100 * 1024 * 1024;
export const READ_PDF_NATIVE_MAX_PAGES = 10;
const PAGE_PREPARE_CONCURRENCY = 4;

export interface ReadMediaData {
  path: string;
  type: "image" | "pdf" | "parts";
  mimeType: string;
  originalSize: number;
  transformedSize?: number;
  resized?: boolean;
  compressed?: boolean;
  compressionStrategy?: string;
  dimensions?: { originalWidth?: number; originalHeight?: number; displayWidth?: number; displayHeight?: number };
  pages?: number[];
}

export function inferImageMime(path: string): "image/jpeg" | "image/png" | "image/gif" | "image/webp" | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return undefined;
}

export const isPdfPath = (path: string): boolean => path.toLowerCase().endsWith(".pdf");

export function parsePdfPageRange(value: string): { firstPage: number; lastPage: number } | undefined {
  const normalized = value.trim();
  if (/^\d+-$/u.test(normalized)) {
    const firstPage = Number(normalized.slice(0, -1));
    return Number.isSafeInteger(firstPage) && firstPage >= 1 ? { firstPage, lastPage: Number.POSITIVE_INFINITY } : undefined;
  }
  const match = /^(\d+)(?:-(\d+))?$/u.exec(normalized);
  if (!match) return undefined;
  const firstPage = Number(match[1]), lastPage = Number(match[2] ?? match[1]);
  if (!Number.isSafeInteger(firstPage) || !Number.isSafeInteger(lastPage) || firstPage < 1 || lastPage < firstPage) return undefined;
  return { firstPage, lastPage };
}

/** ZCode `getReadPdfPagesValidationFailure`: checked before anything else runs. */
export function pdfPagesFailure(path: string, pages: string | undefined): ToolResult<never> | undefined {
  if (pages === undefined || !isPdfPath(path)) return undefined;
  const range = parsePdfPageRange(pages);
  if (!range) return failure("pdf_invalid_pages", `Invalid pages parameter: "${pages}". Use formats like "1-5", "3", or "10-20". Pages are 1-indexed.`);
  if (range.lastPage - range.firstPage + 1 > READ_PDF_MAX_PAGES_PER_REQUEST) {
    return failure("pdf_page_range_too_large", `Page range "${pages}" exceeds maximum of ${READ_PDF_MAX_PAGES_PER_REQUEST} pages per request. Please use a smaller range.`);
  }
  return undefined;
}

/** ZCode read-pdf `formatFileSize`: `512 bytes`, `1.5KB`, `3MB`, `1GB`. */
export function pdfFileSize(bytes: number): string {
  const one = (value: number): string => value.toFixed(1).replace(/\.0$/u, "");
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${one(bytes / 1024)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${one(bytes / (1024 * 1024))}MB`;
  return `${one(bytes / (1024 * 1024 * 1024))}GB`;
}

/** The adapter's bounded `readBinaryFile`: stat-checked, then at most `maxBytes + 1` read. */
async function readBinary(path: string, info: Stats, maxBytes: number): Promise<Buffer | ToolResult<never>> {
  if (info.isDirectory()) return failure("is_directory", `Cannot read directory as binary file: ${path}`);
  if (!info.isFile()) return failure("invalid_argument", `Cannot read non-file path as binary: ${path}`);
  if (info.size > maxBytes) return failure("file_too_large", `File content (${formatFileSize(info.size)}) exceeds maximum allowed size (${formatFileSize(maxBytes)}). Use a smaller file.`);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(info.size, maxBytes) + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length === buffer.length) break;
    }
    if (length > maxBytes) return failure("file_too_large", `File content exceeds maximum allowed size (${formatFileSize(maxBytes)}). Use a smaller file.`);
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

function imageData(path: string, size: number, prepared: PreparedImage): ReadMediaData {
  return {
    path, type: "image", mimeType: prepared.mediaType, originalSize: size, transformedSize: prepared.transformedSizeBytes,
    resized: prepared.resized, compressed: prepared.compressed, compressionStrategy: prepared.strategy,
    dimensions: { originalWidth: prepared.originalWidth, originalHeight: prepared.originalHeight, displayWidth: prepared.width, displayHeight: prepared.height },
  };
}

const attach = (prepared: PreparedImage, placeholder: string): ToolMedia =>
  ({ mimeType: prepared.mediaType, data: Buffer.from(prepared.data).toString("base64"), placeholder });

function prepareFailure(error: unknown): ToolResult<never> {
  if (error instanceof ImagePrepareError) return failure(`read_image_${error.code}`, error.message);
  if (error instanceof PdfError) return failure(error.code === "cancelled" ? "cancelled" : `pdf_${error.code}`, error.message);
  if ((error as Error | null)?.name === "AbortError") return failure("cancelled", (error as Error).message);
  throw error;
}

async function readImage(absolute: string, display: string, info: Stats, mime: string, env: ToolEnv): Promise<ToolResult<ReadMediaData>> {
  const bytes = await readBinary(absolute, info, READ_IMAGE_MAX_INPUT_BYTES);
  if (!Buffer.isBuffer(bytes)) return bytes;
  try {
    const prepared = await prepareImage(bytes, mime, env.signal);
    return { ok: true, output: `[Attached ${prepared.mediaType}: Read image]`, media: [attach(prepared, "Read image")], data: imageData(display, info.size, prepared) };
  } catch (error) {
    return prepareFailure(error);
  }
}

async function readNativePdf(absolute: string, display: string, info: Stats, env: ToolEnv): Promise<ToolResult<ReadMediaData>> {
  if (info.size > READ_PDF_NATIVE_MAX_INPUT_BYTES) return failure("pdf_too_large", `PDF file exceeds maximum allowed size of ${pdfFileSize(READ_PDF_NATIVE_MAX_INPUT_BYTES)}.`);
  let count: number | undefined;
  try {
    count = await pdfPageCount(absolute, env.signal);
  } catch (error) {
    return prepareFailure(error);
  }
  if (count !== undefined && count > READ_PDF_NATIVE_MAX_PAGES) {
    return failure("pdf_too_many_pages", `This PDF has ${count} pages, which is too many to read at once. Use the pages parameter to read specific page ranges (e.g., pages: "1-5"). Maximum ${READ_PDF_MAX_PAGES_PER_REQUEST} pages per request.`);
  }
  const bytes = await readBinary(absolute, info, READ_PDF_NATIVE_MAX_INPUT_BYTES);
  if (!Buffer.isBuffer(bytes)) return bytes;
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") return failure("pdf_invalid", `File is not a valid PDF (missing %PDF- header): ${absolute}`);
  const name = basename(absolute);
  return {
    ok: true,
    output: `PDF file read: ${absolute} (${pdfFileSize(info.size)})\n\n[Attached application/pdf: ${name}]`,
    media: [{ mimeType: "application/pdf", data: bytes.toString("base64"), placeholder: name }],
    data: { path: display, type: "pdf", mimeType: "application/pdf", originalSize: info.size },
  };
}

async function readPdfPages(absolute: string, display: string, info: Stats, pages: string, env: ToolEnv): Promise<ToolResult<ReadMediaData>> {
  if (info.size > READ_PDF_EXTRACT_MAX_INPUT_BYTES) return failure("pdf_too_large", `PDF file exceeds maximum allowed size for text extraction (${pdfFileSize(READ_PDF_EXTRACT_MAX_INPUT_BYTES)}).`);
  const invalid = pdfPagesFailure(absolute, pages);
  if (invalid) return invalid;
  const range = parsePdfPageRange(pages)!;
  try {
    const rendered = await renderPdfPages(absolute, range.firstPage, range.lastPage, env.signal);
    const prepared: { pageNumber: number; image: PreparedImage }[] = [];
    for (let at = 0; at < rendered.length; at += PAGE_PREPARE_CONCURRENCY) {
      const batch = rendered.slice(at, at + PAGE_PREPARE_CONCURRENCY);
      prepared.push(...await Promise.all(batch.map(async (page) => ({ pageNumber: page.pageNumber, image: await prepareImage(page.data, page.mediaType, env.signal) }))));
    }
    prepared.sort((left, right) => left.pageNumber - right.pageNumber);
    const media = prepared.map(({ pageNumber, image }) => attach(image, `PDF page ${pageNumber}`));
    const output = [`PDF pages extracted: ${prepared.length} page(s) from ${absolute} (${pdfFileSize(info.size)})`, ...media.map((item) => `[Attached ${item.mimeType}: ${item.placeholder}]`)].join("\n\n");
    return { ok: true, output, media, data: { path: display, type: "parts", mimeType: "image/jpeg", originalSize: info.size, pages: prepared.map((page) => page.pageNumber) } };
  } catch (error) {
    return prepareFailure(error);
  }
}

/** The media branch for `absolute`, or undefined when Read should take the text path. */
export async function readMedia(input: { pages?: string }, absolute: string, display: string, info: Stats, env: ToolEnv): Promise<ToolResult<ReadMediaData> | undefined> {
  const mime = inferImageMime(absolute);
  if (mime) return readImage(absolute, display, info, mime, env);
  if (!isPdfPath(absolute) || env.modelInput?.pdf !== true) return undefined;
  if (input.pages !== undefined && env.modelInput.image === false) {
    return failure("pdf_pages_images_unsupported", "The current model supports PDF input but does not support image input; remove the pages parameter.");
  }
  if (!info.isFile()) return failure("pdf_invalid", `Path is not a regular file: ${absolute}`);
  if (info.size === 0) return failure("pdf_invalid", `PDF file is empty: ${absolute}`);
  return input.pages === undefined ? readNativePdf(absolute, display, info, env) : readPdfPages(absolute, display, info, input.pages, env);
}
