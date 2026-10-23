/**
 * M2 exit criterion: plugins start and stop at run time, and stopping one
 * releases everything it acquired. Each cycle compares Node's own list of
 * live handles (timers, sockets, servers, child processes, pipes) with the
 * baseline, and checks that every spawned process, background grandchildren
 * included, has ended.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { programName } from "@xueness/contracts";
import { Context, PluginHost } from "@xueness/kernel";
import { bundle } from "./support/manifests.ts";

const POSIX = process.platform !== "win32";
const NODE = programName(process.execPath);
const emitter = new EventEmitter();

/** Live handles and requests by type, as Node reports them (Timeout, TCPSocketWrap, ProcessWrap, ...). */
function activeResources(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const type of process.getActiveResourcesInfo()) counts[type] = (counts[type] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

/** A zombie (exited, not yet reaped by init) counts as ended. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  if (process.platform !== "linux") return true;
  try {
    return !/^\d+ \(.*\) Z/s.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

/** Closed handles leave Node's list a few loop turns later. */
async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await sleep(10);
}

function firstLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    const onData = (chunk: Buffer | string): void => {
      text += String(chunk);
      if (!text.includes("\n")) return;
      stream.off("data", onData);
      resolve(text.slice(0, text.indexOf("\n")));
    };
    stream.on("data", onData);
    stream.once("error", reject);
  });
}

const pids: number[] = [];
const PROBE = { name: "leaky_probe", gate: "read", mutating: false, concurrencySafe: true };

/** Acquires one of everything a plugin can hold through its context. */
const leaky = bundle("leaky", {
  provides: ["leaky.api"],
  capabilities: { exec: POSIX ? ["sh", NODE] : [NODE], net: { connect: ["loopback"], listen: ["loopback"] } },
  tools: [PROBE],
}, async (ctx) => {
  ctx.setInterval(() => {}, 1000);
  ctx.setTimeout(() => {}, 60_000);
  ctx.on("leaky/ping", () => {});
  ctx.subscribe(emitter, "tick", () => {});
  ctx.provide("leaky.api", { ping: () => "pong" });
  ctx.tool({ ...PROBE, requires: {} });
  // A server that never finishes its response, and a request reading that endless body.
  const server = createServer((_request, response) => {
    response.writeHead(200);
    response.write("partial");
  });
  const { port } = await ctx.serve(server, { host: "127.0.0.1", port: 0 });
  const response = await ctx.fetch(`http://127.0.0.1:${port}/`);
  await response.body?.getReader().read();
  if (POSIX) {
    // The background sleep outlives the shell unless the whole process group is ended.
    const shell = ctx.spawn("sh", ["-c", "sleep 60 & echo $!; sleep 60"], { stdio: ["ignore", "pipe", "ignore"] });
    pids.push(shell.pid as number, Number(await firstLine(shell.stdout as NodeJS.ReadableStream)));
  }
  pids.push(ctx.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }).pid as number);
});

const consumer = bundle("consumer", { dependencies: ["leaky"], inject: ["leaky.api"] }, (ctx) => {
  ctx.setInterval(() => {}, 1000);
  assert.equal(ctx.get<{ ping(): string }>("leaky.api").ping(), "pong");
});

describe("plugin hot reload", () => {
  it("returns to the exact baseline after every disable", async () => {
    // stdio streams are created on first use; make sure that is not counted as a leak.
    void process.stdout;
    void process.stderr;
    const kernel = Context.create();
    const host = new PluginHost(kernel, [leaky, consumer], { enabled: { leaky: false } });
    await host.start();
    const snapshot = () => ({
      resources: activeResources(), listeners: kernel.listenerCount(), services: kernel.serviceNames().sort(),
      tools: kernel.tools.size, emitter: emitter.listenerCount("tick"),
    });
    const baseline = snapshot();
    assert.deepEqual([host.status("consumer").state, host.status("consumer").blockedBy], ["blocked", ["leaky"]]);
    const extra = (now: Record<string, number>, type: string): number => (now[type] ?? 0) - (baseline.resources[type] ?? 0);
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      pids.length = 0;
      const enabled = await host.enable("leaky");
      assert.equal(enabled.state, "active", enabled.error ?? "");
      assert.deepEqual([host.status("consumer").state, host.status("consumer").activations], ["active", cycle]);
      const loaded = snapshot();
      assert.ok(extra(loaded.resources, "Timeout") >= 3, "two leaky timers and the consumer's interval");
      assert.deepEqual([extra(loaded.resources, "TCPServerWrap"), extra(loaded.resources, "ProcessWrap")], [1, POSIX ? 2 : 1]);
      assert.ok(extra(loaded.resources, "TCPSocketWrap") >= 2, "both ends of the open request");
      assert.deepEqual([loaded.tools - baseline.tools, loaded.emitter - baseline.emitter], [1, 1]);
      assert.deepEqual(loaded.services, ["leaky.api", "plugin.consumer", "plugin.leaky"]);
      assert.equal(pids.length, POSIX ? 3 : 1);
      assert.deepEqual(pids.filter((pid) => !alive(pid)), []);

      const disabled = await host.disable("leaky");
      assert.deepEqual([disabled.state, host.status("consumer").state], ["disabled", "blocked"]);
      await until(() => isDeepStrictEqual(snapshot(), baseline));
      assert.deepEqual(snapshot(), baseline, `cycle ${cycle} left something behind`);
      assert.deepEqual(pids.filter(alive), [], "every process of the plugin, grandchildren included, has ended");
    }
    await host.dispose();
    await kernel.dispose();
  });

  it("stops a plugin whose activation hangs, and refuses what it acquires afterwards", async () => {
    const kernel = Context.create();
    let resume = (): void => {};
    const resumed = new Promise<void>((done) => {
      resume = done;
    });
    let late: unknown = null;
    const slow = bundle("slow", {}, async (ctx) => {
      ctx.setInterval(() => {}, 1000);
      await resumed;
      try {
        ctx.setInterval(() => {}, 1000);
      } catch (error) {
        late = error;
        throw error;
      }
    });
    const host = new PluginHost(kernel, [slow], { settleTimeoutMs: 50 });
    const before = activeResources();
    const [status] = await host.start();
    assert.equal(status?.state, "activating");
    assert.equal((await host.disable("slow")).state, "disabled");
    resume();
    await until(() => late !== null && isDeepStrictEqual(activeResources(), before));
    assert.equal((late as Error | null)?.name, "ScopeInactiveError");
    assert.deepEqual(activeResources(), before);
    await host.dispose();
    await kernel.dispose();
  });

  it("rolls back an activation that fails halfway", async () => {
    const kernel = Context.create();
    const spawned: number[] = [];
    const failing = bundle("failing", { capabilities: { exec: [NODE] } }, (ctx) => {
      ctx.setInterval(() => {}, 1000);
      ctx.subscribe(emitter, "tick", () => {});
      spawned.push(ctx.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }).pid as number);
      throw new Error("boom");
    });
    const host = new PluginHost(kernel, [failing]);
    const before = activeResources();
    const [status] = await host.start();
    assert.deepEqual([status?.state, status?.error, status?.activations], ["failed", "boom", 1]);
    await until(() => isDeepStrictEqual(activeResources(), before));
    assert.deepEqual(activeResources(), before);
    assert.deepEqual([emitter.listenerCount("tick"), spawned.filter(alive)], [0, []]);
    await host.dispose();
    await kernel.dispose();
  });
});
