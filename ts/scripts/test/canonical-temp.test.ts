import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync as create, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { mkdtemp, mkdtempSync } from "../../test-support/canonical-temp.ts";

it("creates sync and async fixtures with canonical paths through a parent alias", async () => {
  const parent = realpathSync.native(create(join(tmpdir(), "xueness-canonical-fixture-")));
  const real = join(parent, "real"), alias = join(parent, "alias");
  mkdirSync(real);
  try {
    symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
    const sync = mkdtempSync(join(alias, "sync-")), asyncPath = await mkdtemp(join(alias, "async-"));
    for (const path of [sync, asyncPath]) {
      assert.equal(dirname(path), real);
      assert.equal(path, realpathSync.native(path));
    }
  } finally {
    try { unlinkSync(alias); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    assert(parent.startsWith(join(realpathSync.native(tmpdir()), "xueness-canonical-fixture-")));
    rmSync(parent, { recursive: true, force: true });
  }
});
