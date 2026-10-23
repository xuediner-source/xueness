/**
 * The request-head refusals of `_read_request_head` and `parse_request`, in
 * Python's order, for every request that reaches the front door: request
 * line over 64 KiB (414), HTTP/2.0 or later (505), too many header lines or
 * one over 64 KiB (431), and HEAD (501: it would replay GET side effects).
 * Node's parser has already refused heads it cannot parse at all.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { writeProtocolError } from "./respond.ts";

/** `http.client._MAXLINE`, also the request-line cap in `web.py`. */
export const MAX_LINE = 65_536;
/** `http.client._MAXHEADERS`; the blank line that ends the head counts as one. */
export const MAX_HEADER_LINES = 100;

export function headRefusal(req: IncomingMessage): number {
  if (`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`.length > MAX_LINE) return 414;
  // llhttp accepts `HTTP/2.0`; `parse_request` refuses every version >= 2.0.
  if (req.httpVersionMajor >= 2) return 505;
  const raw = req.rawHeaders;
  if (raw.length / 2 + 1 > MAX_HEADER_LINES) return 431;
  for (let index = 0; index < raw.length; index += 2) {
    if (`${raw[index]}: ${raw[index + 1]}\r\n`.length > MAX_LINE) return 431;
  }
  return req.method === "HEAD" ? 501 : 0;
}

/**
 * Python's fixed refusal, then close. Written to the socket directly because
 * Python sends the JSON body even to HEAD, which Node's response would drop.
 */
export function refuse(res: ServerResponse, status: number): void {
  const write = (socket: Duplex): void => writeProtocolError(socket, status);
  if (res.socket) write(res.socket);
  else res.once("socket", write); // a pipelined request waits for its turn
}
