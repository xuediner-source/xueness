/**
 * The TS desktop host (round 10): the parent token, the `ready` line, the
 * window-owned folder dialog relayed over stdio by id, and `shutdown`.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { after, describe, it } from "node:test";
import { DesktopBridge, runDesktopHost } from "../src/desktop-host.ts";

const TOKEN = "a".repeat(64);
type Row = Record<string, any>;

/** The JSON lines a host writes, read in order. */
function lines(stream: PassThrough): () => Promise<Row> {
  const queue: Row[] = [], waiting: ((row: Row) => void)[] = [];
  createInterface({ input: stream }).on("line", (line) => {
    const row = JSON.parse(line) as Row, next = waiting.shift();
    if (next) next(row); else queue.push(row);
  });
  return () => queue.length ? Promise.resolve(queue.shift()!) : new Promise((resolve) => waiting.push(resolve));
}

describe("desktop host", () => {
  const base = mkdtempSync(join(tmpdir(), "xue-desktop-host-"));
  after(() => rmSync(base, { recursive: true, force: true }));

  it("refuses to start without the desktop parent token", async () => {
    await assert.rejects(runDesktopHost({ argv: ["--data", join(base, "refused")], env: {}, input: new PassThrough(), output: new PassThrough() }),
      /desktop parent authentication is missing/);
  });

  it("matches dialog and feature replies by id and fails pending requests on close", async () => {
    const output = new PassThrough(), next = lines(output), bridge = new DesktopBridge(output);
    const chosen = bridge.chooseDirectory("/start");
    const dialog = await next();
    assert.equal(dialog.type, "dialog"); assert.equal(dialog.initialRoot, "/start"); assert.match(dialog.id, /^[0-9a-f]{32}$/);
    bridge.receive({ id: "unknown", path: "/elsewhere" });
    bridge.receive({ id: dialog.id, path: "/picked" });
    assert.equal(await chosen, "/picked");
    const update = bridge.request({ type: "update", action: "status" });
    const sent = await next();
    assert.equal(sent.type, "update"); assert.equal(sent.action, "status");
    bridge.receive({ id: sent.id, ok: true });
    assert.deepEqual(await update, { id: sent.id, ok: true });
    const pending = bridge.chooseDirectory(null); await next();
    bridge.close();
    await assert.rejects(pending, /desktop directory picker failed/);
    await assert.rejects(bridge.request({ type: "permissions" }), /disconnected/);
  });

  it("serves the API behind the token, relays the folder picker and stops on shutdown", async () => {
    const input = new PassThrough(), output = new PassThrough(), next = lines(output);
    const env: NodeJS.ProcessEnv = { XUENESS_DESKTOP_TOKEN: TOKEN, XUENESS_ALLOW_REAL: "0" };
    const picked = join(base, "picked-folder"); mkdirSync(picked);
    const running = runDesktopHost({ argv: ["--data", join(base, "data")], env, input, output });
    const ready = await next();
    assert.equal(ready.type, "ready"); assert.match(ready.url, /^http:\/\/127\.0\.0\.1:\d+$/); assert.match(ready.instance, /^[0-9a-f]{32}$/);
    assert.equal(env.XUENESS_DESKTOP_TOKEN, undefined, "the parent token is popped");
    assert.equal(env.XUENESS_DESKTOP_OWNER_PID, String(process.pid));
    const refused = await fetch(ready.url + "/api/desktop/status");
    assert.equal(refused.status, 403); assert.equal(((await refused.json()) as Row).code, "desktop_auth_required");
    const headers = { "X-Xueness-Desktop-Token": TOKEN, "Content-Type": "application/json" };
    const status = await (await fetch(ready.url + "/api/desktop/status", { headers })).json() as Row;
    assert.equal(status.desktop, true); assert.equal(status.nativeDirectoryPicker, true);
    const { csrfToken } = await (await fetch(ready.url + "/api/csrf", { headers })).json() as Row;
    const choosing = fetch(ready.url + "/api/workspaces/native-picker", { method: "POST", headers: { ...headers, "X-CSRF-Token": csrfToken }, body: "{}" });
    const dialog = await next();
    assert.equal(dialog.type, "dialog");
    input.write(JSON.stringify({ id: dialog.id, path: picked }) + "\n");
    const reply = await choosing, body = await reply.json();
    assert.equal(reply.status, 200, JSON.stringify(body)); assert.ok(JSON.stringify(body).includes(basename(picked)), JSON.stringify(body));
    input.write(JSON.stringify({ type: "shutdown" }) + "\n");
    assert.equal(await running, 0);
    await assert.rejects(fetch(ready.url + "/api/health", { headers }));
  });
});
