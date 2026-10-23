/** Round 10: session Git writes (init/stage/unstage/commit/branch/stash) Python used to serve. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createGitApi } from "../src/http-api.ts";

const ROOT = mkdtempSync(join(tmpdir(), "xueness-git-write-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const SID = "c".repeat(32);
let released = 0;
const store = { load: async (sid: string) => { if (sid !== SID) throw Object.assign(new Error("missing"), { pyType: "FileNotFoundError" }); return { id: SID, root: ROOT }; }, lease: async () => ({ release: async () => { released += 1; } }) } as any;
const api = createGitApi({ store, stateDir: ROOT, enabled: () => true } as any);
const post = (verb: string, data: unknown, sid = SID) => api.dispatch("POST", ["api", "sessions", sid, "git", verb], {}, data);
const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

describe("session Git writes", () => {
  it("owns the six write verbs as POST routes", () => {
    for (const verb of ["init", "stage", "unstage", "commit", "branch", "stash"]) {
      assert.equal(api.owns("POST", ["api", "sessions", SID, "git", verb]), true, verb);
      assert.ok(api.routes.includes(`POST /api/sessions/:id/git/${verb}`));
    }
    assert.equal(api.owns("POST", ["api", "sessions", SID, "git", "push"]), false);
  });
  it("refuses unconfirmed, malformed and non-POST requests", async () => {
    assert.deepEqual(await post("init", {}), [400, { error: "invalid Git operation or missing session" }]);
    assert.deepEqual(await api.dispatch("GET", ["api", "sessions", SID, "git", "init"], {}, {}), [405, { error: "method not allowed" }]);
    assert.deepEqual(await post("stage", { confirmed: true, paths: ["../outside"] }), [400, { error: "invalid Git operation or missing session" }]);
    assert.deepEqual(await post("stage", { confirmed: true, paths: ["-A"] }), [400, { error: "invalid Git operation or missing session" }]);
    assert.deepEqual(await post("branch", { confirmed: true, name: "a..b" }), [400, { error: "invalid Git operation or missing session" }]);
  });
  it("initializes, stages, unstages, commits, branches and stashes", async () => {
    assert.deepEqual(await post("init", { confirmed: true }), [200, { ok: true }]);
    git("config", "user.name", "t"); git("config", "user.email", "t@t");
    writeFileSync(join(ROOT, "a.txt"), "one\n");
    assert.deepEqual(await post("stage", { confirmed: true, paths: ["a.txt"] }), [200, { ok: true }]);
    assert.equal(git("diff", "--cached", "--name-only"), "a.txt");
    assert.deepEqual(await post("commit", { confirmed: true, message: "   " }), [400, { error: "invalid Git operation or missing session" }]);
    assert.deepEqual(await post("commit", { confirmed: true, message: "first" }), [200, { ok: true }]);
    assert.equal(git("log", "-1", "--format=%s"), "first");
    writeFileSync(join(ROOT, "a.txt"), "two\n");
    assert.deepEqual(await post("stage", { confirmed: true, paths: ["a.txt"] }), [200, { ok: true }]);
    assert.deepEqual(await post("unstage", { confirmed: true, paths: ["a.txt"] }), [200, { ok: true }]);
    assert.equal(git("diff", "--cached", "--name-only"), "");
    assert.deepEqual(await post("stash", { confirmed: true }), [200, { ok: true }]);
    assert.match(git("stash", "list"), /Xueness local stash/);
    assert.deepEqual(await post("branch", { confirmed: true, name: "feature/x", create: true }), [200, { ok: true }]);
    assert.equal(git("branch", "--show-current"), "feature/x");
    assert.deepEqual((await post("branch", { confirmed: true, name: "nope" }))![0], 409);
    assert.ok(released >= 8);
  });
});
