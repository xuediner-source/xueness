/** F06.01: connection generations, reconnect, run close, notifications, timeouts and pool leases. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Context, PluginHost } from "@xueness/kernel";
import { createMcp, McpConnectionPool, type McpRuntimeBinding } from "../src/index.ts";

const BASE = mkdtempSync(join(tmpdir(), "xueness-mcp-pool-"));
const FIXTURE = join(import.meta.dirname, "runtime-fixture.mjs");
const FAKE = join(import.meta.dirname, "fake-server.mjs");
const WS = join(BASE, "workspace");
mkdirSync(WS, { recursive: true });
after(() => rmSync(BASE, { recursive: true, force: true }));

const fixture = (id: string, flags: string[] = [], env: Record<string, string> = {}) => ({
  id, command: process.execPath, args: [FIXTURE, ...flags.map((flag) => `--${flag}`)], env,
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(check: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) { if (check()) return; await wait(10); }
  assert.fail(message);
}
function lines(path: string): string[] { try { return readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean); } catch { return []; } }

describe("MCP connection pool leases (F06.01)", () => {
  it("retires an old lease without closing the newer connection (generations)", async () => {
    const kernel = Context.create();
    const pool = new McpConnectionPool(kernel);
    const initLog = join(BASE, "gen-init.log");
    const env = { MCP_INIT_FILE: initLog };
    const first = await pool.acquire(fixture("gen", [], env), WS);
    const second = await pool.acquire(fixture("gen", [], { ...env, MCP_SETTING: "v2" }), WS);
    assert.ok(first && second);
    assert.notEqual(first.connectionId, second.connectionId);
    assert.equal(first.generation, 1);
    assert.equal(second.generation, 2);
    const newest = pool.snapshot().servers.find((server) => server.serverId === "gen");
    assert.equal(newest?.connectionId, second.connectionId);
    assert.deepEqual(newest?.capabilities, ["tools"]);
    await first.release();
    await first.release(); // a double release is a no-op
    assert.equal(first.client.active, false);
    assert.equal(second.client.active, true);
    const after = pool.snapshot().servers.find((server) => server.serverId === "gen");
    assert.equal(after?.generation, 2);
    assert.equal(after?.connectionId, second.connectionId);
    assert.equal(after?.status, "connected");
    assert.equal(lines(initLog).length, 2);
    await second.release();
    await pool.close();
    await kernel.dispose();
  });

  it("parallel leases share one connection and one run ending keeps it live", async () => {
    const kernel = Context.create();
    const pool = new McpConnectionPool(kernel);
    const initLog = join(BASE, "parallel-init.log");
    const server = fixture("shared", [], { MCP_INIT_FILE: initLog });
    const leases = await Promise.all([pool.acquire(server, WS), pool.acquire(server, WS), pool.acquire(server, WS)]);
    assert.ok(leases.every((lease) => lease));
    assert.equal(new Set(leases.map((lease) => lease!.connectionId)).size, 1);
    assert.equal(lines(initLog).length, 1);
    await leases[0]!.release();
    assert.equal(leases[1]!.client.active, true);
    const again = await pool.acquire(server, WS);
    assert.equal(again!.connectionId, leases[1]!.connectionId);
    assert.equal(lines(initLog).length, 1);
    await Promise.all([leases[1]!.release(), leases[2]!.release(), again!.release()]);
    assert.equal(leases[1]!.client.active, false);
    await pool.close();
    await kernel.dispose();
  });

  it("keeps an idle connection for the grace period and replaces a dead one with a new generation", async () => {
    const kernel = Context.create();
    const pool = new McpConnectionPool(kernel, { idleGraceMs: 4000 });
    const server = { id: "grace", command: process.execPath, args: [FAKE, "--exit-after-call"] };
    const first = await pool.acquire(server, WS);
    assert.ok(first);
    assert.equal((await first.client.callTool("echo", { text: "x" })).text, "echo: x");
    await first.release();
    await eventually(() => !first.client.active, "server exit did not disconnect the client");
    const revived = await pool.acquire(server, WS);
    assert.ok(revived);
    assert.notEqual(revived.connectionId, first.connectionId);
    assert.equal(revived.generation, 2);
    assert.equal(revived.client.active, true);
    const snapshot = pool.snapshot().servers.find((server) => server.serverId === "grace");
    assert.equal(snapshot?.status, "connected");
    assert.equal(snapshot?.generation, 2);
    assert.deepEqual(snapshot?.capabilities, ["tools"]);
    await revived.release();
    await pool.close();
    await kernel.dispose();
  });

  it("retries a failed connection as a new generation and bounds the handshake by the configured timeout", async () => {
    const kernel = Context.create();
    const pool = new McpConnectionPool(kernel, { idleGraceMs: 4000 });
    const broken = { id: "broken", command: process.execPath, args: ["-e", "process.exit(3)"] };
    assert.equal(await pool.acquire(broken, WS), null);
    let snapshot = pool.snapshot().servers.find((server) => server.serverId === "broken");
    assert.equal(snapshot?.status, "failed");
    const firstConnection = snapshot?.connectionId;
    assert.equal(await pool.acquire(broken, WS), null); // the grace period must not resurrect a failure
    snapshot = pool.snapshot().servers.find((server) => server.serverId === "broken");
    assert.equal(snapshot?.status, "failed");
    assert.notEqual(snapshot?.connectionId, firstConnection);
    assert.equal(snapshot?.generation, 2);
    const silent = { id: "silent", command: process.execPath, args: ["-e", "setInterval(() => {}, 60000)"], timeout: 0.2 };
    const started = Date.now();
    assert.equal(await pool.acquire(silent, WS), null);
    assert.ok(Date.now() - started >= 180, "handshake timeout did not bound acquire");
    await pool.close();
    await kernel.dispose();
  });

  it("closing the pool stops new connections at once and kills the connecting child", async () => {
    const kernel = Context.create();
    const pool = new McpConnectionPool(kernel);
    const initLog = join(BASE, "stop-init.log");
    const closeLog = join(BASE, "stop-close.log");
    const slow = fixture("slow", ["slow-init=400"], { MCP_INIT_FILE: initLog, MCP_CLOSE_FILE: closeLog });
    const pending = pool.acquire(slow, WS);
    await eventually(() => lines(initLog).length === 1, "slow server did not start");
    await pool.close();
    assert.equal(await pending, null);
    await eventually(() => lines(closeLog).length >= 1, "connecting child was not terminated");
    assert.equal(pool.closed, true);
    await assert.rejects(pool.acquire(slow, WS), /closed/);
    await kernel.dispose();
  });

  it("disabling the plugin stops its servers at once and clears the runtime port", async () => {
    const kernel = Context.create();
    const binding: McpRuntimeBinding = {};
    const logs = ["s1", "s2"].map((id) => ({ init: join(BASE, `${id}-init.log`), pid: join(BASE, `${id}-pid.log`) }));
    const servers = ["s1", "s2"].map((id, index) => fixture(id, [], { MCP_INIT_FILE: logs[index]!.init, MCP_PID_FILE: logs[index]!.pid }));
    const host = new PluginHost(kernel, [createMcp({ run: () => ({ servers, cwd: WS }), binding })], { enabled: { mcp: false } });
    await host.start();
    await host.enable("mcp");
    assert.ok(binding.current);
    assert.equal(kernel.tools.list().filter((tool) => tool.name.startsWith("mcp__s")).length, 2);
    const pids = logs.map(({pid}) => Number(lines(pid)[0]));
    assert.ok(pids.every(pid => Number.isSafeInteger(pid) && pid > 0));
    await host.disable("mcp");
    assert.equal(binding.current, undefined);
    assert.equal(kernel.tools.list().filter((tool) => tool.name.startsWith("mcp__s")).length, 0);
    await eventually(() => pids.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } }), "server processes were not terminated on disable");
    await host.dispose();
    await kernel.dispose();
  });
});
