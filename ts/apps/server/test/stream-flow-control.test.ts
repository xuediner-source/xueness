import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { it } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { sendStream } from "../src/stream-response.ts";

class Response extends EventEmitter {
  socket = Object.assign(new EventEmitter(), { writableNeedDrain: false, destroyed: false });
  writableNeedDrain = false;
  destroyed = false;
  statusCode = 0;
  shouldKeepAlive = true;
  writes = 0;
  exposeResponsePressure = true;
  setHeader(): void {}
  removeHeader(): void {}
  flushHeaders(): void {}
  end(): void {}
  write(): boolean { this.writes++; this.writableNeedDrain = this.exposeResponsePressure; return false; }
}

function fixture() {
  const response = new Response(), controller = new AbortController();
  let finalized = false;
  async function* body() { try { for (let i = 0; i < 8; i++) yield Buffer.from(`data: ${i}\n\n`); } finally { finalized = true; } }
  const done = sendStream(response as unknown as ServerResponse, 200, body(), "text/event-stream", controller.signal);
  return { response, done, async close() {
    controller.abort(); await done;
    assert.equal(finalized, true);
    for (const emitter of [response, response.socket]) {
      assert.equal(emitter.listenerCount("drain"), 0);
      assert.equal(emitter.listenerCount("close"), 0);
      assert.equal(emitter.listenerCount("error"), 0);
    }
  } };
}

it("waits for response drain even when the socket reports no pressure", async () => {
  const f = fixture();
  try {
    await turn();
    assert.equal(f.response.writes, 1, "response backpressure must stop the producer");
    f.response.writableNeedDrain = false;
    f.response.emit("drain");
    await turn();
    assert.equal(f.response.writes, 2, "the next chunk requires an actual drain");
  } finally { await f.close(); }
});

it("waits until both response and socket pressure have cleared", async () => {
  const f = fixture();
  try {
    await turn();
    f.response.socket.writableNeedDrain = true;
    f.response.emit("drain");
    await turn();
    assert.equal(f.response.writes, 1);
    f.response.socket.writableNeedDrain = false;
    f.response.socket.emit("drain");
    await turn();
    assert.equal(f.response.writes, 1, "socket drain cannot discard response pressure");
    f.response.writableNeedDrain = false;
    f.response.emit("drain");
    await turn();
    assert.equal(f.response.writes, 2);
  } finally { await f.close(); }
});

it("requires a drain after a false write even when wrappers expose no pressure flag", async () => {
  const f = fixture();
  f.response.exposeResponsePressure = false;
  try {
    await turn();
    assert.equal(f.response.writes, 1);
    f.response.emit("drain");
    await turn();
    assert.equal(f.response.writes, 2);
  } finally { await f.close(); }
});
