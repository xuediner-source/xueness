#!/usr/bin/env node
/**
 * The `xueness harness` command suite (H05.05): `install | list | run |
 * bench | doctor` over one installed-harness store, and its structured
 * exit codes + machine-readable reports (H05.06) — success exits 0, every
 * failure class has its own non-zero code, and every action prints one
 * JSON report that `JSON.parse` can read back.
 *
 * Exit codes (H05.06 contract):
 *   0  ok                     3  harness id not found
 *   1  IO / manifest error    4  `run` case failure
 *   2  usage error            5  `doctor` check failure
 *   6  `bench` failure or budget overrun
 *
 * The command is a pure function of (argv, deps): tests inject the store,
 * the manifest reader and the command runner; `fileDeps` wires the same
 * contract to `<state>/harnesses.json` and a shell runner.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the installed-harness registry lives inside the state directory. */
export const HARNESS_STORE_FILE = "harnesses.json";
/** Harness package manifest filename (same as the deepseek_harness plugin loader). */
export const HARNESS_MANIFEST_FILE = "deepseek-harness.json";
/** SDK apiVersion an installed harness manifest must target. */
export const HARNESS_SDK_API_VERSION = 1;
/** One verifier: a named command the `run`/`bench` actions execute. */
export const RUN_TIMEOUT_MS = 60_000;

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_NOT_FOUND = 3;
export const EXIT_RUN_FAILED = 4;
export const EXIT_DOCTOR_FAILED = 5;
export const EXIT_BENCH_FAILED = 6;

export interface HarnessVerifier {
  readonly name: string;
  readonly command: string;
}

export interface InstalledHarness {
  readonly id: string;
  readonly version: string;
  readonly source: string;
  readonly installedAt: string;
  readonly verifiers: readonly HarnessVerifier[];
}

export interface CommandOutcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

/** Every side effect the command needs; unit tests inject fakes. */
export interface HarnessCommandDeps {
  /** Installed rows, or null when the store is unreadable/corrupt. */
  readStore(): InstalledHarness[] | null;
  /** Does the store file exist at all (a fresh state dir has none)? */
  storeExists(): boolean;
  /** Persist rows; returns an error message or null on success. */
  writeStore(rows: readonly InstalledHarness[]): string | null;
  /** Read `<source>/deepseek-harness.json`; `error` explains a failure. */
  readManifest(source: string): { ok: true; manifest: Record<string, unknown> } | { ok: false; error: string };
  /** Execute one verifier command (shell string) and report the outcome. */
  runCommand(command: string): CommandOutcome;
  /** Does the installed harness source directory still exist? */
  pathExists(path: string): boolean;
  /** Current ISO timestamp for `installedAt` stamps. */
  now(): string;
}

export interface HarnessCommandResult {
  readonly code: number;
  readonly output: string;
  readonly report: Record<string, unknown>;
}

type Row = Record<string, unknown>;

const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const usage = "usage: xueness harness <install SOURCE | list | run ID | bench ID [--iterations N] [--max-ms MS] | doctor>";

/** Fail with a structured `{ ok: false, error }` report and a non-zero code. */
function fail(code: number, errorCode: string, message: string, extra: Row = {}): HarnessCommandResult {
  const report = { ok: false, error: { code: errorCode, message, ...extra } };
  return { code, output: JSON.stringify(report), report };
}

/** Parse a harness manifest record into an installed row, or list issues. */
export function parseInstalledManifest(record: Record<string, unknown>, source: string, installedAt: string): { ok: true; harness: InstalledHarness } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  if (record.sdkApiVersion !== HARNESS_SDK_API_VERSION) issues.push(`sdkApiVersion must be ${HARNESS_SDK_API_VERSION}`);
  const id = str(record.id);
  if (!id) issues.push("id must be a non-empty string");
  else if (!/^[a-z][a-z0-9-]*$/.test(id)) issues.push("id must match /^[a-z][a-z0-9-]*$/");
  const version = str(record.version);
  if (!version) issues.push("version must be a non-empty string");
  const verifiers: HarnessVerifier[] = [];
  if (Array.isArray(record.verifiers)) {
    for (const [index, raw] of record.verifiers.entries()) {
      const name = str((raw as Row)?.name), command = str((raw as Row)?.command);
      if (!name) issues.push(`verifiers[${index}].name must be a non-empty string`);
      else if (!command) issues.push(`verifiers[${index}].command must be a non-empty string`);
      else verifiers.push({ name, command });
    }
  } else issues.push("verifiers must be an array");
  if (issues.length) return { ok: false, issues };
  return { ok: true, harness: { id: id!, version: version!, source, installedAt, verifiers } };
}

/** Re-validate an already installed row (doctor uses this on stored data). */
function installedIssues(harness: InstalledHarness): string[] {
  const shim: Row = { sdkApiVersion: HARNESS_SDK_API_VERSION, id: harness.id, version: harness.version, verifiers: harness.verifiers };
  return parseInstalledManifest(shim, harness.source, harness.installedAt).ok ? [] : ["stored row no longer satisfies the harness contract"];
}

/** File-backed deps: JSON store under `stateDir`, shell runner, real clock. */
export function fileDeps(stateDir: string): HarnessCommandDeps {
  const storePath = join(stateDir, HARNESS_STORE_FILE);
  return {
    readStore() {
      try {
        const raw = readFileSync(storePath, "utf8");
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as InstalledHarness[]) : null;
      } catch { return null; }
    },
    storeExists: () => existsSync(storePath),
    writeStore(rows) {
      try {
        mkdirSync(dirname(storePath), { recursive: true });
        writeFileSync(storePath, JSON.stringify(rows, null, 2) + "\n");
        return null;
      } catch (error) { return error instanceof Error ? error.message : String(error); }
    },
    readManifest(source) {
      const path = join(source, HARNESS_MANIFEST_FILE);
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: `${path} is not a JSON object` };
        return { ok: true, manifest: parsed as Record<string, unknown> };
      } catch (error) { return { ok: false, error: `${path} is unreadable: ${error instanceof Error ? error.message : String(error)}` }; }
    },
    runCommand(command) {
      const startedAt = Date.now();
      const done = spawnSync(command, { shell: true, encoding: "utf8", timeout: RUN_TIMEOUT_MS });
      return { code: done.status, stdout: done.stdout ?? "", stderr: done.stderr ?? "", durationMs: Date.now() - startedAt };
    },
    pathExists: (path) => existsSync(path),
    now: () => new Date().toISOString(),
  };
}

export interface ParsedHarnessArgs {
  readonly action: "install" | "list" | "run" | "bench" | "doctor";
  readonly operand: string | null;
  readonly iterations: number;
  readonly maxMs: number | null;
}

const ACTIONS = ["install", "list", "run", "bench", "doctor"] as const;
const isAction = (value: string): value is (typeof ACTIONS)[number] => (ACTIONS as readonly string[]).includes(value);

/** Hand-rolled argv parse; every malformed invocation is a usage error. */
export function parseHarnessArgs(argv: readonly string[]): { ok: true; args: ParsedHarnessArgs } | { ok: false; message: string } {
  const rest = argv.filter((token) => token !== "--json");
  const [rawAction, ...tail] = rest;
  if (rawAction === undefined) return { ok: false, message: usage };
  if (!isAction(rawAction)) return { ok: false, message: `unknown action ${rawAction}\n${usage}` };
  const action = rawAction;
  const needs = (value: string | undefined, what: string): string =>
    value === undefined ? `${action} requires ${what}` : "";
  let operand: string | undefined, iterations = 3, maxMs: number | null = null, sawBenchFlag = false;
  const extra: string[] = [];
  for (let i = 0; i < tail.length; i++) {
    const token = tail[i];
    if (token === undefined) return { ok: false, message: usage };
    if (token === "--iterations" || token === "--max-ms") {
      const raw = tail[++i];
      if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) return { ok: false, message: `${token} requires a positive integer` };
      sawBenchFlag = true;
      if (token === "--iterations") iterations = Number.parseInt(raw, 10);
      else maxMs = Number.parseInt(raw, 10);
    } else if (token.startsWith("--")) return { ok: false, message: `unknown option ${token}` };
    else if (operand === undefined) operand = token;
    else extra.push(token);
  }
  if (extra.length) return { ok: false, message: `${action} takes at most one operand` };
  if ((action === "install" || action === "run" || action === "bench")) {
    const missing = action === "install" ? needs(operand, "a SOURCE path") : needs(operand, "a harness ID");
    if (missing) return { ok: false, message: missing };
  } else if (operand !== undefined) return { ok: false, message: `${action} takes no operand` };
  if (action !== "bench" && sawBenchFlag) return { ok: false, message: "--iterations/--max-ms are bench-only options" };
  return { ok: true, args: { action, operand: operand ?? null, iterations, maxMs } };
}

const findHarness = (rows: readonly InstalledHarness[], id: string): InstalledHarness | null =>
  rows.find((row) => row.id === id) ?? null;

/** `install SOURCE`: read + validate the manifest, upsert into the store. */
function installAction(deps: HarnessCommandDeps, source: string): HarnessCommandResult {
  const read = deps.readManifest(source);
  if (!read.ok) return fail(EXIT_ERROR, "manifest_unreadable", read.error);
  const parsed = parseInstalledManifest(read.manifest, source, deps.now());
  if (!parsed.ok) return fail(EXIT_ERROR, "invalid_manifest", `manifest for ${source} is invalid`, { issues: parsed.issues });
  const rows = deps.readStore();
  if (rows === null && deps.storeExists()) return fail(EXIT_ERROR, "store_unreadable", "installed-harness store is unreadable");
  const next = [...(rows ?? []).filter((row) => row.id !== parsed.harness.id), parsed.harness];
  const error = deps.writeStore(next);
  if (error !== null) return fail(EXIT_ERROR, "store_write_failed", error);
  const report = { schema: "xueness.harness.install/1", ok: true, harness: { id: parsed.harness.id, version: parsed.harness.version, verifiers: parsed.harness.verifiers.length } };
  return { code: EXIT_OK, output: JSON.stringify(report), report };
}

/** `list`: every installed harness as one JSON report (empty list is ok). */
function listAction(deps: HarnessCommandDeps): HarnessCommandResult {
  const rows = deps.readStore();
  if (rows === null) return fail(EXIT_ERROR, "store_unreadable", "installed-harness store is unreadable");
  const report = { schema: "xueness.harness.list/1", ok: true, count: rows.length, harnesses: rows.map(({ id, version, installedAt, verifiers }) => ({ id, version, installedAt, verifiers: verifiers.length })) };
  return { code: EXIT_OK, output: JSON.stringify(report), report };
}

interface CaseResult { name: string; command: string; ok: boolean; exitCode: number | null; durationMs: number }

const runVerifiers = (deps: HarnessCommandDeps, harness: InstalledHarness): CaseResult[] =>
  harness.verifiers.map(({ name, command }) => {
    const outcome = deps.runCommand(command);
    return { name, command, ok: outcome.code === 0, exitCode: outcome.code, durationMs: outcome.durationMs };
  });

/** `run ID`: execute every verifier once; any failure is exit 4. */
function runAction(deps: HarnessCommandDeps, id: string): HarnessCommandResult {
  const rows = deps.readStore();
  if (rows === null) return fail(EXIT_ERROR, "store_unreadable", "installed-harness store is unreadable");
  const harness = findHarness(rows, id);
  if (harness === null) return fail(EXIT_NOT_FOUND, "not_found", `no installed harness ${id}`, { id });
  const cases = runVerifiers(deps, harness);
  const passed = cases.filter((one) => one.ok).length;
  const report = { schema: "xueness.harness.run/1", id, ok: passed === cases.length, cases, summary: { total: cases.length, passed, failed: cases.length - passed } };
  return { code: passed === cases.length ? EXIT_OK : EXIT_RUN_FAILED, output: JSON.stringify(report), report };
}

/** `bench ID [--iterations N] [--max-ms MS]`: timing report; failure is exit 6. */
function benchAction(deps: HarnessCommandDeps, id: string, iterations: number, budgetMs: number | null): HarnessCommandResult {
  const rows = deps.readStore();
  if (rows === null) return fail(EXIT_ERROR, "store_unreadable", "installed-harness store is unreadable");
  const harness = findHarness(rows, id);
  if (harness === null) return fail(EXIT_NOT_FOUND, "not_found", `no installed harness ${id}`, { id });
  const perVerifier = harness.verifiers.map(({ name }) => ({ name, runsMs: [] as number[], failures: 0 }));
  for (let round = 0; round < iterations; round++) {
    for (const [index, verifier] of harness.verifiers.entries()) {
      const outcome = deps.runCommand(verifier.command);
      const slot = perVerifier[index]!;
      slot.runsMs.push(outcome.durationMs);
      if (outcome.code !== 0) slot.failures++;
    }
  }
  const allRuns = perVerifier.flatMap((slot) => slot.runsMs);
  const failed = perVerifier.reduce((sum, slot) => sum + slot.failures, 0);
  const meanMs = allRuns.length ? allRuns.reduce((sum, ms) => sum + ms, 0) / allRuns.length : 0;
  const overBudget = budgetMs !== null && meanMs > budgetMs;
  const ok = failed === 0 && !overBudget && allRuns.length > 0;
  const report = { schema: "xueness.harness.bench/1", id, ok, iterations, ...(budgetMs !== null ? { budgetMs } : {}), perVerifier, summary: { totalRuns: allRuns.length, failed, minMs: allRuns.length ? Math.min(...allRuns) : 0, meanMs: Math.round(meanMs * 100) / 100, maxMs: allRuns.length ? Math.max(...allRuns) : 0, opsPerSecond: meanMs > 0 ? Math.round((allRuns.length / (allRuns.length * meanMs / 1000)) * 100) / 100 : 0 } };
  return { code: ok ? EXIT_OK : EXIT_BENCH_FAILED, output: JSON.stringify(report), report };
}

/** `doctor`: read-only checks; any failing check is exit 5. */
function doctorAction(deps: HarnessCommandDeps): HarnessCommandResult {
  const rows = deps.readStore();
  const checks: { id: string; status: "pass" | "fail"; detail: string }[] = [
    { id: "store", status: rows === null ? "fail" : "pass", detail: rows === null ? "installed-harness store is unreadable or corrupt" : `${rows.length} installed harness(es)` },
  ];
  for (const harness of rows ?? []) {
    const issues = installedIssues(harness);
    checks.push({ id: `harness:${harness.id}`, status: issues.length ? "fail" : "pass", detail: issues.length ? issues.join("; ") : `v${harness.version}, ${harness.verifiers.length} verifier(s)` });
    if (harness.source) checks.push({ id: `source:${harness.id}`, status: deps.pathExists(harness.source) ? "pass" : "fail", detail: deps.pathExists(harness.source) ? harness.source : `${harness.source} is missing` });
  }
  const failed = checks.filter((check) => check.status === "fail").length;
  const ok = failed === 0;
  const report = { schema: "xueness.harness.doctor/1", ok, checks, summary: { total: checks.length, passed: checks.length - failed, failed } };
  return { code: ok ? EXIT_OK : EXIT_DOCTOR_FAILED, output: JSON.stringify(report), report };
}

export interface HarnessCommandOptions {
  /** Dependency bundle; defaults to `fileDeps(stateDir)`. */
  deps?: HarnessCommandDeps;
  /** State directory for the default file deps (default: `./.state`). */
  stateDir?: string;
}

/** Entry point: parse `xueness harness ...` argv and run one action. */
export function harnessCommand(argv: readonly string[], options: HarnessCommandOptions = {}): HarnessCommandResult {
  const parsed = parseHarnessArgs(argv);
  if (!parsed.ok) return fail(EXIT_USAGE, "usage", parsed.message);
  const deps = options.deps ?? fileDeps(options.stateDir ?? join(process.cwd(), ".state"));
  const { action, operand, iterations, maxMs } = parsed.args;
  try {
    if (action === "install") return installAction(deps, operand!);
    if (action === "list") return listAction(deps);
    if (action === "run") return runAction(deps, operand!);
    if (action === "bench") return benchAction(deps, operand!, iterations, maxMs);
    return doctorAction(deps);
  } catch (error) {
    return fail(EXIT_ERROR, "internal", error instanceof Error ? error.message : String(error));
  }
}

function isEntry(path: string): boolean {
  try { return realpathSync(path) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (process.argv[1] && isEntry(process.argv[1])) {
  const result = harnessCommand(process.argv.slice(2));
  process.stdout.write(result.output + "\n");
  process.exitCode = result.code;
}
