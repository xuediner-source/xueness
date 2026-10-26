import { mkdtempSync } from "../test-support/canonical-temp.ts";
/** Verify the installed layout, not only the pre-installer dist directory. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { BUNDLED_PLUGIN_IDS } from "@xueness/contracts";
const require = createRequire(import.meta.url);
const { Backend } = require("../../desktop/src/backend.cjs");
const { frontDoorCommand } = require("../../desktop/src/front-door.cjs");
const project = resolve(import.meta.dirname, "../.."), resources = resolve(process.argv[2] ?? join(project, "desktop/release/win-unpacked/resources"));
assert(existsSync(join(resources, "backend-ts/node_modules/@xueness/contracts/package.json")), "installer omitted TS production dependencies");
const data = mkdtempSync(join(tmpdir(), "xueness-installed-ts-"));
const priorPath = process.env.PATH, priorReal = process.env.XUENESS_ALLOW_REAL;
process.env.PATH = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32") : "/usr/bin:/bin";
process.env.XUENESS_ALLOW_REAL = "0";
assert(!existsSync(join(resources, "backend")), "installer still carries the removed Python backend");
const command = frontDoorCommand({ env: {}, packaged: true, resourcesPath: resources, assets: join(resources, "webapp"), root: project });
const backend = new Backend({ ...command, cwd: data, data, assets: join(resources, "webapp"), node: process.execPath, playwright: "" });
let diagnostic = "";
try {
  const pending = backend.start(); backend.child.stderr.on("data", (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-4000); });
  const origin = await pending;
  const headers = { "X-Xueness-Desktop-Token": backend.token, "Content-Type": "application/json" };
  const csrf = await (await fetch(origin + "/api/csrf", { headers })).json() as { csrfToken: string };
  const auth = { ...headers, "X-CSRF-Token": csrf.csrfToken };
  const stats = async () => (await (await fetch(origin + "/api/front-door/status", { headers })).json()) as { backend: { kind: string }; routes: { ts: string[] } };
  const request = async (path: string, method = "GET", value?: unknown) => {
    const response = await fetch(origin + path, { method, headers: auth, ...(value !== undefined ? { body: JSON.stringify(value) } : {}) });
    assert.equal(response.status, 200, await response.clone().text()); return response.json() as Promise<Record<string, any>>;
  };
  const root = join(data, "workspace"); mkdirSync(root, { recursive: true });
  const session = await request("/api/sessions", "POST", { task: "Installed runtime check", root });
  await request(`/api/sessions/${session.id}/history`);
  const upload = await request("/api/composer/attachments/begin", "POST", { root, session_id: session.id, origin: "file", name: "readme.txt", mimeType: "text/plain", size: 2 });
  await request("/api/composer/attachments/commit", "POST", { root, session_id: session.id, id: upload.ref.id, data: "b2s=" });
  const preview = await request("/api/composer/attachments/preview", "POST", { root, session_id: session.id, id: upload.ref.id }); assert.equal(preview.preview.text, "ok");
  const catalog = await request("/api/plugins"); assert.deepEqual(catalog.plugins.map((p: { id: string }) => p.id).sort(), [...BUNDLED_PLUGIN_IDS].sort(), "installed layout must resolve the bundled catalog");
  const after = await stats(); assert.equal(after.backend.kind, "ts");
  if (process.argv[3]) writeFileSync(resolve(process.argv[3]), JSON.stringify({ routes: after.routes.ts, nativeRequestsVerified: 5, isolatedState: true, bundledRuntime: true }, null, 2) + "\n");
  console.log("Packaged bundled Node: native session/history/media, desktop guards, private locks and isolated startup passed.");
} catch (error) { if (diagnostic) process.stderr.write(diagnostic); throw error; }
finally {
  await backend.stop();
  if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
  if (priorReal === undefined) delete process.env.XUENESS_ALLOW_REAL; else process.env.XUENESS_ALLOW_REAL = priorReal;
  assert(relative(realpathSync(tmpdir()), realpathSync(data)).startsWith("xueness-installed-ts-")); rmSync(data, { recursive: true, force: true });
}
