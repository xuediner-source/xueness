/** H04.05 sandbox verifier (worktree/container isolation + snapshot rollback) and H04.06 `verify` wiring. */
import assert from "node:assert/strict";
import { join, normalize, sep } from "node:path";
import { describe, it } from "node:test";
import {
  containerCommand, createSandboxVerifier, sandboxVerifyCommand, withSandboxedVerify,
  type GateDefinition, type GateRun, type SandboxFs,
} from "../src/index.ts";
import { createHarnessApi, HarnessRegistry } from "../src/index.ts";

/** In-memory SandboxFs: a flat map of file paths to contents. */
function memoryFs(initial: Record<string, string> = {}): SandboxFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial).map(([path, content]) => [normalize(path), content]));
  return {
    files,
    list(dir) {
      const base = normalize(dir).replace(/[\\/]+$/, "") + sep;
      return [...files.keys()].filter((path) => path.startsWith(base)).map((path) => path.slice(base.length).split(sep).join("/")).sort();
    },
    read: (path) => {
      const content = files.get(normalize(path));
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    write: (path, content) => void files.set(normalize(path), content),
    mkdir: () => {},
    remove: (path) => {
      const normalized = normalize(path);
      for (const key of files.keys()) if (key === normalized || key.startsWith(normalized + sep)) files.delete(key);
    },
    exists: (path) => files.has(normalize(path)),
  };
}

const gate = (name: string, command: readonly string[] = ["true"], watch?: readonly string[]): GateDefinition => ({ name, command, watch });
const ok = (): GateRun => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false });
const fail = (stderr = "boom"): GateRun => ({ exitCode: 1, stdout: "", stderr, timedOut: false });

interface RunnerCall { gate: string; command: readonly string[]; cwd: string; }

/**
 * Scripted gate runner: per-gate results, optional side effects on the fs
 * (simulating a gate that mutates the tree), recording every call.
 */
function scripted(results: Record<string, GateRun>, effects: ((cwd: string) => void)[] = []) {
  const calls: RunnerCall[] = [];
  return {
    calls,
    async run(g: GateDefinition, cwd: string): Promise<GateRun> {
      calls.push({ gate: g.name, command: g.command, cwd });
      for (const effect of effects) effect(cwd);
      const result = results[g.name];
      if (!result) throw new Error(`no result scripted for gate ${g.name}`);
      return result;
    },
  };
}

const workspace = { "src/a.ts": "export const a = 1;\n", "src/b.ts": "export const b = 2;\n", "node_modules/pkg/index.js": "skip me" };
const gates = [gate("typecheck"), gate("test")];

function verifier(overrides: Record<string, unknown> = {}) {
  const fs = memoryFs({ ...Object.fromEntries(Object.entries(workspace).map(([path, content]) => [join("/work", path), content])) });
  return { fs, verifier: createSandboxVerifier({ gates, cwd: "/work", sandboxRoot: "/sandboxes", fs, ...overrides }) };
}

describe("sandbox isolation (H04.05)", () => {
  it("clones the workspace into an isolated root and never runs gates in the source", async () => {
    const { fs, verifier: verifierInstance } = verifier({ keep: "always", run: scripted({ typecheck: ok(), test: ok() }).run });
    const result = await verifierInstance.verify();
    assert.equal(result.passed, true);
    assert.ok(result.sandbox.root.startsWith(normalize("/sandboxes") + sep), "sandbox must live under sandboxRoot");
    assert.notEqual(result.sandbox.root, "/work");
    assert.equal(result.sandbox.source, "/work");
    assert.deepEqual([...fs.files.keys()].filter((path) => path.startsWith(normalize("/sandboxes") + sep) && path.endsWith("a.ts")).length, 1, "clone contains src/a.ts");
    assert.equal(fs.files.get(join("/work", "src/a.ts")), "export const a = 1;\n", "source untouched");
  });

  it("runs gates with cwd inside the sandbox and skips excluded prefixes when cloning", async () => {
    const { fs } = verifier();
    const runner = scripted({ typecheck: ok(), test: ok() });
    const result = await createSandboxVerifier({ gates, cwd: "/work", sandboxRoot: "/sandboxes", fs, run: runner.run, keep: "always" }).verify();
    assert.ok(result.passed, JSON.stringify(result.outcomes.map((outcome) => outcome.diagnostics)));
    assert.equal(runner.calls.length, 2);
    assert.ok(runner.calls.every((call) => call.cwd.startsWith(normalize("/sandboxes") + sep) && call.cwd !== "/work"));
    assert.deepEqual(fs.list(result.sandbox.root), ["src/a.ts", "src/b.ts"], "clone holds the sources and skips node_modules");
  });

  it("keeps no sandbox after a passing verify (keep: onFailure default)", async () => {
    const { fs, verifier: verifierInstance } = verifier({ run: scripted({ typecheck: ok(), test: ok() }).run });
    const result = await verifierInstance.verify();
    assert.equal(result.keptRoot, null);
    assert.deepEqual(fs.list("/sandboxes"), [], "sandbox directory disposed");
  });
});

describe("snapshot rollback on gate failure (H04.05)", () => {
  it("restores mutated files and removes files added after the snapshot", async () => {
    const { fs, verifier: verifierInstance } = verifier({
      run: scripted({ typecheck: fail("type error"), test: ok() }, [
        (cwd) => fs.write(join(cwd, "src/a.ts"), "mutated"),
        (cwd) => fs.write(join(cwd, "src/generated.ts"), "new"),
      ]).run,
    });
    const result = await verifierInstance.verify();
    assert.equal(result.passed, false);
    assert.equal(result.rolledBack, true);
    assert.deepEqual(result.restored, ["src/a.ts"]);
    assert.deepEqual(result.removed, ["src/generated.ts"]);
    const kept = fs.list(result.sandbox.root);
    assert.deepEqual(kept, ["src/a.ts", "src/b.ts"], "sandbox content equals the snapshot");
    assert.equal(fs.files.get(join(result.sandbox.root, "src/a.ts")), "export const a = 1;\n");
  });

  it("keeps the sandbox on failure for inspection and reports it as keptRoot", async () => {
    const { fs, verifier: verifierInstance } = verifier({ run: scripted({ typecheck: fail(), test: fail() }).run });
    const result = await verifierInstance.verify();
    assert.equal(result.keptRoot, result.sandbox.root);
    assert.notDeepEqual(fs.list(result.sandbox.root), [], "sandbox kept on disk");
    assert.match(result.summary, /sandbox rolled back to snapshot$/);
  });

  it("honours keep: never and keep: always", async () => {
    const never = verifier({ keep: "never", run: scripted({ typecheck: fail(), test: fail() }).run });
    assert.equal((await never.verifier.verify()).keptRoot, null);
    const always = verifier({ keep: "always", run: scripted({ typecheck: ok(), test: ok() }).run });
    assert.notEqual((await always.verifier.verify()).keptRoot, null);
  });

  it("never rolls anything back into the source workspace", async () => {
    const { fs, verifier: verifierInstance } = verifier({
      run: scripted({ typecheck: fail() }, [(cwd) => fs.write(join(cwd, "src/a.ts"), "mutated")]).run,
    });
    await verifierInstance.verify();
    assert.equal(fs.files.get(join("/work", "src/a.ts")), "export const a = 1;\n");
    assert.equal(fs.files.get("/work/src/generated.ts"), undefined);
  });

  it("reports a passing pass with empty rollback fields", async () => {
    const result = await verifier({ run: scripted({ typecheck: ok(), test: ok() }).run }).verifier.verify();
    assert.equal(result.rolledBack, false);
    assert.deepEqual(result.restored, []);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.outcomes.map((outcome) => outcome.gate), ["typecheck", "test"]);
  });
});

describe("container sandboxes (H04.05)", () => {
  it("wraps gate commands in a docker invocation bound to the sandbox root", () => {
    const wrapped = containerCommand({ image: "node:24" }, gate("typecheck", ["tsc"]), "/sandboxes/c1");
    assert.deepEqual(wrapped.command, ["docker", "run", "--rm", "-v", "/sandboxes/c1:/workspace", "-w", "/workspace", "node:24", "tsc"]);
  });

  it("runs the wrapped commands and honours a custom workdir", async () => {
    const runner = scripted({ typecheck: ok(), test: ok() });
    const { verifier: verifierInstance } = verifier({
      kind: "container", container: { image: "node:24", workdir: "/srv" }, run: runner.run,
    });
    const result = await verifierInstance.verify();
    assert.equal(result.sandbox.kind, "container");
    assert.equal(result.passed, true);
    assert.ok(runner.calls.every((call) => call.command[0] === "docker" && call.command.includes("node:24") && call.command.includes("/srv")));
  });

  it("refuses a container sandbox without an image and validates gate tables", () => {
    assert.throws(() => verifier({ kind: "container" }).verifier, /container sandboxes need a container image/);
    assert.throws(() => createSandboxVerifier({ gates: [gate("  ")], cwd: "/work", fs: memoryFs() }), /non-empty name/);
    assert.throws(() => createSandboxVerifier({ gates: [gate("x", [])], cwd: "/work", fs: memoryFs() }), /non-empty command/);
  });
});

describe("harness verify integration (H04.06)", () => {
  it("verify with sandbox: true runs the gates inside a sandbox and reports the rollback decision", async () => {
    const fs = memoryFs({ ...Object.fromEntries(Object.entries(workspace).map(([path, content]) => [join("/work", path), content])) });
    const verifierInstance = createSandboxVerifier({ gates: [gate("typecheck")], cwd: "/work", sandboxRoot: "/sandboxes", fs, run: () => Promise.resolve(fail()) });
    const api = withSandboxedVerify(createHarnessApi(), verifierInstance);
    const row = await api.dispatch("deepseek_harness/verify", { sandbox: true });
    assert.equal(row.ok, false);
    assert.equal(row.rolledBack, true);
    assert.equal((row.sandbox as Record<string, unknown>).kind, "worktree");
    assert.ok(Array.isArray(row.outcomes));
  });

  it("verify without the flag still answers from the registry (delegation)", async () => {
    const registry = new HarnessRegistry();
    const api = withSandboxedVerify(createHarnessApi({ registry }), createSandboxVerifier({
      gates: [gate("typecheck")], cwd: "/work", sandboxRoot: "/sandboxes", fs: memoryFs({ [join("/work", "a.ts")]: "x" }), run: () => Promise.resolve(ok()),
    }));
    const row = await api.dispatch("deepseek_harness/verify", { id: "missing" });
    assert.equal(row.ok, false);
    assert.deepEqual((row.items as Record<string, unknown>[]).map((item) => item.id), ["missing"], "registry verify answered");
    assert.equal((await api.dispatch("deepseek_harness/list", {})).ok, true);
  });

  it("sandboxVerifyCommand maps --sandbox to sandboxed execution and exit codes", async () => {
    const fs = memoryFs({ [join("/work", "a.ts")]: "x" });
    const base = { gates: [gate("typecheck")], cwd: "/work", sandboxRoot: "/sandboxes", fs };
    const passing = await sandboxVerifyCommand(["--sandbox"], createHarnessApi(), createSandboxVerifier({ ...base, run: () => Promise.resolve(ok()) }));
    assert.equal(passing.code, 0);
    const failing = await sandboxVerifyCommand(["--sandbox"], createHarnessApi(), createSandboxVerifier({ ...base, run: () => Promise.resolve(fail()) }));
    assert.equal(failing.code, 1);
    assert.equal(JSON.parse(failing.output).rolledBack, true);
    const registryOnly = await sandboxVerifyCommand([], createHarnessApi(), createSandboxVerifier({ ...base, run: () => Promise.resolve(ok()) }));
    assert.equal(JSON.parse(registryOnly.output).ok, true, "no flag: empty registry verifies ok");
  });

  it("only gates whose watch matches the edited paths run inside the sandbox", async () => {
    const runner = scripted({ typecheck: ok(), docs: ok() });
    const scoped = createSandboxVerifier({
      gates: [gate("typecheck", ["tsc"], ["src"]), gate("docs", ["mdlint"], ["docs"])],
      cwd: "/work", sandboxRoot: "/sandboxes", fs: memoryFs({ [join("/work", "src/a.ts")]: "x" }), run: runner.run,
    });
    const result = await scoped.verify(["src/a.ts"]);
    assert.deepEqual(result.outcomes.map((outcome) => outcome.gate), ["typecheck"]);
    assert.equal(result.passed, true);
  });
});

describe("H04 review regressions (deepseek-v4.1-flash, 1017 high)", () => {
  it("never clones a sandbox root nested inside the source, so the tree cannot copy itself", async () => {
    const fs = memoryFs({ [join("/work", "src/a.ts")]: "x" });
    const nested = createSandboxVerifier({ gates, fs, cwd: "/work", sandboxRoot: "/work/.sandboxes", run: () => Promise.resolve(ok()), keep: "always" });
    const result = await nested.verify();
    assert.equal(result.passed, true);
    const cloned = fs.list(result.sandbox.root);
    assert.deepEqual(cloned, ["src/a.ts"], "only real workspace files are cloned, never the sandbox root's own subtree");
  });

  it("restores a snapshot file deleted by a failing gate, not only in-place edits", async () => {
    const { fs, verifier: verifierInstance } = verifier({
      keep: "never",
      run: scripted({ typecheck: fail(), test: fail() }, [(cwd) => fs.remove(join(cwd, "src/b.ts"))]).run,
    });
    const result = await verifierInstance.verify();
    assert.equal(result.passed, false);
    assert.deepEqual(result.restored, ["src/b.ts"]);
    assert.equal(fs.files.has(join("/work", "src/b.ts")), true, "source workspace untouched");
  });

  it("does not execute gates when the plugin feature gate is disabled", async () => {
    const { fs, verifier: verifierInstance } = verifier({ run: () => Promise.resolve(ok()) });
    let enabled = false;
    const api = withSandboxedVerify(createHarnessApi({ enabled: () => enabled }), verifierInstance);
    const row = await api.dispatch("deepseek_harness/verify", { sandbox: true });
    assert.equal(row.ok, false);
    assert.equal((row.error as Record<string, unknown>).code, "disabled");
    assert.deepEqual([...fs.files.keys()].filter((path) => path.startsWith(normalize("/sandboxes") + sep)), [], "no sandbox was created");
    enabled = true;
    assert.equal((await api.dispatch("deepseek_harness/verify", { sandbox: true })).ok, true);
  });
});
