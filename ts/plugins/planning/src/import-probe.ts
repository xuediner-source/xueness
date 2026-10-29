/** Runs in its own Node process, importing through a real .mjs consumer. */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const importProbePath = (): string => fileURLToPath(import.meta.url);
export function probeImports(paths: string[], silent: boolean, timeoutMs: number) {
  const directory = mkdtempSync(join(tmpdir(), "xueness-import-")), caller = join(directory, "consumer.mjs");
  writeFileSync(caller, 'import { writeSync } from "node:fs";\nawait import(process.argv[2]);\nwriteSync(3, "import-completed");\n');
  const deadline = Date.now() + timeoutMs;
  try {
    return paths.map(path => {
      const absolute = resolve(path), sha256 = createHash("sha256").update(readFileSync(absolute)).digest("hex");
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { path, sha256, passed: false, reason: "Import verification budget exhausted" };
      const child = spawnSync(process.execPath, [caller, pathToFileURL(absolute).href], {
        cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: Math.min(5000, remaining), maxBuffer: 8192,
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      });
      const stdout = String(child.stdout ?? ""), stderr = String(child.stderr ?? "");
      const completed = String(child.output?.[3] ?? "") === "import-completed";
      const passed = child.status === 0 && completed && (!silent || !stdout && !stderr);
      return { path, sha256, passed, exitCode: child.status, completed, silent,
        ...passed ? {} : { reason: child.error?.message ?? (!completed ? "Import did not return to its consumer" : "Import produced output"), stdout: stdout.slice(0, 400), stderr: stderr.slice(0, 600) } };
    });
  } finally { unlinkSync(caller); rmdirSync(directory); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [silent, timeout, ...paths] = process.argv.slice(2);
    const items = probeImports(paths, silent === "silent", Number(timeout));
    process.stdout.write(JSON.stringify({ status: items.every(item => item.passed) ? "passed" : "failed", items }));
    process.exitCode = items.every(item => item.passed) ? 0 : 1;
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
