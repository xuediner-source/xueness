/** H05.05: the `xueness harness install|list|run|bench|doctor` suite; H05.06: structured exit codes + parseable reports. */
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  EXIT_BENCH_FAILED, EXIT_DOCTOR_FAILED, EXIT_ERROR, EXIT_NOT_FOUND, EXIT_OK, EXIT_RUN_FAILED, EXIT_USAGE,
  HARNESS_MANIFEST_FILE, HARNESS_STORE_FILE, type CommandOutcome, type HarnessCommandDeps, type InstalledHarness,
  fileDeps, harnessCommand, parseHarnessArgs,
} from "../src/commands/harness-cmd.ts";

const manifest = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  sdkApiVersion: 1,
  id: "critic-solver",
  version: "1.2.0",
  verifiers: [
    { name: "tests-pass", command: "pytest -q" },
    { name: "lint", command: "ruff check ." },
  ],
  ...over,
});

const installed = (over: Partial<InstalledHarness> = {}): InstalledHarness => ({
  id: "critic-solver",
  version: "1.2.0",
  source: "/src/critic-solver",
  installedAt: "2026-10-26T00:00:00.000Z",
  verifiers: [{ name: "tests-pass", command: "pytest -q" }],
  ...over,
});

interface FakeHarness {
  deps: HarnessCommandDeps;
  reads: { manifest: boolean; store: number };
  writes: InstalledHarness[][];
  commands: string[];
}

/**
 * In-memory deps: `store === null` simulates a corrupt store (only counts
 * when `storeExists` is true), `failCommands` force verifier failures, and
 * every `runCommand` call is recorded for call-count assertions.
 */
function fakeDeps(over: {
  manifest?: Record<string, unknown>;
  manifestError?: string;
  store?: InstalledHarness[] | null;
  storeExists?: boolean;
  durationMs?: number;
  failCommands?: string[];
  paths?: Set<string>;
} = {}): FakeHarness {
  const fake: FakeHarness = {
    deps: {} as HarnessCommandDeps,
    reads: { manifest: false, store: 0 },
    writes: [],
    commands: [],
  };
  const duration = over.durationMs ?? 12;
  fake.deps = {
    readStore: () => {
      fake.reads.store++;
      return over.store === undefined ? [] : over.store;
    },
    storeExists: () => over.storeExists ?? false,
    writeStore: (rows) => {
      fake.writes.push([...rows]);
      return null;
    },
    readManifest: () => {
      fake.reads.manifest = true;
      return over.manifestError ? { ok: false, error: over.manifestError } : { ok: true, manifest: over.manifest ?? manifest() };
    },
    runCommand: (command) => {
      fake.commands.push(command);
      const outcome: CommandOutcome = { code: over.failCommands?.includes(command) ? 1 : 0, stdout: "", stderr: "", durationMs: duration };
      return outcome;
    },
    pathExists: (path) => over.paths?.has(path) ?? true,
    now: () => "2026-10-26T08:00:00.000Z",
  };
  return fake;
}

const run = (argv: readonly string[], fake = fakeDeps()) => ({ fake, result: harnessCommand(argv, { deps: fake.deps }) });

/** Every action's output must survive `JSON.parse` (H05.06 report contract). */
const parse = (output: string): Record<string, any> => {
  const parsed: unknown = JSON.parse(output);
  assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed));
  return parsed as Record<string, any>;
};

describe("H05.05 install", () => {
  it("installs a valid manifest, upserts the store, and reports the row", () => {
    const { fake, result } = run(["install", "/src/critic-solver"], fakeDeps({ store: [installed({ id: "other" })], storeExists: true }));
    assert.equal(result.code, EXIT_OK);
    const report = parse(result.output);
    assert.equal(report.schema, "xueness.harness.install/1");
    assert.deepEqual(report.harness, { id: "critic-solver", version: "1.2.0", verifiers: 2 });
    assert.equal(fake.writes.length, 1);
    assert.deepEqual(fake.writes[0]!.map((row) => row.id), ["other", "critic-solver"]);
    assert.equal(fake.writes[0]![1]!.installedAt, "2026-10-26T08:00:00.000Z");
  });

  it("replaces a previous install of the same id instead of duplicating it", () => {
    const { result } = run(["install", "/src/critic-solver"], fakeDeps({ store: [installed({ version: "0.1.0" })], storeExists: true }));
    assert.equal(result.code, EXIT_OK);
    assert.equal(parse(result.output).harness.version, "1.2.0");
  });

  it("starts a fresh store when the state directory has none", () => {
    const { fake, result } = run(["install", "/src/critic-solver"], fakeDeps({ store: null, storeExists: false }));
    assert.equal(result.code, EXIT_OK);
    assert.equal(fake.writes[0]!.length, 1);
  });

  it("refuses to touch a corrupt existing store", () => {
    const { fake, result } = run(["install", "/src/critic-solver"], fakeDeps({ store: null, storeExists: true }));
    assert.equal(result.code, EXIT_ERROR);
    assert.equal(parse(result.output).error.code, "store_unreadable");
    assert.equal(fake.writes.length, 0);
  });

  it("surfaces an unreadable manifest as a non-zero structured error", () => {
    const { result } = run(["install", "/src/gone"], fakeDeps({ manifestError: "/src/gone/deepseek-harness.json is unreadable: ENOENT" }));
    assert.equal(result.code, EXIT_ERROR);
    assert.equal(parse(result.output).error.code, "manifest_unreadable");
  });

  it("rejects invalid manifests with per-field issues", () => {
    for (const [label, over] of [
      ["wrong sdk version", { sdkApiVersion: 2 }],
      ["malformed id", { id: "Bad Id" }],
      ["empty verifier command", { verifiers: [{ name: "tests", command: " " }] }],
    ] as const) {
      const { result } = run(["install", "/src/x"], fakeDeps({ manifest: manifest(over) }));
      assert.notEqual(result.code, EXIT_OK, label);
      const report = parse(result.output);
      assert.equal(report.error.code, "invalid_manifest", label);
      assert.ok((report.error.issues as string[]).length > 0, label);
    }
  });
});

describe("H05.05 list", () => {
  it("lists installed harnesses with counts", () => {
    const { result } = run(["list"], fakeDeps({ store: [installed(), installed({ id: "repo-map" })], storeExists: true }));
    assert.equal(result.code, EXIT_OK);
    const report = parse(result.output);
    assert.equal(report.schema, "xueness.harness.list/1");
    assert.equal(report.count, 2);
    assert.deepEqual((report.harnesses as { id: string }[]).map((row) => row.id), ["critic-solver", "repo-map"]);
  });

  it("an empty store is a successful empty list", () => {
    const { result } = run(["list"], fakeDeps({ store: [], storeExists: true }));
    assert.equal(result.code, EXIT_OK);
    assert.equal(parse(result.output).count, 0);
  });

  it("a corrupt store is a non-zero error", () => {
    const { result } = run(["list"], fakeDeps({ store: null, storeExists: true }));
    assert.equal(result.code, EXIT_ERROR);
    assert.equal(parse(result.output).error.code, "store_unreadable");
  });
});

describe("H05.05 run", () => {
  it("runs every verifier once and reports the pass summary", () => {
    const { fake, result } = run(["run", "critic-solver"], fakeDeps({ store: [installed({ verifiers: [{ name: "a", command: "cmd-a" }, { name: "b", command: "cmd-b" }] })], storeExists: true }));
    assert.equal(result.code, EXIT_OK);
    const report = parse(result.output);
    assert.equal(report.schema, "xueness.harness.run/1");
    assert.equal(report.ok, true);
    assert.deepEqual(fake.commands, ["cmd-a", "cmd-b"]);
    assert.deepEqual(report.summary, { total: 2, passed: 2, failed: 0 });
  });

  it("a failing verifier is exit 4 with the failing case recorded", () => {
    const { result } = run(["run", "critic-solver"], fakeDeps({ store: [installed({ verifiers: [{ name: "ok", command: "cmd-ok" }, { name: "bad", command: "cmd-bad" }] })], storeExists: true, failCommands: ["cmd-bad"] }));
    assert.equal(result.code, EXIT_RUN_FAILED);
    const report = parse(result.output);
    assert.equal(report.ok, false);
    assert.equal((report.cases as { name: string; ok: boolean }[])[1]!.ok, false);
    assert.deepEqual(report.summary, { total: 2, passed: 1, failed: 1 });
  });

  it("an unknown id is exit 3", () => {
    const { result } = run(["run", "ghost"], fakeDeps({ store: [], storeExists: true }));
    assert.equal(result.code, EXIT_NOT_FOUND);
    assert.equal(parse(result.output).error.code, "not_found");
  });
});

describe("H05.05 + H05.06 bench", () => {
  const benchStore = (): InstalledHarness[] => [installed({ verifiers: [{ name: "a", command: "cmd-a" }, { name: "b", command: "cmd-b" }] })];

  it("bench --iterations N runs every verifier N times and reports timing stats", () => {
    const { fake, result } = run(["bench", "critic-solver", "--iterations", "4"], fakeDeps({ store: benchStore(), storeExists: true, durationMs: 25 }));
    assert.equal(result.code, EXIT_OK);
    const report = parse(result.output);
    assert.equal(report.schema, "xueness.harness.bench/1");
    assert.equal(report.ok, true);
    assert.equal(fake.commands.length, 8);
    assert.deepEqual(report.summary, { totalRuns: 8, failed: 0, minMs: 25, meanMs: 25, maxMs: 25, opsPerSecond: 40 });
    for (const slot of report.perVerifier as { runsMs: number[] }[]) assert.equal(slot.runsMs.length, 4);
  });

  it("a failing bench run is exit 6", () => {
    const { result } = run(["bench", "critic-solver"], fakeDeps({ store: benchStore(), storeExists: true, failCommands: ["cmd-b"] }));
    assert.equal(result.code, EXIT_BENCH_FAILED);
    assert.equal(parse(result.output).summary.failed, 3);
  });

  it("exceeding --max-ms is exit 6 even when every run succeeds", () => {
    const { result } = run(["bench", "critic-solver", "--max-ms", "10"], fakeDeps({ store: benchStore(), storeExists: true, durationMs: 25 }));
    assert.equal(result.code, EXIT_BENCH_FAILED);
    const report = parse(result.output);
    assert.equal(report.ok, false);
    assert.equal(report.budgetMs, 10);
    assert.equal(report.summary.failed, 0);
  });

  it("an unknown id is exit 3 and the report carries the id", () => {
    const { result } = run(["bench", "ghost"], fakeDeps({ store: [], storeExists: true }));
    assert.equal(result.code, EXIT_NOT_FOUND);
    assert.equal(parse(result.output).error.id, "ghost");
  });
});

describe("H05.06 doctor", () => {
  it("a healthy install passes with exit 0", () => {
    const { result } = run(["doctor"], fakeDeps({ store: [installed({ source: "/src/critic-solver" })], storeExists: true, paths: new Set(["/src/critic-solver"]) }));
    assert.equal(result.code, EXIT_OK);
    const report = parse(result.output);
    assert.equal(report.schema, "xueness.harness.doctor/1");
    assert.equal(report.ok, true);
    assert.deepEqual(report.summary, { total: 3, passed: 3, failed: 0 });
    assert.deepEqual((report.checks as { id: string }[]).map((check) => check.id), ["store", "harness:critic-solver", "source:critic-solver"]);
  });

  it("a corrupt store fails the store check with exit 5", () => {
    const { result } = run(["doctor"], fakeDeps({ store: null, storeExists: true }));
    assert.equal(result.code, EXIT_DOCTOR_FAILED);
    const report = parse(result.output);
    assert.equal(report.ok, false);
    assert.equal((report.checks as { id: string }[])[0]!.id, "store");
  });

  it("a stored row that violates the contract fails its harness check", () => {
    const { result } = run(["doctor"], fakeDeps({ store: [installed({ verifiers: [{ name: "tests", command: "" }] })], storeExists: true }));
    assert.equal(result.code, EXIT_DOCTOR_FAILED);
    const checks = parse(result.output).checks as { id: string; status: string }[];
    assert.equal(checks.find((check) => check.id === "harness:critic-solver")!.status, "fail");
  });

  it("a missing source directory fails the source check", () => {
    const { result } = run(["doctor"], fakeDeps({ store: [installed({ source: "/src/gone" })], storeExists: true, paths: new Set() }));
    assert.equal(result.code, EXIT_DOCTOR_FAILED);
    const checks = parse(result.output).checks as { id: string; status: string }[];
    assert.equal(checks.find((check) => check.id === "source:critic-solver")!.status, "fail");
  });

  it("an empty but readable store is healthy", () => {
    const { result } = run(["doctor"], fakeDeps({ store: [], storeExists: true }));
    assert.equal(result.code, EXIT_OK);
    assert.equal(parse(result.output).summary.total, 1);
  });
});

describe("H05.06 usage errors and the exit-code contract", () => {
  it("malformed invocations are exit 2 with a usage message", () => {
    for (const argv of [[], ["nonsense"], ["install"], ["run"], ["bench"], ["list", "extra"], ["doctor", "x"], ["run", "id", "--iterations", "2"], ["bench", "id", "--iterations", "0"], ["bench", "id", "--iterations"], ["bench", "id", "--wat"], ["run", "a", "b"]]) {
      const { result } = run(argv);
      assert.equal(result.code, EXIT_USAGE, argv.join(" "));
      assert.equal(parse(result.output).error.code, "usage", argv.join(" "));
    }
  });

  it("success is exactly 0 and every failure class has its own non-zero code", () => {
    const ok = harnessCommand(["list"], { deps: fakeDeps({ store: [], storeExists: true }).deps });
    assert.equal(ok.code, EXIT_OK);
    const cases: [readonly string[], number][] = [
      [["nope"], EXIT_USAGE],
      [["list"], EXIT_ERROR],
      [["run", "ghost"], EXIT_NOT_FOUND],
      [["run", "critic-solver"], EXIT_RUN_FAILED],
      [["doctor"], EXIT_DOCTOR_FAILED],
      [["bench", "critic-solver"], EXIT_BENCH_FAILED],
    ];
    for (const [argv, expected] of cases) {
      const base = argv[0] === "list" ? { store: null, storeExists: true } : { store: [installed({ verifiers: [{ name: "v", command: "boom" }] })], storeExists: true, failCommands: ["boom"], durationMs: 50, paths: new Set<string>() };
      const { result } = run(argv, fakeDeps(base));
      assert.equal(result.code, expected, argv.join(" "));
      assert.notEqual(result.code, EXIT_OK, argv.join(" "));
    }
  });

  it("every action output is one JSON.parse-able document", () => {
    const results = [
      run(["install", "/src/x"]),
      run(["list"]),
      run(["run", "ghost"]),
      run(["bench", "ghost"]),
      run(["doctor"]),
    ];
    for (const { result } of results) parse(result.output);
  });

  it("parseHarnessArgs accepts --json anywhere and defaults bench iterations", () => {
    const parsed = parseHarnessArgs(["--json", "bench", "id", "--iterations", "2", "--json"]);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.args, { action: "bench", operand: "id", iterations: 2, maxMs: null });
  });
});

describe("H05.05 fileDeps smoke (real files, real runner)", () => {
  const root = mkdtempSync(join(tmpdir(), "xueness-harness-cmd-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "critic-solver");
  const state = join(root, ".state");

  it("installs from a real manifest file, lists from the store, runs real commands", () => {
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, HARNESS_MANIFEST_FILE), JSON.stringify(manifest({ verifiers: [{ name: "ok", command: "node -e ''" }, { name: "bad", command: 'node -e "process.exit(9)"' }] })));
    const deps = fileDeps(state);
    const installedResult = harnessCommand(["install", source], { deps });
    assert.equal(installedResult.code, EXIT_OK);
    assert.ok(deps.storeExists());
    const listed = harnessCommand(["list"], { deps });
    assert.equal(listed.code, EXIT_OK);
    assert.equal(parse(listed.output).count, 1);
    const ran = harnessCommand(["run", "critic-solver"], { deps });
    assert.equal(ran.code, EXIT_RUN_FAILED);
    const cases = parse(ran.output).cases as { name: string; ok: boolean; exitCode: number | null }[];
    assert.deepEqual(cases.map((one) => [one.ok, one.exitCode]), [[true, 0], [false, 9]]);
    const doctored = harnessCommand(["doctor"], { deps });
    assert.equal(doctored.code, EXIT_OK);
  });

  it("doctor fails once the installed source directory disappears", () => {
    const deps = fileDeps(state);
    rmSync(source, { recursive: true, force: true });
    const result = harnessCommand(["doctor"], { deps });
    assert.equal(result.code, EXIT_DOCTOR_FAILED);
    assert.equal(parse(result.output).ok, false);
  });

  it("a store file that is not a JSON array reads as corrupt", () => {
    writeFileSync(join(state, HARNESS_STORE_FILE), "{oops");
    const result = harnessCommand(["list"], { deps: fileDeps(state) });
    assert.equal(result.code, EXIT_ERROR);
    assert.equal(parse(result.output).error.code, "store_unreadable");
  });
});
