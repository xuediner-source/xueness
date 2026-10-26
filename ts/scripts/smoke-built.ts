import { mkdtempSync } from "../test-support/canonical-temp.ts";
/** Exercise the compiled runtime after relocation, with no source workspace links. */
import assert from "node:assert/strict";
import { cpSync, existsSync, realpathSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "dist");
assert(existsSync(join(source, ".xueness-generated-build")), "run npm run build first");
const temporary = mkdtempSync(join(tmpdir(), "xueness-built-"));
const copied = join(temporary, "runtime");
const script = `
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApplicationApi } from "./apps/server/src/application-api.js";
import { createFrontDoor } from "./apps/server/src/front-door.js";
import { BUNDLED_PLUGIN_IDS } from "@xueness/contracts";
const runtime = process.cwd(), projectRoot = process.env.SMOKE_PROJECT;
for (const pkg of ["sessions", "agent", "plugin-sessions", "plugin-providers"]) {
  const target = realpathSync(fileURLToPath(import.meta.resolve("@xueness/" + pkg)));
  assert(target.startsWith(runtime), "workspace escaped relocated runtime: " + target);
}
const state = join(process.env.SMOKE_BASE, "state"), runs = join(process.env.SMOKE_BASE, "runs");
let api, server;
try {
  api = await createApplicationApi({ projectRoot, stateDir: state, webRuns: runs, allowReal: false });
  server = createFrontDoor({ webappDir: join(projectRoot, "webapp", "dist"), api });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const origin = "http://127.0.0.1:" + server.address().port;
  assert.equal((await fetch(origin + "/")).status, 200);
  const response = await fetch(origin + "/api/sessions", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": api.csrfToken }, body: JSON.stringify({ task: "Relocated runtime check", root: runs }) });
  assert.equal(response.status, 200, await response.clone().text());
  const session = await response.json(); assert.match(session.id, /^[0-9a-f]{32}$/);
  const history = await fetch(origin + "/api/sessions/" + session.id + "/history");
  assert.equal(history.status, 200);
  assert.equal((await (await fetch(origin + "/api/health")).json()).service, "xueness-web");
  assert.equal((await fetch(origin + "/api/no-such-route")).status, 404);
  // The catalog lives beside the build, not beside the materialized package:
  // resolving it by a fixed depth from node_modules used to 500 here.
  const catalog = await (await fetch(origin + "/api/plugins")).json();
  assert.deepEqual(catalog.plugins.map(p => p.id).sort(), [...BUNDLED_PLUGIN_IDS].sort(), "relocated build must resolve the bundled catalog");
  console.log("Relocated JS/runtime: static UI, native session/history, plugin catalog, health and unowned-route 404 passed.");
} finally {
  if (server) { server.closeAllConnections(); await new Promise((ready) => server.close(ready)); }
  await api?.close();
}
`;
try {
  cpSync(source, copied, { recursive: true });
  execFileSync(join(copied, "runtime", process.platform === "win32" ? "node.exe" : "node"), ["--input-type=module", "-e", script], {
    cwd: copied, env: { ...process.env, PATH: "", SMOKE_PROJECT: resolve(root, ".."), SMOKE_BASE: temporary },
    windowsHide: true, timeout: 60_000, stdio: "inherit",
  });
} finally {
  const target = realpathSync.native(temporary);
  assert(relative(realpathSync.native(tmpdir()), target).startsWith("xueness-built-"), "unexpected cleanup path");
  rmSync(target, { recursive: true, force: true });
}
