import assert from "node:assert/strict";
import { get } from "node:http";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createFrontDoor } from "../src/front-door.ts";
it("delivers incremental native SSE and cancels its generator on client disconnect", async () => {
  let observed = "", signal: AbortSignal | undefined, finalized = false;
  const server = createFrontDoor({ webappDir: ".", api: { csrfToken: "fixture", owns: () => true,
    async dispatch(_method, _parts, _query, _data, request) {
      observed = request?.lastEventId ?? ""; signal = request?.signal;
      async function* stream() {
        try { yield Buffer.from("event: ready\ndata: first\n\n"); await delay(60000, undefined, { signal }); yield Buffer.from("data: unexpected\n\n"); }
        catch (error) { if (!signal?.aborted) throw error; }
        finally { finalized = true; }
      }
      return [200, stream(), "text/event-stream"];
    } } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await new Promise<void>((resolve, reject) => {
      const req = get(`http://127.0.0.1:${port}/api/native`, { headers: { "Last-Event-ID": "session:7" } }, (res) => {
        assert.equal(res.headers["content-type"], "text/event-stream"); assert.equal(res.headers["content-length"], undefined); assert.equal(res.headers["cache-control"], "no-store");
        res.once("data", (chunk) => { assert.equal(chunk.toString(), "event: ready\ndata: first\n\n"); res.destroy(); req.destroy(); resolve(); });
      }); req.on("error", reject); req.setTimeout(3000, () => req.destroy(new Error("no incremental response")));
    });
    for (let i = 0; i < 50 && !finalized; i++) await delay(10);
    assert.equal(observed, "session:7"); assert.equal(signal?.aborted, true); assert.equal(finalized, true);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
it("does not overproduce streamed bytes while the client applies backpressure", async () => {
  let produced = 0, finalized = false;
  const server = createFrontDoor({ webappDir: ".", api: { csrfToken: "fixture", owns: () => true,
    async dispatch(_m, _p, _q, _d, request) {
      async function* stream() { try { for (let i = 0; i < 128 && !request?.signal?.aborted; i++) { produced++; yield Buffer.alloc(1024 * 1024, 65); } } finally { finalized = true; } }
      return [200, stream(), "application/octet-stream"];
    } } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await new Promise<void>((resolve, reject) => {
      const req = get(`http://127.0.0.1:${(server.address() as { port: number }).port}/stream`, (res) => {
        res.pause(); setTimeout(() => { try { assert(produced < 128, "producer ignored transport backpressure"); res.destroy(); req.destroy(); resolve(); } catch (e) { reject(e); } }, 80);
      }); req.on("error", reject);
    });
    for (let i = 0; i < 50 && !finalized; i++) await delay(10); assert.equal(finalized, true);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
