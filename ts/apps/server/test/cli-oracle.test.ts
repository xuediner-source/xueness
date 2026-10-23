/** The TypeScript `xueness` CLI against Python `python -m xueness` on twin fresh state directories. */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { PROJECT_ROOT, PYTHON, pythonUnavailableReason } from "../../../test-support/python-oracle.ts";

const skip = pythonUnavailableReason() ?? false;
const MAIN = join(import.meta.dirname, "..", "src", "cli", "main.ts");
const scratch = mkdtempSync(join(tmpdir(), "xueness-cli-oracle-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

interface Outcome { code: number | null; stdout: string; stderr: string }

function run(command: string, args: string[], input: string): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PYTHONPATH: PROJECT_ROOT, XUENESS_ALLOW_REAL: "0", NO_COLOR: "1" };
    const child = spawn(command, args, { cwd: scratch, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

/** Differences that are expected: state paths, wall-clock stamps, the built-in prompt's source file, the version. */
function normalize(text: string, state: string): string {
  return text.split(state).join("STATE")
    .replace(/\S*(xueness\/bundled_plugins\/commands\/builtin_prompts\.py|ts\/plugins\/commands\/src\/builtin-prompts\.ts)/g, "BUILTIN")
    .replace(/\S*(xueness\/bundled_plugins\/commands|ts\/plugins\/commands\/src)(?=["\s])/g, "BUILTIN_DIR")
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)?/g, "TIME")
    .replace(/"xuenessVersion":\s*"[^"]*"/g, '"xuenessVersion":"VERSION"');
}

class Twins {
  readonly python = mkdtempSync(join(scratch, "py-"));
  readonly node = mkdtempSync(join(scratch, "ts-"));

  /** Run one command line on both sides; resolve with both normalized outcomes. */
  async both(argv: string[], input = ""): Promise<[Outcome, Outcome]> {
    const [py, ts] = await Promise.all([
      run(PYTHON, ["-m", "xueness", "--state", this.python, ...argv], input),
      run(process.execPath, [MAIN, "--state", this.node, ...argv], input),
    ]);
    const clean = (o: Outcome, state: string): Outcome => ({ code: o.code, stdout: normalize(o.stdout, state), stderr: normalize(o.stderr, state) });
    return [clean(py, this.python), clean(ts, this.node)];
  }

  async same(argv: string[], input = ""): Promise<Outcome> {
    const [py, ts] = await this.both(argv, input);
    assert.deepEqual(ts, py, `xueness ${argv.join(" ")}`);
    return ts;
  }
}

describe("xueness CLI matches Python", { skip }, () => {
  it("prints the read-only listings identically on a fresh state", async () => {
    const twins = new Twins();
    for (const line of ["sessions list", "list", "settings", "usage", "providers list", "memory-tracks", "automation list",
      "automation offpeak list", "automation offpeak settings", "resources list skills", "skills list --json", "commands list",
      "commands list --json", "mcp list --json", "hooks trust status --json", "workflow list", "jobs list", "workflows list"]) {
      await twins.same(line.split(" "));
    }
  });

  it("reports missing items and bad paths with the same messages and exit codes", async () => {
    const twins = new Twins();
    const missing = join(scratch, "missing");
    const cases: string[][] = [["plugins", "show", "nope"], ["plugins", "validate", missing], ["automation", "create", join(missing, "a.json")],
      ["automation", "run", "x"], ["skills", "inspect", "nope"], ["goal", "--session", "nope"], ["bots", "list"], ["remote", "list"]];
    for (const argv of cases) await twins.same(argv);
    const failed = await twins.same(["automation", "run", "x"]);
    assert.equal(failed.code, 1);
  });

  it("rejects bad command lines like argparse", async () => {
    const twins = new Twins();
    for (const argv of [["sessions", "bogus"], ["run"], ["providers"], ["goal", "--session"], ["--version"]]) {
      const outcome = await twins.same(argv);
      if (argv[0] !== "--version") assert.equal(outcome.code, 2);
    }
  });

  it("saves, lists and removes remote connections once the plugin is enabled", async () => {
    const twins = new Twins();
    await twins.same(["plugins", "enable", "remote"]);
    await twins.same(["remote", "save", "box", "--host", "example.invalid", "--user", "me", "--port", "2222"]);
    await twins.same(["remote", "list"]);
    await twins.same(["remote", "save", "win", "--host", "w.invalid", "--user", "me", "--system", "windows"]);
    await twins.same(["remote", "list"]);
    await twins.same(["remote", "remove", "box"]);
    await twins.same(["remote", "remove", "box"]);
    await twins.same(["remote", "list"]);
    await twins.same(["bots", "list"]);
  });

  it("serves the same JSON-RPC replies from app-server", async () => {
    const twins = new Twins();
    await twins.same(["plugins", "enable", "remote"]);
    const frames = [
      { jsonrpc: "2.0", id: 1, method: "nope" }, "not json", { jsonrpc: "2.0", id: 2, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 3, method: "session/list", params: {} }, { jsonrpc: "2.0", id: 4, method: "initialize", params: { protocolVersion: 9 } },
      { jsonrpc: "2.0", method: "nope" }, [1], { jsonrpc: "2.0", id: 5, method: "shutdown" }, { jsonrpc: "2.0", method: "exit" },
    ];
    const input = frames.map((frame) => typeof frame === "string" ? frame : JSON.stringify(frame)).join("\n") + "\n";
    const outcome = await twins.same(["app-server"], input);
    assert.equal(outcome.code, 0);
    const replies = outcome.stdout.trim().split("\n").map((line) => JSON.parse(line) as { id?: unknown; error?: { code: number } });
    assert.deepEqual(replies.slice(0, 2).map((reply) => reply.error?.code), [-32601, -32700]);
  });

  it("refuses app-server while the remote plugin is disabled", async () => {
    const outcome = await new Twins().same(["app-server"], "");
    assert.equal(outcome.code, 1);
  });

  it("creates and lists a session the same way", async () => {
    const twins = new Twins();
    const workspace = mkdtempSync(join(scratch, "ws-"));
    writeFileSync(join(workspace, "README.md"), "hello\n");
    const [py, ts] = await twins.both(["new", "--root", workspace, "Oracle task"]);
    assert.equal(ts.code, py.code);
    assert.equal(ts.stderr, py.stderr);
    assert.equal(ts.code, 0);
    const [pyList, tsList] = await twins.both(["sessions", "list"]);
    assert.equal(tsList.code, pyList.code);
    assert.equal(tsList.stdout.trim().split("\n").length, pyList.stdout.trim().split("\n").length);
  });
});
