/**
 * The worker protocol and the six tools over a fake bridge (no browser, no
 * network): Python `_BrowserBroker` limits and failure texts, restart after a
 * stop, credential-free environment, managed profile checks, the per-state
 * registry and `heldElsewhere`. Cases follow tests/test_browser_snapshot.py,
 * tests/test_parity_browser.py and tests/test_browser_runtime.py.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { PROJECT_ROOT } from "../../../test-support/python-oracle.ts";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createToolEnv, runTool } from "@xueness/engine-tools";
import { BRIDGE, browserTools, currentWorker, heldElsewhere, managedProfile, shutdownBrowser, workerCommand, workerEnvironment, workerFor, type WorkerSpawn } from "../src/index.ts";

type Row = Record<string, unknown>;
const FAKE = join(import.meta.dirname, "fake-bridge.mjs");
const POSIX = process.platform !== "win32";
let spawned = 0;
const testSpawn: WorkerSpawn = (file, args, options) => {
  spawned += 1;
  const child = spawn(file, [...args], { ...options, stdio: ["pipe", "pipe", "ignore"] });
  return { child, release: async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await new Promise((done) => child.once("exit", done)); } } };
};
const temporary: string[] = [];
after(async () => { await shutdownBrowser(); for (const path of temporary) rmSync(path, { recursive: true, force: true }); });

function harness(mode = "ready", extra: Row = {}) {
  const base = mkdtempSync(join(tmpdir(), "xue-browser-")); temporary.push(base);
  const state = join(base, "state"), root = join(base, "root"); mkdirSync(state); mkdirSync(root);
  const env = { ...process.env, FAKE_BRIDGE: mode, OPENAI_API_KEY: "sk-test", GITHUB_TOKEN: "t", DB_PASSWORD: "p", ...extra } as NodeJS.ProcessEnv;
  const options = { bridge: FAKE, env, startTimeoutMs: 1500, callTimeoutMs: 1500 };
  const tools = new Map(browserTools({ worker: (cwd) => workerFor(state, cwd, testSpawn, options) }).map((tool) => [tool.name, tool]));
  const toolEnv = createToolEnv({ cwd: root, artifactsDir: join(base, "artifacts"), owner: "s1" });
  const call = async (name: string, args: Row = {}) => runTool(tools.get(name)!, args, toolEnv);
  return { state, root, call, tools };
}

describe("browser worker and tools", () => {
  it("runs each action through one persistent worker with the exact command", async () => {
    const h = harness();
    const before = spawned;
    const first = await h.call("browser_navigate", { url: "https://example.com/" });
    assert.equal(first.ok, true, first.output);
    const data = first.data as Row;
    assert.deepEqual(data.echo, { action: "navigate", url: "https://example.com/" });
    assert.deepEqual(data.leaked, [], "no credential-like variable reaches the worker");
    assert.equal(data.electron, null);
    const inspect = (await h.call("browser_inspect")).data as Row;
    assert.equal(inspect.count, 2); assert.equal(inspect.pid, data.pid);
    assert.equal(spawned - before, 1);
    const shot = await h.call("browser_screenshot");
    assert.equal((shot.data as Row).maxPngBytes, 450 * 1024);
    assert.ok(String((shot.data as Row).imageDataUrl).startsWith("data:image/png;base64,iVBORw0KG"));
    const snap = await h.call("browser_snapshot");
    assert.deepEqual(snap.data, { ok: true, url: "https://e.example/", title: "Fake", tree: '- button "Go" [ref=e1]', nodeCount: 1, totalNodes: 1, truncated: false, charTruncated: false, untrusted: true });
    assert.equal(snap.output, JSON.stringify(snap.data).replace(/,"/g, ', "').replace(/":/g, '": '));
    const fill = await h.call("browser_fill", { selector: "aria-ref=e1", text: "名字" });
    assert.deepEqual((fill.data as Row).echo, { action: "fill", selector: "aria-ref=e1", text: "名字" });
    const failed = await h.call("browser_click", { selector: "#fail" });
    assert.equal(failed.ok, false); assert.deepEqual(failed.error, { code: "execution_error", message: "browser action failed" });
    assert.equal(failed.output, '{"ok": false, "error": "browser action failed"}');
    if (POSIX) assert.equal(statSync(managedProfile(h.state)).mode & 0o777, 0o700, "the managed profile is private");
  });

  it("refuses bad arguments before any worker starts", async () => {
    const h = harness();
    const before = spawned;
    for (const [name, args, message] of [["browser_navigate", { url: "http://example.com/" }, "public HTTPS URL required"], ["browser_navigate", { url: "https://u:p@example.com/" }, "public HTTPS URL required"],
      ["browser_click", { selector: "" }, "bounded selector required"], ["browser_fill", { selector: "#q", text: "x".repeat(5001) }, "bounded text required"]] as const) {
      const result = await h.call(name, args as Row);
      assert.equal(result.ok, false); assert.equal(result.error?.message, message);
    }
    const extra = await h.call("browser_inspect", { script: "document.cookie" });
    assert.equal(extra.ok, false, "additionalProperties: false, as Python's schema");
    assert.equal(spawned, before);
  });

  it("closes the worker on protocol faults and starts a fresh one next time", async () => {
    const h = harness();
    const cases: [string, string][] = [["https://big.example/", "browser worker returned invalid output"], ["https://bad.example/", "browser worker returned invalid JSON"],
      ["https://array.example/", "browser worker returned an invalid response"], ["https://nobool.example/", "browser worker returned an invalid response"],
      ["https://hang.example/", "browser worker timed out or stopped"], ["https://exit.example/", "browser worker returned invalid output"]];
    let pid: unknown = null;
    for (const [url, message] of cases) {
      const ok = await h.call("browser_inspect");
      assert.equal(ok.ok, true); assert.notEqual((ok.data as Row).pid, pid); pid = (ok.data as Row).pid;
      const result = await h.call("browser_navigate", { url });
      assert.equal(result.ok, false, url); assert.equal(result.error?.message, message, url);
      assert.equal(currentWorker(h.state), null, `${url} closes the worker`);
    }
    const edge = await h.call("browser_navigate", { url: "https://edge.example/" });
    assert.equal(edge.ok, true, "a response of exactly 1 MB with its newline is accepted");
  });

  it("refuses an oversized request without stopping the worker", async () => {
    const h = harness();
    assert.equal((await h.call("browser_inspect")).ok, true);
    const result = await h.call("browser_fill", { selector: "x".repeat(1000), text: "😀".repeat(5000) });
    assert.equal(result.ok, true, "20 KB is under the 100 KB request limit");
    const worker = currentWorker(h.state)!;
    await assert.rejects(worker.call({ action: "fill", selector: "#q", text: "x".repeat(100_001) }), /browser request exceeds the size limit/);
    assert.ok(currentWorker(h.state));
  });

  it("reports start failures with Python's reasons", async () => {
    for (const [mode, extra, message] of [["noready", {}, "browser worker could not start: browser_missing"], ["noready", { FAKE_REASON: "driver_missing" }, "browser worker could not start: driver_missing"],
      ["noready", { FAKE_REASON: "evil" }, "browser worker could not start: invalid_response"], ["garbage", {}, "browser worker could not start: invalid_response"],
      ["silent", {}, "browser worker did not start; Node, Playwright and Chromium are required"]] as const) {
      const h = harness(mode, extra);
      const result = await h.call("browser_inspect");
      assert.equal(result.ok, false); assert.equal(result.error?.message, message, mode);
      assert.equal(currentWorker(h.state), null);
    }
  });

  it("rejects unsafe managed profiles", { skip: !POSIX && "symlinks need privileges on Windows" }, async () => {
    const h = harness();
    writeFileSync(join(h.state, "browser-profile"), "not a directory");
    assert.equal((await h.call("browser_inspect")).error?.message, "profile_invalid");
    const g = harness();
    const elsewhere = mkdtempSync(join(tmpdir(), "xue-browser-elsewhere-")); temporary.push(elsewhere);
    symlinkSync(elsewhere, join(g.state, "browser-profile"));
    assert.equal((await g.call("browser_inspect")).error?.message, "profile_invalid");
    const linked = mkdtempSync(join(tmpdir(), "xue-browser-linked-")); temporary.push(linked);
    symlinkSync(g.root, join(linked, "state"));
    assert.throws(() => managedProfile(join(linked, "state")), /profile_invalid/);
  });

  it("shares one worker per state directory and stops it on shutdown", async () => {
    const h = harness();
    const a = (await h.call("browser_inspect")).data as Row;
    const other = new Map(browserTools({ worker: (cwd) => workerFor(h.state, cwd, testSpawn, { bridge: FAKE, env: { ...process.env, FAKE_BRIDGE: "ready" } }) }).map((tool) => [tool.name, tool]));
    const b = (await runTool(other.get("browser_inspect")!, {}, createToolEnv({ cwd: h.root, artifactsDir: join(h.root, "..", "a2"), owner: "s2" }))).data as Row;
    assert.equal(a.pid, b.pid, "a second session environment reuses the same worker");
    await shutdownBrowser(h.state);
    assert.equal(currentWorker(h.state), null);
    const c = (await h.call("browser_inspect")).data as Row;
    assert.notEqual(c.pid, a.pid);
  });

  it("detects a Chromium singleton this process does not own", { skip: !POSIX && "SingletonLock is POSIX" }, async () => {
    const h = harness();
    const profile = managedProfile(h.state); mkdirSync(profile, { recursive: true });
    assert.equal(heldElsewhere(h.state), false);
    symlinkSync(`${hostname()}-${process.pid}`, join(profile, "SingletonLock"));
    assert.equal(heldElsewhere(h.state), true);
    rmSync(join(profile, "SingletonLock"));
    symlinkSync(`${hostname()}-2147483646`, join(profile, "SingletonLock"));
    assert.equal(heldElsewhere(h.state), false, "a stale lock from a dead process does not count");
    rmSync(join(profile, "SingletonLock"));
    symlinkSync(`other-host-${process.pid}`, join(profile, "SingletonLock"));
    assert.equal(heldElsewhere(h.state), false);
    rmSync(join(profile, "SingletonLock"));
    symlinkSync(`${hostname()}-${process.pid}`, join(profile, "SingletonLock"));
    await h.call("browser_inspect");
    assert.equal(heldElsewhere(h.state), false, "our own worker is not someone else's");
  });

  it("builds Python's worker command and environment", () => {
    assert.deepEqual(workerCommand("/p", {}), ["node", [BRIDGE, "/p"]]);
    assert.deepEqual(workerCommand("/p", { XUENESS_DESKTOP_NODE: "/opt/Xueness" }), ["/opt/Xueness", [BRIDGE, "/p"]]);
    assert.deepEqual(workerEnvironment({ PATH: "/bin", api_key: "x", MY_TOKEN: "t", Secret: "s", XUENESS_DESKTOP_NODE: "/n", passwordish: "p", credentials: "c" }), { PATH: "/bin", XUENESS_DESKTOP_NODE: "/n", ELECTRON_RUN_AS_NODE: "1" });
  });

  const pythonBridge = join(PROJECT_ROOT, "xueness", "bundled_plugins", "browser", "bridge.mjs");
  it("ships the Python bridge byte for byte", { skip: existsSync(pythonBridge) ? false : "no Python backend to compare with" }, () => {
    assert.deepEqual(readFileSync(BRIDGE), readFileSync(pythonBridge));
  });
});
