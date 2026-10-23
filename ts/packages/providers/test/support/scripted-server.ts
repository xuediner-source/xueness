/**
 * A raw TCP server that plays scripted HTTP responses, so the Python adapter
 * (urllib) and the TypeScript adapter can be driven through byte-identical
 * exchanges. Requests are routed by `/<side>/<case id>/...` and recorded.
 */
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

/** Raw bytes to write, a pause, an RST, or a connection kept open. */
export type Step = string | Uint8Array | { delay: number } | { reset: true } | { hang: true };
/** One attempt's response; the last script repeats for later attempts. */
export type Script = Step[];
/** A whole response written at once, or a stepped script. */
export type Response = string | Script;

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

interface Parsed {
  request: RecordedRequest;
  side: string;
  id: string;
}

function parseRequest(buffer: Buffer): Parsed | null {
  const end = buffer.indexOf("\r\n\r\n");
  if (end < 0) return null;
  const [line = "", ...rest] = buffer.subarray(0, end).toString("latin1").split("\r\n");
  const headers: Record<string, string> = {};
  for (const header of rest) {
    const colon = header.indexOf(":");
    const name = header.slice(0, colon).trim().toLowerCase();
    const value = header.slice(colon + 1).trim();
    headers[name] = name in headers ? `${headers[name]}, ${value}` : value;
  }
  const length = Number(headers["content-length"] ?? 0);
  if (buffer.length < end + 4 + length) return null;
  const [method = "", target = ""] = line.split(" ");
  const match = /^\/(py|ts)\/([A-Za-z0-9_-]+)(\/.*)?$/u.exec(target);
  const body = buffer.subarray(end + 4, end + 4 + length).toString("utf8");
  return {
    side: match?.[1] ?? "?", id: match?.[2] ?? "?",
    request: { method, path: match?.[3] ?? target, headers, body },
  };
}

export class ScriptedServer {
  readonly #scripts = new Map<string, Script[]>();
  readonly #requests = new Map<string, RecordedRequest[]>();
  readonly #sockets = new Set<net.Socket>();
  readonly #server: net.Server;
  port = 0;

  constructor() {
    this.#server = net.createServer((socket) => this.#accept(socket));
  }

  static async start(): Promise<ScriptedServer> {
    const server = new ScriptedServer();
    await new Promise<void>((resolve) => server.#server.listen(0, "127.0.0.1", resolve));
    server.port = (server.#server.address() as net.AddressInfo).port;
    return server;
  }

  /** The adapter base URL for one side of one case. */
  base(side: "py" | "ts", id: string): string {
    return `http://127.0.0.1:${this.port}/${side}/${id}`;
  }

  script(id: string, responses: Response[]): void {
    this.#scripts.set(id, responses.map((response) => (typeof response === "string" ? [response] : response)));
  }

  requests(side: "py" | "ts", id: string): RecordedRequest[] {
    return this.#requests.get(`${side}/${id}`) ?? [];
  }

  #accept(socket: net.Socket): void {
    this.#sockets.add(socket);
    socket.on("close", () => this.#sockets.delete(socket));
    socket.on("error", () => undefined);
    let buffer = Buffer.alloc(0);
    let answered = false;
    socket.on("data", (chunk: Buffer) => {
      if (answered) return;
      buffer = Buffer.concat([buffer, chunk]);
      const parsed = parseRequest(buffer);
      if (!parsed) return;
      answered = true;
      const key = `${parsed.side}/${parsed.id}`;
      const seen = this.#requests.get(key) ?? [];
      seen.push(parsed.request);
      this.#requests.set(key, seen);
      const scripts = this.#scripts.get(parsed.id) ?? [["HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"]];
      void this.#play(socket, scripts[Math.min(seen.length - 1, scripts.length - 1)] ?? []);
    });
  }

  async #play(socket: net.Socket, script: Script): Promise<void> {
    for (const step of script) {
      if (socket.destroyed) return;
      if (typeof step === "string" || step instanceof Uint8Array) {
        socket.write(typeof step === "string" ? Buffer.from(step, "utf8") : step);
      } else if ("delay" in step) {
        await delay(step.delay);
      } else if ("reset" in step) {
        socket.resetAndDestroy();
        return;
      } else {
        return;
      }
    }
    socket.end();
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}
