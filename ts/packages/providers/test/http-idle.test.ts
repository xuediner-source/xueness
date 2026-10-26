/**
 * The idle timeout on real sockets keeps Python's socket-timeout semantics
 * (checked against urllib by hand; no oracle, these are timing bounds): a
 * stalled TLS handshake or upload fails after one timeout (Node's own timer
 * took two), the request goes out within one timeout however it progresses
 * (`sendall`), a response is read only after that, as urllib's URLError
 * until then, and time the consumer spends between reads is not counted.
 */
import assert from "node:assert/strict";
import net from "node:net";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ProviderTransportError, openHttp, pyUrlSplit, readBody, trustedCertificates, type HttpRequestSpec } from "../src/index.ts";

let behavior: (socket: net.Socket) => void = () => undefined;
const sockets = new Set<net.Socket>();
const server = net.createServer((socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => undefined);
  behavior(socket);
});

let port = 0;
before(async () => {
  trustedCertificates(); // loaded once per process: keep it out of the measured times
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;
});
after(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const spec = (scheme: "http" | "https", timeoutMs: number, body: Uint8Array = Buffer.from("{}")): HttpRequestSpec => ({
  url: pyUrlSplit(`${scheme}://127.0.0.1:${port}/v1/chat/completions`), method: "POST",
  headers: { "Content-Type": "application/json" }, body, timeoutMs, proxy: null,
});

/** Calls `onBody` once the request head and a `length`-byte body have arrived. */
function onRequest(socket: net.Socket, onBody: () => void): void {
  let buffer = Buffer.alloc(0);
  const data = (chunk: Buffer): void => {
    buffer = Buffer.concat([buffer, chunk]);
    const end = buffer.indexOf("\r\n\r\n");
    const length = /content-length: *(\d+)/i.exec(buffer.subarray(0, Math.max(end, 0)).toString("latin1"));
    if (end >= 0 && length && buffer.length >= end + 4 + Number(length[1])) {
      socket.off("data", data);
      onBody();
    }
  };
  socket.on("data", data);
}

async function failure(request: HttpRequestSpec): Promise<[ProviderTransportError, number, number]> {
  const start = performance.now();
  // Account for runner event-loop starvation using an independent deadline.
  // Extending the network timeout still fails when the loop can run normally.
  let schedulerLag = 0;
  const deadline = setTimeout(() => { schedulerLag = Math.max(0, performance.now() - start - request.timeoutMs); }, request.timeoutMs);
  try {
    const response = await openHttp(request);
    response.close();
  } catch (error) {
    assert.ok(error instanceof ProviderTransportError, String(error));
    return [error, performance.now() - start, schedulerLag];
  } finally { clearTimeout(deadline); }
  throw new Error("expected a transport failure");
}

describe("the idle timeout", () => {
  it("fails a stalled TLS handshake after one timeout", async () => {
    behavior = () => undefined;
    const [error, elapsed, schedulerLag] = await failure(spec("https", 300));
    assert.deepEqual([error.category, error.exceptionType], ["timeout", "URLError"]);
    assert.ok(elapsed >= 300 && elapsed < 540 + schedulerLag, `waited ${elapsed} ms`);
  });

  it("fails a stalled upload after one timeout, as urllib's URLError", async () => {
    behavior = (socket) => socket.pause();
    const [error, elapsed, schedulerLag] = await failure(spec("http", 250, Buffer.alloc(32 << 20, 0x20)));
    assert.deepEqual([error.category, error.exceptionType], ["timeout", "URLError"]);
    assert.ok(elapsed >= 250 && elapsed < 500 + schedulerLag, `waited ${elapsed} ms`);
  });

  it("bounds the whole upload by one timeout, even while it progresses, like sendall", async () => {
    behavior = (socket) => {
      let burst = 0;
      socket.on("data", (chunk: Buffer) => {
        burst += chunk.length;
        if (burst < 2 << 20) return;
        burst = 0;
        socket.pause();
        setTimeout(() => socket.resume(), 100);
      });
    };
    const [error, elapsed, schedulerLag] = await failure(spec("http", 150, Buffer.alloc(32 << 20, 0x20)));
    assert.deepEqual([error.category, error.exceptionType], ["timeout", "URLError"]);
    assert.ok(elapsed >= 150 && elapsed < 300 + schedulerLag, `waited ${elapsed} ms`);
  });

  it("does not extend the upload's period for data arriving meanwhile", async () => {
    // urllib is still in `sendall`, not reading: the trickle is no progress.
    behavior = (socket) => socket.once("data", () => {
      socket.pause();
      socket.write("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n");
      const trickle = setInterval(() => socket.write("x"), 40);
      setTimeout(() => clearInterval(trickle), 600);
      socket.once("close", () => clearInterval(trickle));
    });
    const [error, elapsed, schedulerLag] = await failure(spec("http", 200, Buffer.alloc(32 << 20, 0x20)));
    assert.deepEqual([error.category, error.exceptionType], ["timeout", "URLError"]);
    assert.ok(elapsed >= 200 && elapsed < 400 + schedulerLag, `waited ${elapsed} ms`);
  });

  it("reads an early response only once the request is out, like urllib", async () => {
    const early = "HTTP/1.1 413 Payload Too Large\r\nContent-Length: 2\r\nConnection: close\r\n\r\nno";
    // The server answers and closes with the body unread: the upload is reset.
    behavior = (socket) => socket.once("data", () => socket.write(early, () => socket.destroy()));
    const [error] = await failure(spec("http", 2000, Buffer.alloc(32 << 20, 0x20)));
    assert.deepEqual([error.category, error.exceptionType], ["connection_failed", "URLError"]);
    // The server answers but reads the whole body: the response follows the upload.
    behavior = (socket) => socket.once("data", () => {
      socket.write(early);
      socket.on("data", () => undefined);
    });
    const response = await openHttp(spec("http", 2000, Buffer.alloc(32 << 20, 0x20)));
    assert.equal(response.status, 413);
    assert.equal((await readBody(response)).toString("utf8"), "no");
    response.close();
  });

  it("does not count the time the consumer spends between reads", async () => {
    behavior = (socket) => onRequest(socket, () => {
      socket.write("HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nhello");
      setTimeout(() => socket.end("world"), 400);
    });
    const response = await openHttp(spec("http", 200));
    try {
      assert.equal((await response.read(5)).toString("utf8"), "hello");
      await delay(300);
      assert.equal((await response.read(5)).toString("utf8"), "world", "a 100 ms wait for data");
    } finally {
      response.close();
    }
  });
});
