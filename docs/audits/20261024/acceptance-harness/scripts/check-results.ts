/**
 * F00.04 acceptance harness · structural validator for result batch files.
 *
 * Validates results/*.json against acceptance-result.schema.json's required
 * fields, vocabularies and cross-references (contractId → public-capability-
 * contracts.json, sampleId → samples.json). NOT a full JSON Schema engine:
 * it enforces the harness rules that keep records回填-able and honest —
 * in particular the "no success-rate" rule and live-model cost authorization.
 *
 * Usage: node docs/audits/20261024/acceptance-harness/scripts/check-results.ts \
 *          docs/audits/20261024/acceptance-harness/results/<file>.json [...]
 * Exit 0 = all files valid.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const harnessRoot = join(here, "..");
const contracts = JSON.parse(readFileSync(join(harnessRoot, "..", "public-capability-contracts.json"), "utf8")) as { contracts: Array<{ id: string }> };
const samples = JSON.parse(readFileSync(join(harnessRoot, "samples.json"), "utf8")) as { samples: Array<{ sampleId: string }> };
const contractIds = new Set(contracts.contracts.map((row) => row.id));
const sampleIds = new Set(samples.samples.map((row) => row.sampleId));
const forbidden = new Set(["successrate", "passrate", "failurerate", "coverage", "coveragepercent", "completionpercent", "completionrate", "score"]);
const rateLike = /(rate|percent)/i;

const problems: string[] = [];
const problem = (file: string, at: string, message: string): void => { problems.push(`${file} ${at}: ${message}`); };

for (const path of process.argv.slice(2)) {
  let batch: Record<string, unknown>;
  try { batch = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { problem(path, "file", `not valid JSON: ${String(error)}`); continue; }
  if (batch.schema !== "xueness.acceptance-results.v1") problem(path, "root", "schema must be xueness.acceptance-results.v1");
  for (const key of Object.keys(batch)) if (forbidden.has(key.toLowerCase()) || rateLike.test(key)) problem(path, "root", `forbidden aggregate key '${key}' (样本数/百分比不是成功率)`);
  for (const field of ["round", "recordedAt", "records"]) if (!(field in batch)) problem(path, "root", `missing required field '${field}'`);
  const records = Array.isArray(batch.records) ? batch.records as Array<Record<string, unknown>> : [];
  if (records.length === 0) problem(path, "records", "must contain at least one record");
  records.forEach((record, index) => {
    const at = `records[${index}]`;
    for (const field of ["sampleId", "contractId", "mode", "verdict", "evidence", "recordedAt"]) if (!(field in record)) problem(path, at, `missing required field '${field}'`);
    for (const key of Object.keys(record)) if (forbidden.has(key.toLowerCase()) || rateLike.test(key)) problem(path, at, `forbidden aggregate key '${key}' (样本数/百分比不是成功率)`);
    if (typeof record.sampleId === "string" && !sampleIds.has(record.sampleId)) problem(path, at, `unknown sampleId '${record.sampleId}' (not in samples.json)`);
    if (typeof record.contractId === "string" && !contractIds.has(record.contractId)) problem(path, at, `unknown contractId '${record.contractId}' (not in public-capability-contracts.json)`);
    if (record.mode !== undefined && record.mode !== "offline" && record.mode !== "live_model") problem(path, at, `mode must be offline|live_model, got '${String(record.mode)}'`);
    if (record.verdict !== undefined && !["pass", "fail", "blocked", "not_run"].includes(record.verdict as string)) problem(path, at, `verdict must be pass|fail|blocked|not_run, got '${String(record.verdict)}'`);
    const evidence = record.evidence as Record<string, unknown> | undefined;
    if (evidence !== undefined && (typeof evidence !== "object" || !("command" in evidence))) problem(path, at, "evidence must be an object with at least 'command'");
    if ((record.verdict === "blocked" || record.verdict === "not_run") && typeof record.blocker !== "string") problem(path, at, "verdict blocked/not_run requires a 'blocker' string");
    const costAuth = record.costAuth as { authorized?: unknown } | undefined;
    if (record.mode === "live_model" && (record.verdict === "pass" || record.verdict === "fail") && costAuth?.authorized !== true)
      problem(path, at, "live_model pass/fail requires costAuth.authorized=true (真实模型验证必须记录费用授权)");
    if (record.mode === "offline" && costAuth !== undefined) problem(path, at, "offline records must not carry costAuth");
  });
}

if (problems.length > 0) {
  console.error(problems.map((line) => `INVALID ${line}`).join("\n"));
  process.exit(1);
}
console.log(`[HARNESS] check-results: all ${process.argv.slice(2).length} file(s) structurally valid (计数不构成成功率；validity ≠ 契约通过).`);
