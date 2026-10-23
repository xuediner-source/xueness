import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { SessionStore } from "@xueness/sessions";
import { gitCommand } from "../src/actions.ts";
import { CloneError, suggestedName, validatedUrl } from "../src/clone.ts";
import { createGitApi } from "../src/http-api.ts";
import { gitDiff } from "../src/session-git.ts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";

const skip = pythonUnavailableReason() ?? (spawnSync("git", ["--version"]).status === 0 ? false : "git not installed");
const identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false"];
const remote = "https://example.invalid/acme/widgets.git";
const urls = ["https://github.com/acme/widgets.git", "https://git.example.com:8443/team/repo", "ssh://git@github.com/acme/widgets.git", "ssh://github.com:2222/acme/widgets", "git@github.com:acme/widgets.git", "github.com:acme/widgets", "file:///etc", "ext::sh -c touch% /tmp/pwn", "--upload-pack=touch /tmp/x", "/srv/repo", "http://example.invalid/a/b", "https://user:pw@example.invalid/a/b", "https://user@example.invalid/a/b", "https://example.invalid/a b", " https://example.invalid/a", "", "x".repeat(3000), "fd::17", "git://example.invalid/a", null, 5];
const ORACLE = `
import io, json, sys
from pathlib import Path
from xueness.bundled_plugins.git import clone, git_api
req = json.loads(sys.stdin.read())
_stdout = sys.stdout
sys.stdout = io.StringIO()
def panel(root):
    out = {}
    for name, fn in (("status", git_api._git_status), ("diff", git_api._git_diff), ("log", git_api._git_log)):
        try: out[name] = [200, fn(root)]
        except git_api.GitApiError as exc: out[name] = [exc.status, {"error": exc.message}]
    return out
class Store:
    def load(self, sid):
        if sid not in req["sessions"]: raise KeyError(sid)
        return req["sessions"][sid]
ctx = {"store": Store()}
panels = {key: panel(root) for key, root in req["panels"].items()}
calls = [git_api.dispatch(item["method"], item["parts"], {}, {}, ctx) for item in req["calls"]]
git_api.MAX_PATCH_CHARS = 50
try: limited = git_api._git_diff(req["limited"])
except git_api.GitApiError as exc: limited = [exc.status, {"error": exc.message}]
urls = []
for url in req["urls"]:
    try: urls.append(clone.validated_url(url))
    except clone.CloneError as exc: urls.append({"error": str(exc), "status": exc.status})
cctx = {"state_dir": req["state"], "workspace_roots": req["roots"]}
payload = json.dumps({
    "panels": panels,
    "calls": calls,
    "limited": limited,
    "urls": urls,
    "names": [clone.suggested_name(url) for url in req["names"]],
    "clone": [clone.dispatch(item["method"], item["parts"], {}, item["data"], cctx) for item in req["clone"]],
    "pathOf": str(Path(req["pathOf"]).parent.resolve(strict=True) / Path(req["pathOf"]).name),
}, ensure_ascii=False)
sys.stdout = _stdout
print(payload)
`;
const urlOf = (url: unknown): unknown => { try { return validatedUrl(url); } catch (error) { if (error instanceof CloneError) return { error: error.message, status: error.status }; throw error; } };
describe("session git panel and clone", { skip }, () => {
  it("matches Python status, diff, log and clone refusals", async () => {
    const base = mkdtempSync(join(tmpdir(), "xueness-session-git-"));
    const emptyRepo = join(base, "empty"), dirtyRepo = join(base, "dirty"), plain = join(base, "plain"), projects = join(base, "projects"), outside = join(base, "outside"), state = join(base, "state");
    const store = new SessionStore(join(base, "sessions"));
    const emptySid = "a".repeat(32), dirtySid = "b".repeat(32), plainSid = "c".repeat(32), goneSid = "d".repeat(32);
    try {
      mkdirSync(emptyRepo); mkdirSync(dirtyRepo); mkdirSync(plain); mkdirSync(projects); mkdirSync(outside); mkdirSync(state);
      for (const repo of [emptyRepo, dirtyRepo]) { await gitCommand(repo, ["init", "-q"]); await gitCommand(repo, ["config", "core.autocrlf", "false"]); }
      writeFileSync(join(dirtyRepo, "a.txt"), "one\n"); await gitCommand(dirtyRepo, [...identity, "add", "a.txt"]); await gitCommand(dirtyRepo, [...identity, "commit", "-qm", "first commit"]);
      writeFileSync(join(dirtyRepo, "b.txt"), "two\n"); await gitCommand(dirtyRepo, [...identity, "add", "b.txt"]); await gitCommand(dirtyRepo, [...identity, "commit", "-qm", "second commit"]);
      writeFileSync(join(dirtyRepo, "a.txt"), "one\nchanged\n"); writeFileSync(join(dirtyRepo, "new.txt"), "hi\n");
      writeFileSync(join(dirtyRepo, "big.txt"), "one\n" + "x\n".repeat(500)); await gitCommand(dirtyRepo, [...identity, "add", "big.txt"]); await gitCommand(dirtyRepo, [...identity, "commit", "-qm", "big"]);
      writeFileSync(join(dirtyRepo, "big.txt"), "one\n" + "y\n".repeat(500));
      mkdirSync(join(projects, "busy")); writeFileSync(join(projects, "busy", "f"), "x"); writeFileSync(join(projects, "file"), "x");
      let linked = false;
      try { symlinkSync(outside, join(projects, "link"), process.platform === "win32" ? "junction" : "dir"); linked = true; } catch { /* link refusal is skipped when the os refuses the junction */ }
      const empty = String((await store.new("empty", emptyRepo, { sessionId: emptySid })).root);
      const dirty = String((await store.new("dirty", dirtyRepo, { sessionId: dirtySid })).root);
      const plainRoot = String((await store.new("plain", plain, { sessionId: plainSid })).root);
      const gone = String((await store.new("gone", join(base, "gone"), { sessionId: goneSid })).root);
      const dest = join(projects, "widgets");
      const linkDest = join(projects, "link");
      const post = (data: Record<string, unknown>) => ({ method: "POST", parts: ["api", "git", "clone"], data });
      const cloneCases = [
        post({ url: remote, dest, confirmed: false }), post({ url: remote, dest, confirmed: null }), post({ url: remote, dest, confirmed: "true" }), post({ url: remote, dest, confirmed: 1 }), post({ url: remote, dest }),
        { method: "GET", parts: ["api", "git", "clone"], data: {} }, { method: "POST", parts: ["api", "git", "other"], data: {} },
        post({ url: "file:///etc/passwd", dest, confirmed: true }), post({ url: "--upload-pack=x", dest, confirmed: true }), post({ url: "ext::sh", dest, confirmed: true }),
        post({ url: remote, dest: "projects/w", confirmed: true }), post({ url: remote, dest: "/w", confirmed: true }), post({ url: remote, dest: projects + "\\..\\outside\\w", confirmed: true }),
        post({ url: remote, dest: join(outside, "w"), confirmed: true }), post({ url: remote, dest: join(projects, "missing", "w"), confirmed: true }),
        post({ url: remote, dest: join(projects, "-w"), confirmed: true }), post({ url: remote, dest: join(projects, ".git"), confirmed: true }),
        post({ url: remote, dest: join(projects, "busy"), confirmed: true }), post({ url: remote, dest: join(projects, "file"), confirmed: true }),
        post({ url: remote, dest, confirmed: true, upload_pack: "x" }), post({ url: remote, dest, confirmed: true, root: outside }), post({ url: remote, dest, confirmed: true, root: "" }),
        post({ url: remote, dest: join(linkDest, "w"), confirmed: true }), ...(linked ? [post({ url: remote, dest: linkDest, confirmed: true })] : []),
        post({ url: remote, dest: "C:\\widgets", confirmed: true }), post({ url: remote, dest: "C:\\Users\\widgets", confirmed: true }), post({ url: remote, dest: join(homedir(), "widgets"), confirmed: true }),
      ];
      const calls = ["status", "diff", "log"].flatMap((verb) => [
        { method: "GET", parts: ["api", "sessions", dirtySid, "git", verb] },
        { method: "GET", parts: ["api", "sessions", emptySid, "git", verb] },
        { method: "GET", parts: ["api", "sessions", plainSid, "git", verb] },
        { method: "GET", parts: ["api", "sessions", goneSid, "git", verb] },
        { method: "POST", parts: ["api", "sessions", dirtySid, "git", verb] },
      ]).concat([
        { method: "GET", parts: ["api", "sessions", "f".repeat(32), "git", "status"] },
        { method: "GET", parts: ["api", "sessions", "zzz", "git", "status"] },
        { method: "GET", parts: ["api", "sessions", dirtySid, "git", "show"] },
        { method: "GET", parts: ["api", "sessions", dirtySid, "git"] },
        { method: "POST", parts: ["api", "sessions", "zzz", "git", "status"] },
      ]);
      const names = ["https://github.com/acme/widgets.git", "git@github.com:acme/widgets.git", "git@host:-bad"];
      const expected = JSON.parse(runPython(ORACLE, JSON.stringify({
        panels: { empty, dirty, plain: plainRoot, gone }, sessions: { [emptySid]: { root: empty }, [dirtySid]: { root: dirty }, [plainSid]: { root: plainRoot }, [goneSid]: { root: gone } },
        calls, limited: dirty, urls, names, state, roots: [projects], clone: cloneCases, pathOf: dest,
      }))) as { panels: Record<string, Record<string, unknown>>; calls: unknown[]; limited: unknown; urls: unknown[]; names: string[]; clone: unknown[]; pathOf: string };
      let transported = 0; let remembered: string | null = null;
      const api = createGitApi({ store, stateDir: state, enabled: () => true, allowedRoots: () => [projects], rememberWorkspace: (path) => { remembered = path; }, urlTransport: () => { transported += 1; return join(base, "missing.git"); } });
      assert.equal(api.owns("POST", ["api", "git", "clone"]), true);
      assert.equal(api.owns("GET", ["api", "sessions", dirtySid, "git", "status"]), true);
      assert.equal(api.owns("GET", ["api", "sessions", "not-a-sid", "git", "status"]), false);
      assert.equal(api.owns("GET", ["api", "sessions", dirtySid, "git", "checkpoints"]), true);
      const verbs = ["status", "diff", "log"] as const;
      for (const [key, sid] of [["empty", emptySid], ["dirty", dirtySid]] as const) {
        for (const verb of verbs) assert.deepEqual(await api.dispatch("GET", ["api", "sessions", sid, "git", verb], {}, {}), expected.panels[key]![verb], `${key} ${verb}`);
      }
      const actualCalls = [];
      for (const call of calls) actualCalls.push(await api.dispatch(call.method, call.parts, {}, {}));
      // Python answers POST on a non-hex sid with 405; this port leaves that unowned so the host can forward it.
      const forwarded = calls.findIndex((call) => call.method === "POST" && call.parts[2] === "zzz");
      assert.equal(actualCalls[forwarded], null);
      actualCalls[forwarded] = expected.calls[forwarded];
      assert.deepEqual(actualCalls, expected.calls);
      assert.deepEqual(await gitDiff(dirty, 50), expected.limited);
      assert.deepEqual(urls.map(urlOf), expected.urls);
      assert.deepEqual(names.map(suggestedName), expected.names);
      const actualClone = [];
      for (const call of cloneCases) actualClone.push(await api.dispatch(call.method, call.parts, {}, call.data));
      assert.deepEqual(actualClone, expected.clone);
      assert.equal(transported, 0);
      const origin = join(base, "origin.git"), seed = join(base, "seed");
      mkdirSync(seed); await gitCommand(seed, ["init", "-q"]); await gitCommand(seed, ["config", "core.autocrlf", "false"]);
      writeFileSync(join(seed, "README.md"), "hello\n"); await gitCommand(seed, [...identity, "add", "README.md"]); await gitCommand(seed, [...identity, "commit", "-qm", "seed"]);
      await gitCommand(base, [...identity, "clone", "-q", "--bare", seed, origin]);
      const cloning = createGitApi({ store, stateDir: state, enabled: () => true, allowedRoots: () => [projects], rememberWorkspace: (path) => { remembered = path; }, urlTransport: (value) => value === remote ? origin : value });
      const cloned = await cloning.dispatch("POST", ["api", "git", "clone"], {}, { url: remote, dest, confirmed: true });
      assert.deepEqual(cloned, [200, { cloned: expected.pathOf, root: expected.pathOf, url: remote }]);
      assert.equal(remembered, expected.pathOf);
      assert.match(readFileSync(join(dest, "README.md"), "utf8"), /^hello\r?\n$/);
      const off = createGitApi({ store, stateDir: state, enabled: () => false });
      const disabled = [403, { error: "plugin disabled or dependency unavailable: git", plugin: "git", code: "plugin_disabled" }];
      assert.deepEqual(await off.dispatch("GET", ["api", "sessions", dirtySid, "git", "status"], {}, {}), disabled);
      assert.deepEqual(await off.dispatch("POST", ["api", "git", "clone"], {}, { url: remote, dest: join(projects, "other"), confirmed: true }), disabled);
      assert.deepEqual(await off.dispatch("POST", ["api", "sessions", dirtySid, "git", "checkpoints"], {}, {}), disabled);
      const listed = await api.dispatch("GET", ["api", "sessions", dirtySid, "git", "checkpoints"], {}, {});
      assert.equal(listed?.[0], 200);
      assert.ok(listed?.[1] && typeof listed[1] === "object" && "checkpoints" in (listed[1] as object));
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
