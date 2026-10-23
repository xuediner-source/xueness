/**
 * The standalone front door (round 10): with no backend behind it, it serves
 * the UI bundle, answers its own core routes, guards every API write and
 * answers routes nobody owns with 404.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createFrontDoor, STATUS_PATH, type FrontDoor } from "../src/front-door.ts";

describe("standalone front door", () => {
  const base = mkdtempSync(join(tmpdir(), "xue-front-door-")), seen: string[] = [];
  const json = { "Content-Type": "application/json" }, csrf = { ...json, "X-CSRF-Token": "fixture-token" };
  let door: FrontDoor, origin = "";
  before(async () => {
    mkdirSync(join(base, "assets"));
    writeFileSync(join(base, "index.html"), "<!doctype html><title>Xueness</title>");
    writeFileSync(join(base, "assets", "app.js"), "export {};\n");
    door = createFrontDoor({ webappDir: base, api: { csrfToken: "fixture-token", owns: (_method, parts) => parts[1] === "owned",
      async dispatch(method, parts) { seen.push(`${method} /${parts.join("/")}`); return [200, { ok: true, method }]; } } });
    await new Promise<void>((resolve) => door.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(door.address() as { port: number }).port}`;
  });
  after(async () => {
    door.closeAllConnections(); await new Promise<void>((resolve) => door.close(() => resolve()));
    rmSync(base, { recursive: true, force: true });
  });

  it("serves the UI bundle and its assets", async () => {
    const index = await fetch(origin + "/");
    assert.equal(index.status, 200); assert.match(index.headers.get("content-type") ?? "", /text\/html/); assert.match(await index.text(), /Xueness/);
    assert.equal((await fetch(origin + "/assets/app.js")).status, 200);
  });

  it("answers csrf and health itself", async () => {
    assert.deepEqual(await (await fetch(origin + "/api/csrf")).json(), { csrfToken: "fixture-token" });
    for (const path of ["/api/health", "/healthz"]) assert.deepEqual(await (await fetch(origin + path)).json(), { ok: true, service: "xueness-web" });
  });

  it("requires CSRF on every API write, owned or not", async () => {
    for (const path of ["/api/owned/thing", "/api/elsewhere"]) {
      const refused = await fetch(origin + path, { method: "POST", headers: json, body: "{}" });
      assert.equal(refused.status, 403, path); assert.equal(((await refused.json()) as Record<string, unknown>).code, "csrf_required");
    }
    const written = await fetch(origin + "/api/owned/thing", { method: "POST", headers: csrf, body: "{}" });
    assert.equal(written.status, 200); assert.deepEqual(await written.json(), { ok: true, method: "POST" });
  });

  it("answers routes nobody owns with 404 instead of relaying them", async () => {
    const read = await fetch(origin + "/api/elsewhere");
    assert.equal(read.status, 404); assert.deepEqual(await read.json(), { error: "not found", code: "not_found", status: 404 });
    const write = await fetch(origin + "/api/elsewhere", { method: "POST", headers: csrf, body: JSON.stringify({ large: "x".repeat(4096) }) });
    assert.equal(write.status, 404); assert.equal(((await write.json()) as Record<string, unknown>).code, "not_found");
    assert.deepEqual(seen, ["POST /api/owned/thing"]);
  });

  it("refuses foreign hosts and reports itself as the only backend", async () => {
    const foreign = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(origin + "/api/health", { headers: { Host: "evil.example" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", reject); req.end();
    });
    assert.equal(foreign, 403);
    const status = await (await fetch(origin + STATUS_PATH)).json() as Record<string, any>;
    assert.equal(status.service, "xueness-front-door"); assert.equal(status.backend.kind, "ts"); assert.equal(status.backend.pid, process.pid);
    assert.equal("proxied" in status.requests, false);
  });
});
