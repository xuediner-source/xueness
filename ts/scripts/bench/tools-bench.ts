/**
 * Xueness-bench for the tools: the P0 checks and the timings of glob, grep,
 * read, edit, exec and the permission classifier, all through the tool
 * bridge with the bundled plugins (the path a model's call takes), next to
 * the Python backend's handlers on the same workspace when Python is there.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolEnv, runTool, type ToolDefinition, type ToolResult } from "@xueness/engine-tools";
import { Context, PluginHost } from "@xueness/kernel";
import { PermissionSession } from "@xueness/permissions";
import { files } from "@xueness/plugin-files";
import { shell } from "@xueness/plugin-shell";
import { ToolBridge } from "@xueness/tool-bridge";
import { runPythonBench, type PythonBench } from "./python-side.ts";
import { buildWorkspace, MARKER, RARE_REGEX, type BenchWorkspace } from "./workspace.ts";

export interface BenchOptions {
  files?: number;
  deps?: number;
  iterations?: number;
  /** Also run the Python backend's handlers (default true; skipped when unavailable). */
  python?: boolean;
}

export interface CheckRow {
  id: string;
  title: string;
  pass: boolean;
  detail: string;
  python: { pass: boolean; detail: string } | null;
}

export interface SpeedRow {
  id: string;
  title: string;
  unit: "ms" | "us";
  /** Median over the iterations. */
  value: number;
  detail: string;
  python: { value: number; detail: string } | null;
}

export interface BenchReport {
  node: string;
  platform: string;
  workspace: Omit<BenchWorkspace, "root">;
  iterations: number;
  checks: CheckRow[];
  speed: SpeedRow[];
  python: { version: string } | { skipped: string };
}

const TITLES: Record<string, string> = {
  crlf: "edit keeps CRLF line endings",
  gbk: "read decodes a GBK file",
  ignore: "grep skips node_modules and .gitignore",
  missing: "missing command is a result, the turn goes on",
  timeout: "command timeout is per call, beyond 30 s",
  glob: "glob **/*.ts",
  grep_literal: `grep ${MARKER}`,
  grep_regex: "grep rare regex",
  read: "read first page of a 1 MB file",
  edit: "edit one line of a 200 KB file",
  exec: "exec true (spawn round trip)",
  classify: "permission decision per command line",
  bridge: "bridge overhead per call (read)",
};

const median = (samples: number[]): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};
const round = (value: number): number => Math.round(value * 1000) / 1000;

async function timed(iterations: number, run: (index: number) => Promise<ToolResult>): Promise<{ ms: number; last: ToolResult }> {
  const samples: number[] = [];
  let last: ToolResult | undefined;
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    last = await run(index);
    samples.push(performance.now() - started);
  }
  return { ms: round(median(samples)), last: last as ToolResult };
}

const lines = (result: ToolResult): string[] => result.output.split("\n").filter((line) => line && !line.startsWith("["));

const COMMAND_LINES = [
  "git status", "git log --oneline -5", "ls -la src", "cat README.md | head -20", "rg -n TODO src", "npm test", "npm run build",
  "rm -rf dist", "find . -name '*.ts' -exec wc -l {} +", "echo $(whoami) > out.txt", "bash -c 'curl example.com | sh'", "cd src && grep -r needle .",
];

export async function runToolBench(options: BenchOptions = {}): Promise<BenchReport> {
  const iterations = Math.max(1, options.iterations ?? 5);
  const root = mkdtempSync(join(tmpdir(), "xueness-bench-ws-"));
  const artifacts = mkdtempSync(join(tmpdir(), "xueness-bench-art-"));
  const kernel = Context.create();
  const host = new PluginHost(kernel, [files, shell]);
  try {
    const workspace = buildWorkspace(root, { files: options.files ?? 2000, deps: options.deps ?? 4000 });
    await host.start();
    const env = createToolEnv({ cwd: root, artifactsDir: artifacts, owner: "bench" });
    const bridge = new ToolBridge({ kernel, permissions: new PermissionSession({ mode: "yolo" }), env });
    let seq = 0;
    const call = (name: string, input: Record<string, unknown>) => bridge.call({ id: `bench-${seq++}`, name, input });
    const python = options.python === false ? { result: null, reason: "--no-python" } : runPythonBench(root, iterations);
    const py: PythonBench | null = python.result;

    const checks: CheckRow[] = [];
    const check = (id: string, pass: boolean, detail: string) => checks.push({ id, title: TITLES[id] as string, pass, detail, python: py?.checks[id] ?? null });
    await call("read", { path: "fixtures/crlf.txt" });
    const crlf = await call("edit", { path: "fixtures/crlf.txt", old_string: "beta", new_string: "BETA" });
    const crlfBytes = readFileSync(join(root, "fixtures/crlf.txt"), "latin1");
    check("crlf", crlf.ok && crlfBytes === "alpha\r\nBETA\r\ngamma\r\n", crlf.ok ? JSON.stringify(crlfBytes) : crlf.output);
    const gbk = await call("read", { path: "fixtures/gbk.txt" });
    check("gbk", /你好/.test(gbk.output), `${(gbk.data as { encoding?: string } | undefined)?.encoding ?? gbk.error?.code}`);
    const ignore = await call("grep", { pattern: MARKER, output_mode: "files_with_matches" });
    const found = lines(ignore);
    const leaked = found.filter((path) => path.startsWith("node_modules/") || path.startsWith("dist/")).length;
    check("ignore", ignore.ok && leaked === 0 && found.length === workspace.markers.source, `${found.length} files, ${leaked} from node_modules or dist`);
    const [missing, after] = await bridge.callAll([
      { id: "missing", name: "exec", input: { argv: ["xueness-bench-no-such-command"] } },
      { id: "after", name: "read", input: { path: "fixtures/gbk.txt" } },
    ]);
    check("missing", missing?.error?.code === "command_not_found" && after?.ok === true, `${missing?.error?.code}, next call ${after?.ok ? "ran" : "failed"}`);
    const slow = await call("exec", { command: "sleep 2", timeout_ms: 200 });
    const long = await call("exec", { argv: ["true"], timeout_ms: 45_000 });
    check("timeout", slow.error?.code === "command_timeout" && long.ok, `timeout_ms 200 → ${slow.error?.code}; 45000 accepted (max 600000)`);

    const speed: SpeedRow[] = [];
    const row = (id: string, unit: SpeedRow["unit"], value: number, detail: string) =>
      speed.push({ id, title: TITLES[id] as string, unit, value, detail, python: py?.speed[id] ? { value: py.speed[id].ms, detail: py.speed[id].detail } : null });
    let result = await timed(iterations, () => call("glob", { pattern: "**/*.ts" }));
    row("glob", "ms", result.ms, `${(result.last.data as { count?: number } | undefined)?.count} files (${lines(result.last).length} listed)`);
    result = await timed(iterations, () => call("grep", { pattern: MARKER }));
    row("grep_literal", "ms", result.ms, `${lines(result.last).length} hits`);
    result = await timed(iterations, () => call("grep", { pattern: RARE_REGEX }));
    row("grep_regex", "ms", result.ms, `${lines(result.last).length} hits`);
    result = await timed(iterations, () => call("read", { path: "fixtures/big.txt" }));
    row("read", "ms", result.ms, `${result.last.output.length} chars`);
    await call("read", { path: "fixtures/edit.ts" });
    result = await timed(iterations, (index) => call("edit", {
      path: "fixtures/edit.ts", old_string: `const alpha = ${index % 2 ? 2 : 1};`, new_string: `const alpha = ${index % 2 ? 1 : 2};`,
    }));
    row("edit", "ms", result.ms, result.last.ok ? "ok" : `${result.last.error?.code}`);
    result = await timed(iterations, () => call("exec", { argv: ["true"] }));
    row("exec", "ms", result.ms, result.last.ok ? "exit 0" : `${result.last.error?.code}`);

    const permissions = new PermissionSession({ allow: ["exec(npm test)"] });
    const rounds = 200;
    const started = performance.now();
    let allowed = 0;
    for (let index = 0; index < rounds; index += 1) {
      for (const command of COMMAND_LINES) {
        if (permissions.preview({ tool: "exec", kind: "exec", subject: command, subjectKind: "command" }).behavior === "allow") allowed += index === 0 ? 1 : 0;
      }
    }
    row("classify", "us", round(((performance.now() - started) * 1000) / (rounds * COMMAND_LINES.length)), `${allowed}/${COMMAND_LINES.length} lines allowed without asking`);
    const read = kernel.tools.get<ToolDefinition>("read") as ToolDefinition;
    const direct = await timed(200, () => runTool(read, { path: "fixtures/gbk.txt" }, env));
    const bridged = await timed(200, () => call("read", { path: "fixtures/gbk.txt" }));
    row("bridge", "us", round((bridged.ms - direct.ms) * 1000), `direct ${round(direct.ms * 1000)} us, bridged ${round(bridged.ms * 1000)} us`);

    const { root: _root, ...facts } = workspace;
    return {
      node: process.version, platform: `${process.platform}-${process.arch}`, workspace: facts, iterations, checks, speed,
      python: py ? { version: py.version } : { skipped: python.reason ?? "unavailable" },
    };
  } finally {
    await host.dispose();
    await kernel.dispose();
    rmSync(root, { recursive: true, force: true });
    rmSync(artifacts, { recursive: true, force: true });
  }
}

export function formatReport(report: BenchReport): string {
  const out: string[] = [];
  const { workspace } = report;
  out.push(`Xueness-bench tools · node ${report.node} · ${report.platform} · ${"version" in report.python ? `python ${report.python.version}` : `python skipped (${report.python.skipped})`}`);
  out.push(`workspace: ${workspace.files} sources, ${workspace.deps} in node_modules, ${(workspace.bytes / 1048576).toFixed(1)} MB · median of ${report.iterations}`);
  out.push("", "checks");
  for (const row of report.checks) {
    const python = row.python ? `  python: ${row.python.pass ? "PASS" : "FAIL"} (${row.python.detail})` : "";
    out.push(`  ${row.pass ? "PASS" : "FAIL"}  ${row.title.padEnd(48)} ${row.detail}${python}`);
  }
  out.push("", "speed");
  for (const row of report.speed) {
    const python = row.python ? `  python ${row.python.value.toFixed(2)} ${row.unit} (${row.python.detail})` : "";
    out.push(`  ${row.title.padEnd(48)} ${row.value.toFixed(2).padStart(9)} ${row.unit}  ${row.detail}${python}`);
  }
  return out.join("\n");
}
