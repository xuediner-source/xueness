/**
 * Xueness-bench, tools: `npm run bench:tools -- [--files N] [--deps N] [--iterations N] [--no-python] [--json FILE]`.
 * Prints the checks and timings; exits 1 when a check fails.
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { formatReport, runToolBench } from "./bench/tools-bench.ts";

const { values } = parseArgs({
  options: {
    files: { type: "string" }, deps: { type: "string" }, iterations: { type: "string" },
    "no-python": { type: "boolean" }, json: { type: "string" },
  },
});
const number = (text: string | undefined, fallback: number): number => {
  const value = text === undefined ? fallback : Number(text);
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`expected a positive integer, got ${text}`);
  return value;
};
const report = await runToolBench({
  files: number(values.files, 2000), deps: number(values.deps, 4000), iterations: number(values.iterations, 5), python: !values["no-python"],
});
process.stdout.write(`${formatReport(report)}\n`);
if (values.json) writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.checks.every((row) => row.pass) ? 0 : 1;
