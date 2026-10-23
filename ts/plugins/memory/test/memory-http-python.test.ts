/** Differential: memory HTTP against Python `plugin.dispatch` and `plugin_runtime.dispatch_http`. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createMemoryHttp, projectHash, pyResolve } from "../src/index.ts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";

const skip = pythonUnavailableReason();
const DISABLED = { error: "plugin disabled or dependency unavailable: memory", plugin: "memory" };
const INVALID = { error: "memory track unavailable or invalid" };
const CONFLICT = { error: "memory changed; reload before saving" };
const ORACLE = `
import json, os, sys
from pathlib import Path
from xueness.bundled_plugins.memory import plugin as memory_plugin
from xueness import plugin_runtime
import xueness.bundled_plugins.settings.workspaces_api as workspaces
spec = json.loads(sys.stdin.read())
workspaces.selected_roots = lambda ctx: tuple(Path(path) for path in spec["selected"])
class Store:
    def list(self):
        return [{"id": "ok"}, {"id": "missing"}, {"id": "bad"}, {"id": "num"}]
    def load(self, sid):
        if sid == "missing": raise FileNotFoundError(sid)
        if sid == "bad": raise ValueError(sid)
        if sid == "num": return {"root": 1}
        return {"root": spec["session"]}
ctx = {"state_dir": spec["state"], "project_dir": spec["project"], "workspace_roots": spec["workspaces"], "store": Store()}
out = []
for op in spec["ops"]:
    if op["env"] is None: os.environ.pop("XUENESS_MEMORY_ROOT", None)
    else: os.environ["XUENESS_MEMORY_ROOT"] = op["env"]
    try:
        if op.get("disable"):
            plugin_runtime.set_enabled(spec["state"], "memory", False)
            try: result = plugin_runtime.dispatch_http(op["method"], op["parts"], op["query"], op["data"], ctx)
            finally: plugin_runtime.set_enabled(spec["state"], "memory", True)
        elif op.get("via") == "http":
            result = plugin_runtime.dispatch_http(op["method"], op["parts"], op["query"], op["data"], ctx)
        else:
            result = memory_plugin.dispatch(op["method"], op["parts"], op["query"], op["data"], ctx)
        out.append(result)
    except Exception as exc:
        out.append(["EXC", type(exc).__name__, str(exc)])
print(json.dumps(out))
`;

interface Op { env: string | null; method: string; parts: string[]; query: Record<string, unknown>; data: Record<string, unknown>; via?: "http"; disable?: boolean }
type Reply = [number, unknown] | null;
const call = (env: string | null, method: string, parts: string[], query: Record<string, unknown> = {}, data: Record<string, unknown> = {}, extra: Partial<Op> = {}): Op => ({ env, method, parts, query, data, ...extra });

describe("memory http routing", () => {
  const api = createMemoryHttp({ stateDir: "state", projectDir: "project", enabled: () => true, env: {} });
  const off = createMemoryHttp({ stateDir: "state", projectDir: "project", enabled: () => false, env: {} });
  it("owns the three memory routes and refuses a disabled plugin before any read", () => {
    assert.deepEqual(api.routes, ["GET /api/memory/tracks", "GET /api/memory/workspaces", "GET /api/memory/tracks/:name", "POST /api/memory/tracks/:name"]);
    assert.equal(api.owns("GET", ["api", "memory", "tracks"]), true);
    assert.equal(api.owns("GET", ["api", "memory", "workspaces"]), true);
    assert.equal(api.owns("POST", ["api", "memory", "tracks", "key"]), true);
    assert.equal(api.owns("DELETE", ["api", "memory", "tracks", "nope"]), true);
    assert.equal(api.owns("POST", ["api", "memory", "tracks"]), false);
    assert.equal(api.owns("POST", ["api", "memory", "workspaces"]), false);
    assert.equal(api.owns("GET", ["api", "memory"]), false);
    assert.equal(api.dispatch("POST", ["api", "memory", "tracks"], {}, {}), null);
    assert.deepEqual(off.dispatch("GET", ["api", "memory", "tracks"], {}, {}), [403, DISABLED]);
    assert.deepEqual(off.dispatch("POST", ["api", "memory", "tracks", "memory"], {}, { confirmed: true, content: "x" }), [403, DISABLED]);
  });
});

describe("memory http matches Python", { skip: skip ?? false }, () => {
  it("lists tracks and workspaces, edits with a digest, and refuses bad writes", () => {
    const base = pyResolve(mkdtempSync(join(tmpdir(), "xueness-memhttp-")));
    const folder = (name: string): string => { const path = pyResolve(join(base, name)); mkdirSync(path, { recursive: true }); return path; };
    const state = folder("state");
    const projectDir = folder("project");
    const selected = folder("selected");
    const session = folder("session");
    const declared = [folder("extra"), folder("\uE000dir"), folder("😀dir")];
    const mem = folder("mem");
    const empty = folder("empty");
    const keyOnly = folder("key-only");
    const outside = folder("outside");
    writeFileSync(join(outside, "secret.txt"), "secret\n");
    writeFileSync(join(mem, "MEMORY.md"), "记忆\n");
    writeFileSync(join(mem, "USER.md"), "user\r\n");
    mkdirSync(join(mem, "projects", projectHash(projectDir)), { recursive: true });
    writeFileSync(join(mem, "projects", projectHash(projectDir), "KEY.md"), "key\n");
    mkdirSync(join(keyOnly, "projects", projectHash(projectDir)), { recursive: true });
    writeFileSync(join(keyOnly, "projects", projectHash(projectDir), "KEY.md"), "only-key\n");
    const user = join(mem, "USER.md");
    const specOf = (ops: Op[]) => ({ state, project: projectDir, workspaces: declared, selected: [selected], session, ops });
    const oracle = (ops: Op[]): Reply[] => JSON.parse(runPython(ORACLE, JSON.stringify(specOf(ops)))) as Reply[];
    const local = (op: Op): Reply => createMemoryHttp({
      stateDir: state, projectDir, workspaceRoots: declared, selectedRoots: () => [selected], sessionRoots: () => [session],
      enabled: () => !op.disable, env: op.env == null ? {} : { XUENESS_MEMORY_ROOT: op.env },
    }).dispatch(op.method, op.parts, op.query, op.data);
    const compare = (ops: Op[]): Reply[] => {
      const python = oracle(ops);
      const typescript = ops.map(local);
      assert.deepEqual(typescript, python);
      return python;
    };
    const temps = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      return [...(entry.name.startsWith(".memory-") ? [path] : []), ...(entry.isDirectory() ? temps(path) : [])];
    });
    const track = ["api", "memory", "tracks"];
    const editor = (name: string) => ["api", "memory", "tracks", name];
    try {
      const listed = compare([
        call(null, "GET", track),
        call(null, "GET", ["api", "memory", "workspaces"]),
        call("   ", "GET", track),
        call(" \u3000", "GET", ["api", "memory", "workspaces"]),
        call(null, "DELETE", editor("memory")),
        call(null, "GET", editor("memory")),
        call(mem, "GET", track),
        call(mem, "GET", track, { root: [declared[0]!] }, {}, { via: "http" }),
        call(mem, "GET", ["api", "memory", "workspaces"]),
        call(empty, "GET", ["api", "memory", "workspaces"]),
        call(keyOnly, "GET", ["api", "memory", "workspaces"]),
        call(mem, "GET", editor("user")),
        call(mem, "GET", editor("missing-track")),
        call(mem, "GET", editor("key")),
        call(mem, "GET", editor("key"), { root: [declared[0]!] }),
        call(mem, "GET", editor("key"), { root: projectDir }),
        call(mem, "GET", editor("key"), { root: [projectDir, projectDir] }),
        call(mem, "GET", editor("key"), { root: ["x".repeat(4097)] }),
        call(mem, "GET", editor("key"), { root: ["a\0b"] }),
        call(mem, "GET", editor("key"), { root: [join(base, "not-a-workspace")] }),
        call(mem, "DELETE", editor("memory")),
        call(mem, "DELETE", editor("memory"), { root: [join(base, "not-a-workspace")] }),
        call(mem, "POST", track),
        call(mem, "POST", track, {}, {}, { via: "http" }),
        call(mem, "POST", editor("user"), {}, { confirmed: false, content: "x", digest: "0".repeat(64) }),
        call(mem, "POST", editor("user"), {}, { confirmed: true, content: 1 as unknown as string, digest: "0".repeat(64) }),
        call(mem, "POST", editor("user"), {}, { confirmed: true, content: "a".repeat(100_001), digest: "0".repeat(64) }),
        call(mem, "POST", editor("user"), {}, { confirmed: true, content: "\uD800", digest: "0".repeat(64) }),
        call(mem, "POST", editor("user"), {}, { confirmed: true, content: "no-digest" }),
        call(mem, "POST", editor("user"), {}, { confirmed: true, content: "stale", digest: "0".repeat(64) }),
        call(mem, "GET", track, {}, {}, { disable: true }),
        call(mem, "GET", ["api", "memory", "workspaces"], {}, {}, { disable: true }),
        call(mem, "POST", editor("memory"), {}, { confirmed: true, content: "x" }, { disable: true }),
      ]);
      assert.deepEqual(listed[0], [200, { tracks: [] }]);
      assert.deepEqual(listed[1], [200, { workspaces: [], configured: false }]);
      assert.deepEqual(listed[4], [405, { error: "method not allowed" }]);
      assert.deepEqual(listed[5], [400, INVALID]);
      const userRead = listed[11] as [number, { digest: string; content: string }];
      assert.equal(userRead[1].content, "user\r\n");
      assert.equal(userRead[1].digest, createHash("sha256").update(Buffer.from("user\r\n", "utf8")).digest("hex"));
      const workspaces = listed[8] as [number, { workspaces: { id: string; files: { name: string }[] }[]; configured: boolean }];
      assert.equal(workspaces[1].configured, true);
      assert.ok(workspaces[1].workspaces.some((item) => item.id === session && item.files.some((file) => file.name === "memory")));
      assert.ok(workspaces[1].workspaces.some((item) => item.id === selected));
      assert.equal(workspaces[1].workspaces.find((item) => item.id === projectDir)?.files.some((file) => file.name === "key"), true);
      assert.equal(workspaces[1].workspaces.find((item) => item.id === declared[0])?.files.some((file) => file.name === "key"), false);
      const keyOnlyList = listed[10] as [number, { workspaces: { id: string; files: { name: string }[] }[]; configured: boolean }];
      assert.equal(keyOnlyList[1].configured, true);
      assert.deepEqual(keyOnlyList[1].workspaces.map((item) => item.id), [projectDir]);
      assert.deepEqual(listed[30], [403, DISABLED]);
      assert.deepEqual(listed[24], [400, INVALID]);
      assert.deepEqual(listed[28], [409, CONFLICT]);
      const original = readFileSync(user);
      writeFileSync(user, "changed");
      compare([call(mem, "POST", editor("user"), {}, { confirmed: true, content: "nope\n", digest: userRead[1].digest })]);
      assert.equal(readFileSync(user, "utf8"), "changed");
      writeFileSync(user, original);
      writeFileSync(user, Buffer.alloc(100_001, 0x61));
      compare([call(mem, "GET", editor("user"))]);
      writeFileSync(user, Buffer.from([0xff, 0xfe, 0x61]));
      compare([call(mem, "GET", editor("user"))]);
      assert.deepEqual(compare([call(mem, "GET", editor("user"))])[0], [400, INVALID]);
      writeFileSync(user, original);
      const written = call(mem, "POST", editor("user"), {}, { confirmed: true, content: "保存\nsecond", digest: userRead[1].digest });
      const before = readFileSync(user);
      const pythonWrite = oracle([written])[0];
      const pythonBytes = readFileSync(user);
      writeFileSync(user, before);
      const typescriptWrite = local(written);
      const typescriptBytes = readFileSync(user);
      assert.deepEqual(typescriptWrite, pythonWrite);
      assert.deepEqual(typescriptBytes, pythonBytes);
      assert.deepEqual(pythonBytes, Buffer.from("保存\nsecond", "utf8"));
      assert.deepEqual(temps(mem), []);
      writeFileSync(user, before);
      const created = join(mem, "projects", projectHash(declared[0]!), "KEY.md");
      const create = call(mem, "POST", editor("key"), { root: [declared[0]!] }, { confirmed: true, content: "fresh\n", digest: createHash("sha256").update(Buffer.alloc(0)).digest("hex") });
      const createdPython = oracle([create])[0];
      const createdBytes = readFileSync(created);
      unlinkSync(created);
      const createdTs = local(create);
      assert.deepEqual(createdTs, createdPython);
      assert.deepEqual(readFileSync(created), createdBytes);
      unlinkSync(created);
      let linked = true;
      const linkRoot = folder("link-mem");
      try { symlinkSync(join(outside, "secret.txt"), join(linkRoot, "USER.md")); }
      catch (error) {
        linked = false;
        if (!["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
      if (linked) {
        compare([
          call(linkRoot, "GET", track),
          call(linkRoot, "GET", ["api", "memory", "workspaces"]),
          call(linkRoot, "GET", editor("user")),
        ]);
        const parentRoot = folder("parent-mem");
        symlinkSync(outside, join(parentRoot, "projects"));
        const outsideBefore = readdirSync(outside);
        compare([
          call(parentRoot, "GET", editor("key")),
          call(parentRoot, "POST", editor("key"), {}, { confirmed: true, content: "escape\n", digest: "0".repeat(64) }),
        ]);
        assert.deepEqual(readdirSync(outside), outsideBefore);
        assert.equal(existsSync(join(outside, "KEY.md")), false);
      }
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});
