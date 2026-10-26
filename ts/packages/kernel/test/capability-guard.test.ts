import { mkdtempSync } from "../../../test-support/canonical-temp.ts";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CapabilityDeniedError, CapabilityGuard, Context, UndeclaredServiceError, UndeclaredToolError } from "@xueness/kernel";

const base = realpathSync(mkdtempSync(join(tmpdir(), "xueness-guard-")));
after(() => rmSync(base, { recursive: true, force: true }));
const workspace = join(base, "work");
const state = join(base, "state");
const outside = join(base, "outside");
for (const dir of [workspace, state, outside]) mkdirSync(dir);
writeFileSync(join(outside, "secret.txt"), "x");
const symlinks = process.platform !== "win32";
if (symlinks) symlinkSync(outside, join(workspace, "escape"));
const roots = { workspace: [workspace], state, home: join(base, "home"), temp: join(base, "temp") };
const root = CapabilityGuard.root(roots);
const denied = (capability: string) => (error: unknown): boolean => error instanceof CapabilityDeniedError && error.capability === capability;

describe("capability guard", () => {
  it("confines file access to granted roots, symlinks included", () => {
    const files = root.narrow("files", { fs: { write: ["workspace"] } });
    assert.equal(files.path("read", join(workspace, "a.txt")), join(workspace, "a.txt"));
    assert.equal(files.path("write", join(workspace, "new", "dir", "file.txt")), join(workspace, "new", "dir", "file.txt"));
    assert.throws(() => files.path("read", join(outside, "secret.txt")), denied("fs.read"));
    assert.throws(() => files.path("write", join(workspace, "..", "outside", "x")), denied("fs.write"));
    assert.throws(() => files.path("write", join(state, "x")), denied("fs.write"));
    if (symlinks) assert.throws(() => files.path("read", join(workspace, "escape", "secret.txt")), denied("fs.read"));
    assert.throws(() => files.path("read", "bad\0path"), TypeError);
    const reader = root.narrow("reader", { fs: { read: ["workspace", "state"] } });
    reader.path("read", join(state, "sessions", "one.json"));
    assert.throws(() => reader.path("write", join(workspace, "a.txt")), denied("fs.write"));
    root.narrow("anywhere", { fs: { read: ["any"] } }).path("read", join(outside, "secret.txt"));
  });

  it("checks programs, hosts, listening and secrets", () => {
    const git = root.narrow("git", {
      exec: ["git"], net: { connect: ["github.com:443", "*.githubusercontent.com"], listen: ["loopback"] }, secrets: ["providers.*"],
    });
    git.program("git");
    git.program("/usr/bin/git");
    git.program("C:\\Program Files\\Git\\git.EXE");
    assert.throws(() => git.program("sh"), denied("exec"));
    git.connect("github.com", 443);
    git.connect("raw.githubusercontent.com", 8080);
    assert.throws(() => git.connect("github.com", 80), denied("net.connect"));
    assert.throws(() => git.connect("evilgithubusercontent.com", 443), denied("net.connect"));
    for (const host of ["127.0.0.1", "::1", "[::1]", "localhost"]) git.listen(host);
    assert.throws(() => git.listen("0.0.0.0"), denied("net.listen"));
    git.secret("providers.openai");
    assert.throws(() => git.secret("bots.telegram"), denied("secrets"));
  });

  it("only narrows: a child cannot regain what its parent lacks", () => {
    const git = root.narrow("git", { exec: ["git"] });
    const child = git.narrow("child", { exec: ["*"], fs: { write: ["any"] } });
    assert.throws(() => child.program("sh"), denied("exec"));
    assert.throws(() => child.path("read", join(workspace, "a.txt")), denied("fs.read"));
    assert.deepEqual(child.missing({ exec: ["git", "node"], fs: { read: ["workspace"] } }), ["fs.read:workspace", "exec:node"]);
    assert.deepEqual(root.missing({ exec: ["*"], fs: { write: ["any"] } }), []);
  });
});

describe("restricted context", () => {
  const tool = (name: string, extra: Record<string, unknown> = {}) => ({ name, gate: "read", mutating: false, concurrencySafe: true, ...extra });

  it("provides, reads and registers only what its manifest declares", async () => {
    const kernel = Context.create({ roots });
    kernel.provide("other.api", {});
    const demo = kernel.restrict("plugin:demo", {
      owner: "demo", capabilities: { fs: { read: ["workspace"] } }, provides: ["demo.api"], uses: ["demo.api"],
      tools: [tool("peek"), { name: "mcp__*", gate: "mcp", mutating: true, concurrencySafe: false }],
    });
    demo.provide("demo.api", 1);
    assert.equal(demo.get("demo.api"), 1);
    assert.throws(() => demo.provide("other.thing", 1), UndeclaredServiceError);
    assert.throws(() => demo.get("other.api"), (error: unknown) => (error as { code?: string }).code === "undeclared_service");
    assert.equal(demo.has("other.api"), true);
    demo.tool(tool("peek", { requires: { fs: { read: ["workspace"] } } }));
    demo.tool({ name: "mcp__github__search", gate: "mcp", mutating: true, concurrencySafe: false });
    assert.equal(kernel.tools.ownerOf("peek"), "demo");
    assert.throws(() => demo.tool(tool("poke")), UndeclaredToolError);
    assert.throws(() => demo.tool({ name: "mcp__other", gate: "read", mutating: true, concurrencySafe: false }), /with gate "mcp", the code has "read"/);
    assert.throws(() => demo.tool({ name: "mcp__git", gate: "mcp", mutating: true, concurrencySafe: false, requires: { exec: ["git"] } }), denied("exec:git"));
    assert.throws(() => demo.emit("internal/service", "demo.api", false), denied("emit"));
    demo.emit("demo/changed");
    const inner = demo.restrict("inner", { owner: "inner", capabilities: { exec: ["*"] }, provides: ["demo.api", "inner.api"] });
    assert.throws(() => inner.provide("inner.api", 1), /demo does not declare that it may provide service inner.api/);
    assert.throws(() => inner.spawn("sh", ["-c", "true"]), denied("exec"));
    const signal = demo.signal;
    await demo.dispose();
    assert.equal(signal.aborted, true);
    assert.deepEqual([kernel.tools.size, kernel.has("demo.api")], [0, false]);
    await kernel.dispose();
  });

  it("checks processes, sockets, requests and secrets against the grant", async () => {
    const kernel = Context.create({ roots, secrets: { get: (name) => (name === "providers.openai" ? "sk-test" : null) } });
    const plain = kernel.restrict("plain", { owner: "plain", capabilities: { exec: ["node"], secrets: ["providers.*"] } });
    assert.throws(() => plain.spawn("sh", ["-c", "true"]), denied("exec"));
    assert.throws(() => plain.spawn("node", ["-e", "1"], { shell: true }), denied("exec"), "a shell needs exec *");
    await assert.rejects(plain.fetch("http://127.0.0.1:9/"), denied("net.connect"));
    await assert.rejects(plain.serve(createServer(), { host: "127.0.0.1", port: 0 }), denied("net.listen"));
    assert.equal(await plain.secret("providers.openai"), "sk-test");
    assert.equal(await plain.secret("providers.none"), null);
    await assert.rejects(plain.secret("bots.telegram"), denied("secrets"));

    const net = kernel.restrict("net", { owner: "net", capabilities: { net: { connect: ["loopback"], listen: ["loopback"] } } });
    await assert.rejects(net.serve(createServer(), { host: "0.0.0.0", port: 0 }), denied("net.listen"));
    const server = createServer((_request, response) => response.writeHead(302, { location: "http://example.com/" }).end());
    const { port } = await net.serve(server, { host: "127.0.0.1", port: 0 });
    const response = await net.fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 302, "redirects are returned, so each hop is checked again");
    await response.body?.cancel();
    await assert.rejects(net.fetch("http://example.com/"), denied("net.connect"));
    await net.dispose();
    assert.equal(server.listening, false);
    await kernel.dispose();
  });
});
