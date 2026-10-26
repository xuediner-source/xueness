/**
 * Bounded capture of one process output stream.
 *
 * While the stream fits the budget everything is kept. Once it outgrows the
 * budget the first and last halves stay in memory and the whole stream is
 * spooled to a file (outside the workspace) so nothing is lost: the model
 * sees head and tail plus the path of the full output.
 */
import { createWriteStream, type WriteStream } from "node:fs";

export interface CapturedOutput {
  /** Decoded text: everything, or head + omission marker + tail. */
  text: string;
  totalBytes: number;
  truncated: boolean;
  fullOutputPath?: string;
}

/** Trim a trailing incomplete UTF-8 sequence. */
export function cutHead(bytes: Buffer): Buffer {
  for (let back = 1; back <= Math.min(4, bytes.length); back += 1) {
    const byte = bytes[bytes.length - back] as number;
    if ((byte & 0xc0) === 0x80) continue;
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return need > back ? bytes.subarray(0, bytes.length - back) : bytes;
  }
  return bytes;
}

/** Skip leading UTF-8 continuation bytes. */
export function cutTail(bytes: Buffer): Buffer {
  let start = 0;
  while (start < Math.min(3, bytes.length) && ((bytes[start] as number) & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start);
}

/**
 * Decode process output: UTF-16 with BOM, UTF-8 (BOM stripped), and, for
 * bytes that are not UTF-8 (a Chinese Windows console), GB18030. Never throws.
 */
export function decodeOutput(bytes: Uint8Array): string {
  if (!bytes.length) return "";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder("gb18030", { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder("utf-8").decode(bytes);
    }
  }
}

/** Strip ANSI escapes and collapse carriage-return progress redraws. */
export function cleanTerminalText(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => (line.includes("\r") ? line.slice(line.lastIndexOf("\r", line.length - 2) + 1).replace(/\r$/, "") : line))
    .join("\n");
}

export class StreamCapture {
  readonly #max: number;
  readonly #spoolPath: string | undefined;
  #chunks: Buffer[] = [];
  #total = 0;
  #overflow = false;
  #head: Buffer = Buffer.alloc(0);
  #tail: Buffer[] = [];
  #tailBytes = 0;
  #spool: WriteStream | null = null;
  #spoolError: Error | null = null;

  constructor(maxBytes: number, spoolPath?: string) {
    this.#max = Math.max(2, maxBytes);
    this.#spoolPath = spoolPath;
  }

  push(chunk: Buffer): void {
    this.#total += chunk.length;
    if (this.#overflow) {
      this.#spool?.write(chunk);
      this.#appendTail(chunk);
      return;
    }
    this.#chunks.push(chunk);
    if (this.#total <= this.#max) return;
    this.#overflow = true;
    const all = Buffer.concat(this.#chunks);
    this.#chunks = [];
    if (this.#spoolPath) {
      this.#spool = createWriteStream(this.#spoolPath, { flags: "wx", mode: 0o600 });
      this.#spool.on("error", (error) => {
        this.#spoolError = error;
      });
      this.#spool.write(all);
    }
    const half = Math.floor(this.#max / 2);
    this.#head = all.subarray(0, half);
    this.#appendTail(all.subarray(half));
  }

  #appendTail(bytes: Buffer): void {
    const limit = this.#max - Math.floor(this.#max / 2);
    this.#tail.push(bytes);
    this.#tailBytes += bytes.length;
    while (this.#tail.length > 1 && this.#tailBytes - (this.#tail[0] as Buffer).length >= limit) {
      this.#tailBytes -= (this.#tail.shift() as Buffer).length;
    }
  }

  /**
   * Raw capture so far, for handing the stream to a new owner (the
   * foreground→background handoff): the in-memory chunks while everything
   * fits the budget, else the spill file that holds the whole stream.
   */
  snapshot(): { chunks: Buffer[]; totalBytes: number; spillPath?: string } {
    if (!this.#overflow) return { chunks: this.#chunks, totalBytes: this.#total };
    return { chunks: [], totalBytes: this.#total, ...(this.#spoolPath ? { spillPath: this.#spoolPath } : {}) };
  }

  async finish(): Promise<CapturedOutput> {
    if (!this.#overflow) {
      return { text: decodeOutput(Buffer.concat(this.#chunks)), totalBytes: this.#total, truncated: false };
    }
    const limit = this.#max - Math.floor(this.#max / 2);
    const tailAll = Buffer.concat(this.#tail);
    const tail = cutTail(tailAll.subarray(Math.max(0, tailAll.length - limit)));
    const head = cutHead(this.#head);
    const omitted = this.#total - head.length - tail.length;
    let fullOutputPath: string | undefined;
    if (this.#spool) {
      const spool = this.#spool;
      await new Promise<void>((resolve) => {
        spool.end(() => resolve());
        spool.once("error", () => resolve());
      });
      if (!this.#spoolError) fullOutputPath = this.#spoolPath;
    }
    const text = `${decodeOutput(head)}\n… [${omitted} bytes omitted] …\n${decodeOutput(tail)}`;
    return { text, totalBytes: this.#total, truncated: true, ...(fullOutputPath ? { fullOutputPath } : {}) };
  }
}
