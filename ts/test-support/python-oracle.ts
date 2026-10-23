/**
 * Run the Python backend as a test oracle.
 *
 * Differential tests feed the same input to the TypeScript port and to the
 * original Python code and require identical output. They are skipped when
 * `XUENESS_SKIP_PYTHON_TESTS=1` or when Python / the backend is unavailable.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Project root containing the Python `xueness/` package. */
export const PROJECT_ROOT = resolve(process.env.XUENESS_PROJECT_ROOT ?? join(here, "..", ".."));

export const PYTHON = process.env.XUENESS_PYTHON ?? (process.platform === "win32" ? "python" : "python3");

let cachedReason: string | null | undefined;

/** Why Python tests cannot run here, or null when the oracle is available. */
export function pythonUnavailableReason(): string | null {
  if (cachedReason !== undefined) return cachedReason;
  if (process.env.XUENESS_SKIP_PYTHON_TESTS === "1") cachedReason = "XUENESS_SKIP_PYTHON_TESTS=1";
  else if (!existsSync(join(PROJECT_ROOT, "xueness", "events.py"))) cachedReason = `no Python backend at ${PROJECT_ROOT}`;
  else {
    const probe = spawnSync(PYTHON, ["-c", "import sys; print(sys.version_info[:2] >= (3, 11))"], { encoding: "utf8" });
    cachedReason = probe.status === 0 && probe.stdout.trim() === "True" ? null : `${PYTHON} >= 3.11 not found`;
  }
  return cachedReason;
}

let cachedOld: boolean | undefined;

/**
 * True when the oracle is a 3.11 release older than 3.11.17, i.e. without the urlsplit bracket,
 * ipaddress private-range and html.parser CDATA security backports. TS keeps the patched behaviour;
 * the few version-dependent cases are then not compared.
 */
export function pythonPredatesSecurityBackports(): boolean {
  if (cachedOld === undefined) cachedOld = spawnSync(PYTHON, ["-c", "import sys; print(sys.version_info[:3] < (3, 11, 17))"], { encoding: "utf8" }).stdout.trim() === "True";
  return cachedOld;
}

/** Run a Python snippet with the backend importable; stdin is UTF-8 text. */
export function runPython(code: string, input = ""): string {
  const result = spawnSync(PYTHON, ["-c", code], {
    cwd: PROJECT_ROOT,
    input,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, PYTHONPATH: PROJECT_ROOT, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
  });
  if (result.status !== 0) {
    throw new Error(`python failed (${result.status}): ${result.stderr || result.error?.message}`);
  }
  return result.stdout;
}

/**
 * Async variant of `runPython`: keeps the event loop free, so the snippet can
 * talk to servers hosted by the test process itself.
 */
export function runPythonAsync(code: string, input = "", timeoutMs = 120_000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(PYTHON, ["-c", code], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PYTHONPATH: PROJECT_ROOT, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      if (status === 0) resolvePromise(Buffer.concat(out).toString("utf8"));
      else reject(new Error(`python failed (${status ?? signal}): ${Buffer.concat(err).toString("utf8")}`));
    });
    child.stdin.end(input, "utf8");
  });
}

export interface PythonToolFacts {
  gate: string;
  mutating: boolean;
  concurrencySafe: boolean;
}

const TOOL_FACTS_SCRIPT = `
import importlib, json
from xueness import plugin_runtime as pr
facts = {}
for pid in pr.PLUGIN_IDS:
    module = importlib.import_module('xueness.bundled_plugins.%s.plugin' % pid)
    for tool in (module.tools() if hasattr(module, 'tools') else ()):
        facts[tool.name] = {'gate': tool.gate_kind, 'mutating': tool.mutating, 'concurrencySafe': tool.concurrency_safe}
print(json.dumps(facts))
`;

/** Gate kind and flags of every tool the Python bundled plugins define, by tool name. */
export function pythonToolFacts(): Record<string, PythonToolFacts> {
  return JSON.parse(runPython(TOOL_FACTS_SCRIPT)) as Record<string, PythonToolFacts>;
}
