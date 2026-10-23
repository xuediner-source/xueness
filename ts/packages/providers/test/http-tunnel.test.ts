/**
 * HTTPS through an environment proxy: like urllib's `set_tunnel`, a CONNECT
 * tunnel carries the TLS handshake, credentials go only to the proxy, and
 * timeouts and failures keep their Python families. No Python oracle: the
 * provider oracles run with proxy variables cleared.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import tls from "node:tls";
import { ProviderTransportError, openHttp, pyUrlSplit, readBody, type HttpRequestSpec } from "../src/index.ts";

const NO_OPENSSL = spawnSync("openssl", ["version"]).error ? "needs the openssl command" : null;

interface Seen {
  head: string;
  tunneled: Buffer;
}

let mode: "refuse" | "silent" | "established" | "pipe" = "silent";
const seen: Seen[] = [];
const sockets = new Set<net.Socket>();
const proxy = net.createServer((socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => undefined);
  let record: Seen | null = null;
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    if (record) {
      record.tunneled = Buffer.concat([record.tunneled, chunk]);
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    record = { head: buffer.subarray(0, end).toString("latin1"), tunneled: buffer.subarray(end + 4) };
    seen.push(record);
    if (mode === "refuse") socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n");
    else if (mode === "established") socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
    else if (mode === "pipe") {
      // Whatever the CONNECT target, the tunnel leads to the local TLS origin.
      const upstream = net.connect(originPort, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
        upstream.write(record?.tunneled ?? Buffer.alloc(0));
        socket.removeAllListeners("data");
        socket.pipe(upstream).pipe(socket);
      });
      upstream.on("error", () => socket.destroy());
    }
  });
});

/** The origin behind the tunnel, with a throwaway certificate for api.example.test. */
let origin: https.Server | null = null;
let originPort = 0;
const originRequests: { headers: Record<string, unknown>; body: string; servername: unknown }[] = [];

let port = 0;
before(async () => {
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  port = (proxy.address() as net.AddressInfo).port;
  if (NO_OPENSSL) return;
  const dir = mkdtempSync(join(tmpdir(), "xueness-tunnel-"));
  try {
    const made = spawnSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
      "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "2", "-subj", "/CN=api.example.test",
      "-addext", "subjectAltName=DNS:api.example.test"], { stdio: "ignore" });
    assert.equal(made.status, 0, "openssl made a certificate");
    const [key, cert] = [readFileSync(join(dir, "key.pem"), "utf8"), readFileSync(join(dir, "cert.pem"), "utf8")];
    // Before the first handshake: the adapter caches the trusted roots.
    tls.setDefaultCACertificates([...tls.getCACertificates("default"), cert]);
    origin = https.createServer({ key, cert }, (req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      req.on("end", () => {
        originRequests.push({ headers: req.headers, body, servername: (req.socket as tls.TLSSocket).servername });
        res.writeHead(200, { "Content-Type": "application/json" }).end("{\"ok\":true}");
      });
    });
    await new Promise<void>((resolve) => origin?.listen(0, "127.0.0.1", resolve));
    originPort = (origin.address() as net.AddressInfo).port;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
after(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  origin?.closeAllConnections();
  await new Promise<void>((resolve) => (origin ? origin.close(() => resolve()) : resolve()));
});

const spec = (timeoutMs: number, authorization: string | null = null): HttpRequestSpec => ({
  url: pyUrlSplit("https://api.example.test/v1/chat/completions"), method: "POST",
  headers: { "Content-Type": "application/json" }, body: Buffer.from("{}"), timeoutMs,
  proxy: { host: "127.0.0.1", port, authorization },
});

async function failure(request: HttpRequestSpec): Promise<[ProviderTransportError, number]> {
  const start = performance.now();
  try {
    const response = await openHttp(request);
    response.close();
  } catch (error) {
    assert.ok(error instanceof ProviderTransportError, String(error));
    return [error, performance.now() - start];
  }
  throw new Error("expected a transport failure");
}

describe("HTTPS through a proxy", () => {
  it("carries the whole HTTPS exchange through the tunnel", { skip: NO_OPENSSL ?? false }, async () => {
    mode = "pipe";
    seen.length = 0;
    const response = await openHttp(spec(5000, "Basic dTpw"));
    assert.equal(response.status, 200);
    assert.equal((await readBody(response)).toString("utf8"), "{\"ok\":true}");
    response.close();
    assert.equal(seen[0]?.head.split("\r\n")[0], "CONNECT api.example.test:443 HTTP/1.1");
    const [request] = originRequests;
    assert.deepEqual([request?.servername, request?.headers["host"], request?.body], ["api.example.test", "api.example.test", "{}"]);
    assert.equal(request?.headers["proxy-authorization"], undefined, "proxy credentials never reach the origin");
  });

  it("builds one TLS context for every request", { skip: NO_OPENSSL ?? false }, async () => {
    // Passing `ca` per request made Node parse every root each time (~25 ms, blocking).
    mode = "pipe";
    const patched = tls as { createSecureContext: typeof tls.createSecureContext };
    const original = patched.createSecureContext;
    let built = 0;
    patched.createSecureContext = (options) => {
      built += 1;
      return original(options);
    };
    try {
      for (let round = 0; round < 3; round += 1) {
        const response = await openHttp(spec(5000));
        assert.equal((await readBody(response)).toString("utf8"), "{\"ok\":true}");
        response.close();
      }
    } finally {
      patched.createSecureContext = original;
    }
    assert.ok(built <= 1, `built ${built} TLS contexts for 3 requests`);
  });

  it("sends CONNECT for the target, with the credentials only on the tunnel request", async () => {
    mode = "refuse";
    seen.length = 0;
    const [error] = await failure(spec(2000, "Basic dTpw"));
    assert.deepEqual([error.category, error.exceptionType], ["connection_failed", "URLError"]);
    const lines = (seen[0]?.head ?? "").split("\r\n");
    assert.equal(lines[0], "CONNECT api.example.test:443 HTTP/1.1");
    assert.ok(lines.includes("Host: api.example.test:443"));
    assert.ok(lines.includes("Proxy-Authorization: Basic dTpw"));
    assert.equal(seen[0]?.tunneled.length, 0, "nothing is sent after a refused CONNECT");
  });

  it("times out a proxy that never answers CONNECT as a connect-phase timeout", async () => {
    mode = "silent";
    seen.length = 0;
    const [error, elapsed] = await failure(spec(150));
    assert.deepEqual([error.category, error.exceptionType], ["timeout", "URLError"]);
    assert.ok(elapsed >= 150, `waited ${elapsed} ms`);
  });

  it("runs the TLS handshake inside the tunnel, still bounded by the idle timeout", async () => {
    mode = "established";
    seen.length = 0;
    const [error, elapsed] = await failure(spec(200));
    assert.deepEqual([error.category, error.exceptionType], ["timeout", "URLError"]);
    assert.ok(elapsed >= 200, `waited ${elapsed} ms`);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.tunneled[0], 0x16, "a TLS handshake record arrived through the tunnel");
  });
});
