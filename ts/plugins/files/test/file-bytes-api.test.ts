import { mkdtempSync } from "../../../test-support/canonical-temp.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PyValueError } from "@xueness/contracts";
import { SessionStore, type Session } from "@xueness/sessions";
import { createFileBytesApi } from "../src/index.ts";

test("serves bounded byte ranges with a full SHA-256 and default page size", async () => {
  const base = mkdtempSync(join(tmpdir(), "xueness-file-bytes-"));
  try {
    const root = join(base, "workspace");
    mkdirSync(root);
    const bytes = Buffer.from([0, 1, 2, 3, 4, 5]);
    writeFileSync(join(root, "blob.bin"), bytes);
    const store = new SessionStore(join(base, "state"));
    const session = await store.new("bytes", root);
    const sid = String(session.id);
    const api = createFileBytesApi({ store, enabled: () => true, validateSession: (value) => assert.equal(value.root, root) });
    const parts = ["api", "sessions", sid, "file-bytes"];

    const page = await api.dispatch("GET", parts, { path: ["blob.bin"], offset: ["2"], limit: ["3"] });
    assert.equal(page?.[0], 200);
    assert.deepEqual(page?.[1], {
      path: "blob.bin",
      base64: Buffer.from([2, 3, 4]).toString("base64"),
      offset: 2,
      nextOffset: 5,
      totalBytes: 6,
      hash: createHash("sha256").update(bytes).digest("hex"),
    });

    const defaultPage = await api.dispatch("GET", parts, { path: ["blob.bin"] });
    assert.equal(defaultPage?.[0], 200);
    assert.equal((defaultPage?.[1] as { base64: string }).base64, bytes.toString("base64"));
    const oversized = await api.dispatch("GET", parts, { path: ["blob.bin"], limit: ["65537"] });
    assert.equal(oversized?.[0], 400);
    assert.equal(api.owns("POST", parts), false);
    assert.equal(await api.dispatch("POST", parts, { path: ["blob.bin"] }), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("requires both plugins and authorized local session roots", async () => {
  const base = mkdtempSync(join(tmpdir(), "xueness-file-bytes-auth-"));
  try {
    const root = join(base, "workspace");
    mkdirSync(root);
    writeFileSync(join(root, "blob.bin"), "data");
    const store = new SessionStore(join(base, "state"));
    const session = await store.new("bytes", root);
    const parts = ["api", "sessions", String(session.id), "file-bytes"];

    const disabled = createFileBytesApi({ store, enabled: (id) => id !== "files", validateSession: () => {} });
    assert.equal((await disabled.dispatch("GET", parts, { path: ["blob.bin"] }))?.[0], 403);

    const denied = createFileBytesApi({ store, enabled: () => true, validateSession: () => { throw new PyValueError("workspace root not permitted"); } });
    assert.deepEqual(await denied.dispatch("GET", parts, { path: ["blob.bin"] }), [403, { error: "workspace root not permitted" }]);

    const remoteSession = { ...session, remote_connection: { id: "remote" } } as Session;
    const remote = createFileBytesApi({ store: { load: async () => remoteSession }, enabled: () => true, validateSession: () => {} });
    assert.deepEqual(await remote.dispatch("GET", parts, { path: ["blob.bin"] }), [409, { error: "Remote file bytes are unavailable" }]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
