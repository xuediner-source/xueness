/**
 * Request-head time limits (`_HEADER_IDLE_SECONDS`, `_HEADER_DEADLINE_SECONDS`):
 * a silent connection is closed without an answer, a started head gets 408,
 * and the limits and token change live.
 */
import assert from "node:assert/strict";
import { connect, type AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { createFrontDoor, STATUS_PATH, type FrontDoor } from "../src/index.ts";

interface Exchange {
  data: string;
  closedAfterMs: number;
}

/** Send `chunks`, then read until the front door closes the connection. */
function exchange(port: number, chunks: string[], openForMs = 3000): Promise<Exchange> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const socket = connect(port, "127.0.0.1", () => chunks.forEach((chunk) => socket.write(chunk)));
    let data = "";
    socket.setEncoding("latin1");
    socket.on("data", (chunk: string) => void (data += chunk));
    socket.on("error", reject);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`still open after ${openForMs} ms: ${JSON.stringify(data)}`));
    }, openForMs);
    socket.on("close", () => {
      clearTimeout(timer);
      resolve({ data, closedAfterMs: Date.now() - started });
    });
  });
}

const statusRequest = `GET ${STATUS_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`;

describe("request-head time limits", () => {
  let door: FrontDoor;
  let port = 0;

  before(async () => {
    door = createFrontDoor({
      webappDir: "/nonexistent",
      headerIdleMs: 300, headerDeadlineMs: 250, connectionsCheckingIntervalMs: 25,
    });
    await new Promise<void>((resolve) => door.listen(0, "127.0.0.1", resolve));
    port = (door.address() as AddressInfo).port;
  });

  after(async () => {
    door.closeAllConnections();
    await new Promise<void>((resolve) => door.close(() => resolve()));
  });

  it("closes a connection that sends nothing without an answer", async () => {
    const { data, closedAfterMs } = await exchange(port, []);
    assert.equal(data, "");
    assert.ok(closedAfterMs >= 200 && closedAfterMs < 1500, `closed after ${closedAfterMs} ms`);
  });

  it("answers 408 to a head that stops halfway, without a Connection line", async () => {
    const { data, closedAfterMs } = await exchange(port, [`GET ${STATUS_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\n`]);
    const [head, body] = data.split("\r\n\r\n") as [string, string];
    assert.match(head, /^HTTP\/1\.1 408 Request Timeout\r\n/);
    assert.doesNotMatch(head, /\r\nConnection:/i);
    assert.deepEqual(JSON.parse(body), { error: "request timed out", code: "request_timeout", status: 408 });
    assert.ok(closedAfterMs < 1500, `closed after ${closedAfterMs} ms`);
  });

  it("closes a kept-alive connection silently once its next head does not come", async () => {
    const { data } = await exchange(port, [statusRequest]);
    assert.equal(data.match(/HTTP\/1\.1 /g)?.length, 1);
    assert.match(data, /^HTTP\/1\.1 200 OK\r\n/);
  });

  it("applies new limits and a desktop token to the next connection", async () => {
    door.configure({ headerIdleMs: 5000, headerDeadlineMs: 5000 });
    await assert.rejects(exchange(port, [], 600), /still open after 600 ms/);
    door.configure({ desktopToken: "desk-token", headerIdleMs: 300, headerDeadlineMs: 250 });
    try {
      const refused = await exchange(port, [statusRequest]);
      assert.match(refused.data, /^HTTP\/1\.1 403 Forbidden\r\n/);
      assert.match(refused.data, /"code": "desktop_auth_required"/);
      const allowed = await exchange(port, [`GET ${STATUS_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Xueness-Desktop-Token: desk-token\r\n\r\n`]);
      assert.match(allowed.data, /^HTTP\/1\.1 200 OK\r\n/);
    } finally {
      door.configure({ desktopToken: null });
    }
    assert.throws(() => door.configure({ headerIdleMs: 0 }), RangeError);
  });

  it("counts what it answered and what it closed", () => {
    const stats = door.stats();
    assert.ok(stats.ts >= 3, JSON.stringify(stats));
    assert.ok(stats.protocolErrors >= 1, JSON.stringify(stats));
    assert.ok(stats.silentCloses >= 3, JSON.stringify(stats));
  });
});
