/** A raw HTTP/1.1 client for differential tests: exact request bytes in, parsed response out. */
import { connect } from "node:net";

export interface RawResponse {
  status: number;
  headers: Record<string, string[]>;
  body: Buffer;
  /** Interim 100 Continue seen before the final response. */
  continued: boolean;
  /** The server closed the connection after the response. */
  closed: boolean;
}

export interface RawRequest {
  head: string;
  body?: string | Buffer;
  /** Send the body only after a 100 Continue (or after waitMs without one). */
  waitForContinue?: boolean;
  waitMs?: number;
}

function parseHead(text: string): { status: number; headers: Record<string, string[]> } {
  const [statusLine, ...lines] = text.split("\r\n");
  const status = Number((statusLine ?? "").split(" ")[1]);
  const headers: Record<string, string[]> = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    (headers[name] ??= []).push(line.slice(colon + 1).trim());
  }
  return { status, headers };
}

export function rawRequest(port: number, request: RawRequest, timeoutMs = 10_000): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let buffer = Buffer.alloc(0);
    let continued = false;
    let bodySent = false;
    let final: { status: number; headers: Record<string, string[]>; bodyStart: number } | null = null;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timeout waiting for response to ${request.head.split("\r\n")[0]}`));
    }, timeoutMs);
    const sendBody = (): void => {
      if (bodySent) return;
      bodySent = true;
      if (request.body !== undefined && !socket.destroyed) socket.write(request.body);
    };
    const finish = (closed: boolean): void => {
      if (!final) return;
      clearTimeout(timer);
      const length = Number(final.headers["content-length"]?.[0] ?? NaN);
      const body = Number.isFinite(length) ? buffer.subarray(final.bodyStart, final.bodyStart + length) : buffer.subarray(final.bodyStart);
      socket.destroy();
      resolve({ status: final.status, headers: final.headers, body, continued, closed });
    };
    const parse = (): void => {
      for (;;) {
        if (final) {
          const length = Number(final.headers["content-length"]?.[0] ?? NaN);
          if (Number.isFinite(length) && buffer.length - final.bodyStart >= length) {
            // Give the server a moment to close if it intends to.
            setTimeout(() => finish(socket.readableEnded || socket.destroyed), 50);
          }
          return;
        }
        const end = buffer.indexOf("\r\n\r\n");
        if (end === -1) return;
        const head = parseHead(buffer.subarray(0, end).toString("latin1"));
        if (head.status === 100) {
          continued = true;
          buffer = buffer.subarray(end + 4);
          sendBody();
          continue;
        }
        final = { ...head, bodyStart: end + 4 };
      }
    };
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      parse();
    });
    socket.on("end", () => finish(true));
    socket.on("close", () => finish(true));
    socket.on("error", () => finish(true));
    socket.write(request.head);
    if (request.waitForContinue) setTimeout(sendBody, request.waitMs ?? 1500);
    else sendBody();
  });
}

export interface SequenceStep {
  status: number;
  /** The server closed the connection after this answer. */
  closed: boolean;
}

/** Send every request before reading; retain complete responses until peer close. */
export function rawPipeline(port: number, requests: readonly RawRequest[]): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let buffer = Buffer.alloc(0);
    const statuses: number[] = [];
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("pipelined peer did not close")); }, 5000);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = parseHead(buffer.subarray(0, end).toString("latin1"));
        const length = Number(head.headers["content-length"]?.[0] ?? 0);
        if (buffer.length < end + 4 + length) return;
        statuses.push(head.status);
        buffer = buffer.subarray(end + 4 + length);
      }
    });
    socket.on("error", () => undefined);
    socket.once("close", () => { clearTimeout(timer); resolve(statuses); });
    for (const request of requests) {
      socket.write(request.head);
      if (request.body !== undefined) socket.write(request.body);
    }
  });
}

/** Requests in order on one connection, each sent after the previous answer; stops once the server closes. */
export function rawSequence(port: number, requests: readonly (RawRequest & { pauseMs?: number })[], timeoutMs = 10_000): Promise<SequenceStep[]> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const steps: SequenceStep[] = [];
    let buffer = Buffer.alloc(0);
    let ended = false;
    let index = 0;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timeout in sequence at request ${index}`));
    }, timeoutMs);
    const done = (): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(steps);
    };
    const send = (): void => {
      const next = requests[index];
      if (!next || ended) return done();
      setTimeout(() => {
        if (ended) return done();
        socket.write(next.head);
        if (next.body !== undefined) socket.write(next.body);
      }, next.pauseMs ?? 0);
    };
    const parse = (): void => {
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      const head = parseHead(buffer.subarray(0, end).toString("latin1"));
      const length = Number(head.headers["content-length"]?.[0] ?? 0);
      if (buffer.length < end + 4 + length) return;
      buffer = buffer.subarray(end + 4 + length);
      setTimeout(() => {
        steps.push({ status: head.status, closed: ended });
        index += 1;
        send();
      }, 50);
    };
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      parse();
    });
    socket.on("end", () => {
      ended = true;
    });
    socket.on("error", () => {
      ended = true;
    });
    send();
  });
}
