/**
 * Differential tests for the pure provider helpers: every corpus value runs
 * through the Python helper and its TypeScript port, which must return the
 * same value or raise the same exception type with the same message.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pyJsonDumps, pyJsonLoads } from "@xueness/contracts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";
import {
  b64decodeStrict, effectiveOptions, envelopeText, isLoopbackLiteral, normalizeNative, pyUrlSplit, resolveRuntimeOptions,
  retryAfterSeconds, strictJson, validateCompatibility, validateOptions, withReportedUsage,
} from "../src/index.ts";
import { CORPUS } from "./support/helper-corpus.ts";

type Outcome = { ok: unknown } | { err: [string, string] };
type Item = never;

const ORACLE = join(import.meta.dirname, "..", "..", "..", "test-support", "python", "provider_units_oracle.py");
const skip = pythonUnavailableReason();
const base64Dialect = !skip && runPython("import sys; print(int(sys.version_info >= (3, 13)))").trim() === "0" ? "3.11" : "3.13";

const PORTS: Record<keyof typeof CORPUS, (value: Item) => unknown> = {
  b64: (value) => b64decodeStrict(value, base64Dialect).toString("hex"),
  retry: (value) => retryAfterSeconds(value),
  urls: (value) => {
    const url = pyUrlSplit(value);
    return { scheme: url.scheme, username: url.username, password: url.password, query: url.query, fragment: url.fragment,
      hostname: url.hostname };
  },
  loopback: (value) => isLoopbackLiteral(value),
  lw_options: ([value, protocol]: [unknown, string]) => validateOptions(value, protocol),
  effective: (item: { value: unknown; context?: number; output?: number }) =>
    effectiveOptions({ value: item.value, context: item.context ?? null, output: item.output ?? null }),
  compat: (value) => validateCompatibility(value),
  runtime: ([record, protocol]: [unknown, string]) => resolveRuntimeOptions(record, protocol),
  native: ([response, used]: [unknown, string[]]) => normalizeNative(response, used),
  envelope: (value) => envelopeText(value),
  strict_json: (value) => strictJson(value),
  usage: ([message, payload]: [unknown, Record<string, unknown>]) => withReportedUsage(message, payload),
};

function evaluate(port: (value: Item) => unknown, value: Item): Outcome {
  try {
    // Python-style JSON keeps non-finite floats (strict_json("1e400") is inf).
    return { ok: pyJsonLoads(pyJsonDumps(port(value) ?? null)) };
  } catch (error) {
    return { err: [error instanceof Error ? error.name : typeof error, error instanceof Error ? error.message : String(error)] };
  }
}

describe("provider helpers match Python", { skip: skip ?? false }, () => {
  const python = skip ? {} : pyJsonLoads(runPython(`import runpy; runpy.run_path(${JSON.stringify(ORACLE)}, run_name="__main__")`,
    JSON.stringify(CORPUS))) as Record<string, Outcome[]>;
  for (const [family, values] of Object.entries(CORPUS)) {
    it(`${family} (${values.length} inputs)`, () => {
      const port = PORTS[family as keyof typeof CORPUS];
      const expected = python[family] ?? [];
      values.forEach((value, index) => {
        const actual = evaluate(port, value as Item);
        const wanted = expected[index] as Outcome;
        assert.deepEqual(actual, wanted, `${family}[${index}] ${JSON.stringify(value)}`);
      });
    });
  }
});

it("documents base64 acceptance differences between CPython 3.11 and 3.13", () => {
  assert.equal(b64decodeStrict("QUJD=", "3.11").toString("ascii"), "ABC");
  assert.throws(() => b64decodeStrict("QUJD=", "3.13"), { name: "Error", message: "Excess padding not allowed" });
  for (const dialect of ["3.11", "3.13"] as const) {
    assert.equal(b64decodeStrict("QUJDRA==", dialect).toString("ascii"), "ABCD");
    assert.throws(() => b64decodeStrict("QUJDRA==x", dialect), { name: "Error", message: "Excess data after padding" });
  }
});
