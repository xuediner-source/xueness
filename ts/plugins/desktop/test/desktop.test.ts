/** Desktop owns only the routes it implements, and host tickets are single-use. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createDesktopHttp } from "../src/index.ts";

type SyncReply = [number, unknown, string?] | null;
/** These routes answer synchronously; only a desktop permission bridge may reply later. */
function syncDesktop(http: ReturnType<typeof createDesktopHttp>) {
  return { ...http, dispatch(...args: Parameters<typeof http.dispatch>): SyncReply {
    const reply = http.dispatch(...args);
    assert.ok(!(reply instanceof Promise), "answered synchronously");
    return reply as SyncReply;
  } };
}

describe("desktop", () => {
  it("serves status and tray without taking workspaces", () => {
    const root = mkdtempSync(`${tmpdir()}\\xueness-desktop-`);
    const web = join(root, "web");
    mkdirSync(web);
    writeFileSync(join(web, "tray.html"), "<p>tray</p>");
    const http = syncDesktop(createDesktopHttp({ stateDir: join(root, "state"), enabled: true, desktopToken: "token", webappDir: web, version: "0.2.1" }));
    try {
      assert.equal(http.owns("GET", ["api", "desktop", "workspaces"]), false);
      assert.equal(http.owns("GET", ["api", "workspaces"]), false);
      assert.equal(http.dispatch("GET", ["api", "workspaces"], {}, null), null);
      const status = http.dispatch("GET", ["api", "desktop", "status"], {}, null);
      assert.equal(status?.[0], 200);
      assert.equal((status?.[1] as { desktop: boolean; version: string }).desktop, true);
      assert.equal((status?.[1] as { version: string }).version, "0.2.1");
      const missing = syncDesktop(createDesktopHttp({ stateDir: join(root, "state"), enabled: true, webappDir: web })).dispatch("GET", ["api", "desktop", "tray"], {}, null);
      assert.deepEqual(missing, [403, { error: "desktop host required" }]);
      const tray = http.dispatch("GET", ["api", "desktop", "tray"], {}, null);
      assert.equal(tray?.[0], 200);
      assert.equal(tray?.[2], "text/html; charset=utf-8");
      assert.equal(Buffer.from(tray?.[1] as Buffer).toString("utf8"), "<p>tray</p>");
      const permissions = syncDesktop(createDesktopHttp({ stateDir: join(root, "state"), enabled: true })).dispatch("GET", ["api", "desktop", "permissions"], {}, null);
      assert.equal(permissions?.[0], 200);
      assert.equal((permissions?.[1] as { permissions: { status: string }[] }).permissions[0]?.status, "unsupported");
      const denied = syncDesktop(createDesktopHttp({ stateDir: join(root, "state"), enabled: false, desktopToken: "token" })).dispatch("GET", ["api", "desktop", "status"], {}, null);
      assert.deepEqual(denied, [403, { error: "plugin disabled or dependency unavailable: desktop", plugin: "desktop" }]);
      assert.equal(denied !== null && Object.hasOwn(denied[1] as object, "code"), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("issues a ticket only when the setting is true and rejects a replay", () => {
    const state = mkdtempSync(`${tmpdir()}\\xueness-desktop-cap-`);
    writeFileSync(join(state, "settings.json"), JSON.stringify({ general: { desktopHostCapabilityEnabled: false } }));
    const off = syncDesktop(createDesktopHttp({ stateDir: state, enabled: true, desktopToken: "token" }));
    assert.equal(off.dispatch("POST", ["api", "desktop", "host-capability"], {}, {})?.[0], 400);
    writeFileSync(join(state, "settings.json"), JSON.stringify({ general: { desktopHostCapabilityEnabled: true } }));
    const on = syncDesktop(createDesktopHttp({ stateDir: state, enabled: true, desktopToken: "token", now: () => 1_000 }));
    const issued = on.dispatch("POST", ["api", "desktop", "host-capability"], {}, {});
    assert.equal(issued?.[0], 200);
    const capability = (issued?.[1] as { capability: string }).capability;
    assert.equal(on.dispatch("POST", ["api", "desktop", "host-capability", "consume"], {}, { capability })?.[0], 200);
    assert.equal(on.dispatch("POST", ["api", "desktop", "host-capability", "consume"], {}, { capability })?.[0], 401);
    rmSync(state, { recursive: true, force: true });
  });
});
