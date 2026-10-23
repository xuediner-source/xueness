/**
 * Poppler access for Read's PDF branch: ZCode v3.15.1 (aac4755, Apache-2.0)
 * `adapters/src/pdf/index.ts` (`pdfinfo` page count, `pdftoppm -jpeg -r 100`
 * page rendering, availability probe and stderr classification).
 */
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const READ_PDF_MAX_PAGES_PER_REQUEST = 20;
export const READ_PDF_INFO_TIMEOUT_MS = 10_000;
export const READ_PDF_AVAILABILITY_TIMEOUT_MS = 5_000;
export const READ_PDF_RENDER_TIMEOUT_MS = 120_000;
const BROKEN_PDF_STRUCTURE = /Syntax Error(?: \(\d+\))?: Couldn't (?:find trailer dictionary|read xref table)/iu;

export type PdfErrorCode = "cancelled" | "corrupted" | "io_error" | "page_out_of_range" | "password_protected" | "permission_denied" | "process_failed" | "timeout" | "unavailable";

export class PdfError extends Error {
  readonly code: PdfErrorCode;
  constructor(code: PdfErrorCode, message: string) {
    super(message);
    this.name = "PdfError";
    this.code = code;
  }
}

export interface RenderedPdfPage { pageNumber: number; data: Uint8Array; mediaType: "image/jpeg" }

interface RunResult { exitCode?: number; stdout: string; stderr: string; timedOut: boolean; cancelled: boolean; error?: string }

function run(file: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, signal, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return resolve({ exitCode: 0, stdout, stderr, timedOut: false, cancelled: false });
      const failed = error as Error & { code?: number | string | null; killed?: boolean; signal?: string | null };
      if (signal?.aborted || failed.name === "AbortError") return resolve({ stdout, stderr, timedOut: false, cancelled: true });
      if (failed.killed && failed.signal === "SIGTERM") return resolve({ stdout, stderr, timedOut: true, cancelled: false });
      resolve({ exitCode: typeof failed.code === "number" ? failed.code : undefined, stdout: stdout ?? "", stderr: stderr ?? "", timedOut: false, cancelled: false, error: failed.message });
    });
  });
}

/** `pdfinfo` page count; undefined when pdfinfo is missing or cannot read the file. */
export async function pdfPageCount(filePath: string, signal?: AbortSignal): Promise<number | undefined> {
  const result = await run("pdfinfo", [filePath], READ_PDF_INFO_TIMEOUT_MS, signal);
  if (result.cancelled || signal?.aborted) throw new PdfError("cancelled", "PDF inspection was cancelled.");
  if (result.exitCode !== 0) return undefined;
  const count = Number(/^Pages:\s+(\d+)\s*$/imu.exec(result.stdout)?.[1]);
  return Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

let available = false;

async function ensureAvailable(signal?: AbortSignal): Promise<void> {
  if (available) return;
  const result = await run("pdftoppm", ["-v"], READ_PDF_AVAILABILITY_TIMEOUT_MS, signal);
  if (result.cancelled || signal?.aborted) throw new PdfError("cancelled", "PDF page extraction was cancelled.");
  if (result.timedOut) throw new PdfError("timeout", `PDF page extraction availability check timed out after ${READ_PDF_AVAILABILITY_TIMEOUT_MS}ms.`);
  const ok = result.exitCode === 0 || (result.exitCode !== undefined && result.exitCode !== 127 && result.stderr.length > 0);
  if (!ok) throw new PdfError("unavailable", "pdftoppm is not installed. Install poppler-utils (e.g. `brew install poppler` or `apt-get install poppler-utils`) to enable PDF page rendering.");
  available = true;
}

function classifyFailure(result: RunResult, filePath: string, firstPage: number, lastPage: number): PdfError {
  if (result.cancelled) return new PdfError("cancelled", "PDF page extraction was cancelled.");
  if (result.timedOut) return new PdfError("timeout", `PDF page extraction timed out after ${READ_PDF_RENDER_TIMEOUT_MS}ms.`);
  const stderr = result.stderr;
  const detail = [stderr, result.stdout, result.error].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join("\n").trim();
  if (/password/iu.test(stderr)) return new PdfError("password_protected", "PDF is password-protected. Please provide an unprotected version.");
  const range = /Wrong page range given[\s\S]*last page \((\d+)\)/iu.exec(stderr);
  if (range) {
    const count = Number(range[1]);
    if (count === 0) return new PdfError("corrupted", "PDF reports 0 pages (empty page tree). The PDF may be invalid.");
    if (Number.isSafeInteger(count) && count >= 1) {
      const requested = firstPage === lastPage ? `page ${firstPage}` : `pages ${firstPage}-${lastPage}`;
      return new PdfError("page_out_of_range", `Requested ${requested} is outside the document (PDF has ${count} page${count === 1 ? "" : "s"}). Use a range within 1-${count}, maximum ${READ_PDF_MAX_PAGES_PER_REQUEST} pages per request (e.g. pages: "1-${Math.min(count, READ_PDF_MAX_PAGES_PER_REQUEST)}").`);
    }
  }
  const lines = stderr.split("\n");
  const first = lines[0] ?? "";
  const internal = lines.some((line) => /^(?:Command Line Error|Internal Error)(?: \(\d+\))?: /u.test(line));
  const ioError = first.startsWith("I/O Error: ") && first.includes(`'${filePath}'`);
  const permission = first.startsWith("Permission Error: ");
  if ((ioError || permission) && !internal) return new PdfError(permission ? "permission_denied" : "io_error", `Could not render PDF: ${first}`);
  if (/damaged|corrupt|invalid/iu.test(stderr) || BROKEN_PDF_STRUCTURE.test(stderr)) return new PdfError("corrupted", "PDF file is corrupted or invalid.");
  return new PdfError("process_failed", detail.length > 0 ? `pdftoppm failed: ${detail}` : "pdftoppm failed.");
}

function ioError(signal: AbortSignal | undefined, message: string): PdfError {
  return signal?.aborted ? new PdfError("cancelled", "PDF page extraction was cancelled.") : new PdfError("io_error", message);
}

/** Render pages `firstPage..lastPage` as 100 dpi JPEGs, in page order. */
export async function renderPdfPages(filePath: string, firstPage: number, lastPage: number, signal?: AbortSignal): Promise<RenderedPdfPage[]> {
  await ensureAvailable(signal);
  let directory: string;
  try {
    directory = await mkdtemp(join(tmpdir(), "xueness-read-pdf-"));
  } catch {
    throw ioError(signal, "Unable to create a temporary directory for PDF page extraction.");
  }
  let failed = false;
  try {
    const result = await run("pdftoppm", ["-jpeg", "-r", "100", "-f", String(firstPage), "-l", String(lastPage), filePath, join(directory, "page")], READ_PDF_RENDER_TIMEOUT_MS, signal);
    if (result.cancelled || result.timedOut || result.exitCode !== 0) throw classifyFailure(result, filePath, firstPage, lastPage);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      throw ioError(signal, "Unable to list rendered PDF page images.");
    }
    const files = names.map((name) => ({ name, pageNumber: Number(/-(\d+)\.jpg$/iu.exec(name)?.[1]) }))
      .filter((entry) => Number.isSafeInteger(entry.pageNumber) && entry.pageNumber >= 1)
      .sort((left, right) => left.pageNumber - right.pageNumber);
    if (!files.length) throw new PdfError("corrupted", "pdftoppm produced no output pages. The PDF may be invalid.");
    try {
      return await Promise.all(files.map(async ({ name, pageNumber }) => ({ data: new Uint8Array(await readFile(join(directory, name))), mediaType: "image/jpeg" as const, pageNumber })));
    } catch {
      throw signal?.aborted ? new PdfError("cancelled", "PDF page extraction was cancelled.") : new PdfError("io_error", "Unable to read rendered PDF page images.");
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {
      if (!failed) throw ioError(signal, "Unable to remove temporary PDF page images.");
    }
  }
}
