import { mkdtempSync } from "../../../test-support/canonical-temp.ts";
/** Which MCP servers a run connects: TS loader against Python `mcp.load`, plus the native-or-Python routing. */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { pyJsonDumps } from "@xueness/contracts";
import { loadMcpServers } from "../src/mcp-servers.ts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";

const skip = pythonUnavailableReason() ?? false;
function stateWith(entries: Record<string, string>): string {
  const state = mkdtempSync(join(tmpdir(), "xueness-mcp-state-"));
  const dir = join(state, "resources", "mcp"); mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(entries)) writeFileSync(join(dir, name), text);
  return state;
}
const ENTRIES: Record<string, string> = {
  "b.json": JSON.stringify({ id: "b", command: "srv", args: ["--x"], timeout: 5 }),
  "a.json": JSON.stringify({ id: "a", transport: "http", url: "https://example.com/mcp", headersEnv: { Authorization: "TOKEN" } }),
  "c.json": JSON.stringify({ id: "c", transport: "sse", url: "https://example.com/sse" }),
  "disabled.json": JSON.stringify({ id: "d", command: "x", enabled: false }),
  "dots.json": JSON.stringify({ id: "..", command: "x" }),
  "badid.json": JSON.stringify({ id: "has space", command: "x" }),
  "blank.json": JSON.stringify({ id: "blank", command: "   " }),
  "nourl.json": JSON.stringify({ id: "nourl", transport: "http" }),
  "list.json": "[1, 2]",
  "broken.json": "{ not json",
  "nan.json": '{"id": "nan", "command": "x", "timeout": NaN, "id": "nan2"}',
  ".hidden.json": JSON.stringify({ id: "hidden", command: "x" }),
  "notes.txt": JSON.stringify({ id: "txt", command: "x" }),
  "bom.json": "\ufeff" + JSON.stringify({ id: "bom", command: "x" }),
  "unicode.json": JSON.stringify({ id: "u", command: "x", name: "名字" }),
};

describe("MCP server loading", () => {
  it("merges runtime patches over legacy servers", () => {
    const state = stateWith({
      "legacy.json": JSON.stringify({ id: "legacy", transport: "stdio", command: "legacy", args: ["--old"] }),
      "worker.json": JSON.stringify({ id: "worker", transport: "stdio", command: "worker", args: ["--base"], env: { KEEP: "base", OVERRIDE: "old" }, cwd: "tools/worker" }),
      "disabled.json": JSON.stringify({ id: "disabled", command: "disabled", enabled: true }),
    });
    const cwd = join(state, "workspace");
    const patches = {
      legacy: { type: "http", url: "https://example.com/mcp" },
      worker: { args: ["--replacement"], env: { OVERRIDE: "new", PATCHED: "yes" }, cwd: "../run" },
      disabled: { enabled: false },
    };
    try {
      const loaded = loadMcpServers(state, [], patches, cwd);
      const legacy = loaded.servers.find((row) => row.id === "legacy");
      const worker = loaded.servers.find((row) => row.id === "worker");
      assert.equal(legacy?.transport, "http");
      assert.equal(Object.hasOwn(legacy ?? {}, "type"), false);
      assert.equal(legacy?.url, "https://example.com/mcp");
      assert.deepEqual(worker?.args, ["--replacement"]);
      assert.deepEqual(worker?.env, { KEEP: "base", OVERRIDE: "new", PATCHED: "yes" });
      assert.equal(worker?.cwd, resolve(cwd, "../run"));
      assert.deepEqual(loaded.servers.map((row) => row.id), ["legacy", "worker"]);
      assert.throws(() => loadMcpServers(state, [], { legacy: { unsupported: true } }, cwd), /unsupported field/);
    } finally { rmSync(state, { recursive: true, force: true }); }
  });
  it("matches Python load() entry for entry", { skip }, () => {
    const state = stateWith(ENTRIES);
    try {
      try { symlinkSync(join(state, "resources", "mcp", "b.json"), join(state, "resources", "mcp", "link.json")); }
      catch (error) { if (!["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
      const python = runPython("import json,sys\nfrom xueness.bundled_plugins.mcp import mcp\nprint(json.dumps(mcp.load(sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read().strip())))", state).trim();
      const loaded = loadMcpServers(state);
      assert.equal(pyJsonDumps(loaded.servers, { ensureAscii: true }), python);
      assert.deepEqual(loaded.servers.map((row) => row.id), ["a", "b", "c", "hidden", "nan2", "u"]);
      assert.equal(loaded.native, true);
    } finally { rmSync(state, { recursive: true, force: true }); }
  });
  it("keeps the Python executor for what the TS plugin does not serve", () => {
    const cases: [Record<string, string>, string][] = [
      [{ "n.json": JSON.stringify({ id: "n", command: "x", args: [1] }) }, "n: non-string args"],
      [{ "1.json": JSON.stringify({ id: "same", command: "x" }), "2.json": JSON.stringify({ id: "same", command: "y" }) }, "duplicate server id"],
      [{ "big.json": JSON.stringify({ id: "big", command: "x", pad: "x".repeat(1024 * 1024) }) }, "entry too large"],
    ];
    for (const [entries, reason] of cases) {
      const state = stateWith(entries);
      try {
        const loaded = loadMcpServers(state);
        assert.equal(loaded.configured, true, reason); assert.equal(loaded.native, false, reason); assert.ok(loaded.reasons.includes(reason), `${reason}: ${loaded.reasons.join(", ")}`);
      } finally { rmSync(state, { recursive: true, force: true }); }
    }
    const governed = stateWith({ "s.json": JSON.stringify({ id: "s", command: "x" }) });
    try {
      mkdirSync(join(governed, "resources", "plugins"));
      writeFileSync(join(governed, "resources", "plugins", "m.json"), JSON.stringify({ id: "mcp-ops", builtin: "mcp" }));
      // A readable manifest that fails plan() is not handed to Python: Python would refuse mcp too.
      assert.deepEqual(loadMcpServers(governed), { servers: [], configured: false, native: true, reasons: [] });
      writeFileSync(join(governed, "resources", "plugins", "m.json"), JSON.stringify({ id: "mcp-ops", version: "1.0.0", apiVersion: 1, enabled: true, builtin: "mcp", capabilities: [] }));
      const allowed = loadMcpServers(governed);
      assert.equal(allowed.native, true, "an accepted manifest leaves the server native");
      assert.deepEqual(allowed.servers.map((row) => row.id), ["s"]);
      writeFileSync(join(governed, "resources", "plugins", "m.json"), JSON.stringify({ id: "mcp-ops", version: "1.0.0", apiVersion: 1, enabled: true, builtin: "mcp", capabilities: ["network"] }));
      assert.equal(loadMcpServers(governed).configured, false, "a missing grant refuses mcp");
      assert.deepEqual(loadMcpServers(governed, ["network"]).servers.map((row) => row.id), ["s"]);
      writeFileSync(join(governed, "resources", "plugins", "huge.json"), "x".repeat(1024 * 1024 + 1));
      assert.ok(loadMcpServers(governed).reasons.includes("plugin manifest governs mcp"));
    } finally { rmSync(governed, { recursive: true, force: true }); }
    const oauthOnly = stateWith({ "o.json": JSON.stringify({ id: "o", transport: "http", url: "https://e.com/m", oauth: { clientId: "x" } }) });
    try {
      const loaded = loadMcpServers(oauthOnly);
      assert.equal(loaded.native, true, "OAuth bearer is sent by the TS HTTP transport");
      assert.deepEqual(loaded.reasons, []);
      assert.deepEqual(loaded.servers.map((row) => row.id), ["o"]);
    } finally { rmSync(oauthOnly, { recursive: true, force: true }); }
    const eliciting = stateWith({ "e.json": JSON.stringify({ id: "e", command: "x", elicitation: true }) });
    try {
      const loaded = loadMcpServers(eliciting);
      assert.equal(loaded.native, true, "elicitation is answered by the TS client");
      assert.deepEqual(loaded.reasons, []);
    } finally { rmSync(eliciting, { recursive: true, force: true }); }
    const empty = stateWith({ "off.json": JSON.stringify({ id: "off", command: "x", enabled: false }) });
    try { assert.deepEqual(loadMcpServers(empty), { servers: [], configured: false, native: true, reasons: [] }); }
    finally { rmSync(empty, { recursive: true, force: true }); }
  });
  it("refuses a linked mcp directory", { skip: process.platform === "win32" }, () => {
    const state = mkdtempSync(join(tmpdir(), "xueness-mcp-state-")); const elsewhere = stateWith({ "x.json": JSON.stringify({ id: "x", command: "x" }) });
    try {
      mkdirSync(join(state, "resources")); symlinkSync(join(elsewhere, "resources", "mcp"), join(state, "resources", "mcp"));
      assert.deepEqual(loadMcpServers(state).servers, []);
    } finally { rmSync(state, { recursive: true, force: true }); rmSync(elsewhere, { recursive: true, force: true }); }
  });
});
