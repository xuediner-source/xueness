/** Bounded, guarded JSON intake for routes migrated from Python. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { isDict, pyDecodeUtf8, pyJsonLoads, pyStrip } from "@xueness/contracts";
import { requestPath } from "./py-url.ts";

export class IntakeError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
export interface ApiBody { data: Record<string, unknown>; raw: Buffer; close: boolean }
export async function readApiBody(req: IncomingMessage, res: ServerResponse, options: { idleMs?: number; deadlineMs?: number; lossless?: boolean } = {}): Promise<ApiBody> {
  // The caller validates all framing and guards before acknowledging Expect.
  const lengthText = req.headersDistinct["content-length"]?.[0];
  const length = lengthText === undefined ? 0 : Number(lengthText);
  const expects = req.headersDistinct.expect ?? [];
  if (expects.length && (expects.length !== 1 || pyStrip(expects[0]!).toLowerCase() !== "100-continue")) {
    throw new IntakeError(417, "expectation_failed", "Expect is not supported");
  }
  if (expects.length && length > 0) res.writeContinue();
  if (!length) return { data: {}, raw: Buffer.alloc(0), close: lengthText === undefined };
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const parts: Buffer[] = [];
    let received = 0;
    let idle: NodeJS.Timeout;
    const timeout = () => finish(new IntakeError(408, "request_timeout", "request timed out"));
    const deadline = setTimeout(timeout, options.deadlineMs ?? 30_000);
    const resetIdle = () => { clearTimeout(idle); idle = setTimeout(timeout, options.idleMs ?? 15_000); };
    const onData = (part: Buffer) => {
      received += part.length;
      if (received > length) { finish(new IntakeError(400, "invalid_content_length", "invalid Content-Length")); return; }
      parts.push(part); resetIdle();
    };
    const onEnd = () => finish(received === length ? undefined : new IntakeError(400, "truncated_body", "request body ended early"));
    const onAbort = () => finish(new IntakeError(400, "truncated_body", "request body ended early"));
    let settled = false;
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(idle); clearTimeout(deadline);
      req.off("data", onData); req.off("end", onEnd); req.off("aborted", onAbort); req.off("error", onAbort);
      if (error) { req.pause(); reject(error); } else resolve(Buffer.concat(parts, received));
    }
    req.on("data", onData); req.once("end", onEnd); req.once("aborted", onAbort); req.once("error", onAbort);
    resetIdle();
  });
  try {
    const data = pyJsonLoads(pyDecodeUtf8(raw), { lossless: options.lossless === true });
    if (!isDict(data)) throw new Error("not an object");
    return { raw, data, close: false };
  } catch { throw new IntakeError(400, "invalid_json", "invalid json body"); }
}

export interface ApiDispatcher {
  /** Select only known routes; a null dispatch may still use the migration fallback. */
  owns(method: string, parts: readonly string[]): boolean;
  /** Decode this route's body losslessly (integral floats, large integers), as Python's `json.loads` does. */
  lossless?(method: string, parts: readonly string[]): boolean;
  dispatch(method: string, parts: string[], query: Record<string, string[]>, data: Record<string, unknown>, request?: { accept?: string; lastEventId?: string; signal?: AbortSignal; remoteAddress?: string; hostCapability?: string | null }): Promise<[number, unknown, string?, Record<string, string>?] | null>;
  readonly csrfToken: string;
  readonly routes?: readonly string[];
  /** Optional plugin owner serves only build-pinned asset names and bytes. */
  asset?(name: string): Buffer | null;
}

export function apiLocation(url: string): { parts: string[]; query: Record<string, string[]> } {
  const query: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  const { path, query: raw } = requestPath(url);
  for (const [name, value] of new URLSearchParams(raw)) {
    (query[name] ??= []).push(value);
  }
  return { parts: path.split("/").filter(Boolean), query };
}
