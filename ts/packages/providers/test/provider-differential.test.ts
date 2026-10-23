/**
 * Differential tests: the TypeScript adapters and the Python adapters
 * (`provider.py`) talk to the same scripted HTTP server and must send
 * identical requests and settle with identical results, errors, callback
 * observations and retry sleeps.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pythonUnavailableReason, runPythonAsync } from "../../../test-support/python-oracle.ts";
import { ANTHROPIC_CASES, CONSTRUCT_CASES } from "./support/anthropic-cases.ts";
import { MESSAGES, type ProviderCase } from "./support/http-fixtures.ts";
import { OPENAI_BODY_CASES, OPENAI_COMPLETE_CASES, OPENAI_STREAM_CASES } from "./support/openai-cases.ts";
import { runTsCase, type CaseOutcome } from "./support/run-ts-case.ts";
import { ScriptedServer, type RecordedRequest } from "./support/scripted-server.ts";

const CASES: ProviderCase[] = [...OPENAI_STREAM_CASES, ...OPENAI_COMPLETE_CASES, ...OPENAI_BODY_CASES, ...ANTHROPIC_CASES,
  ...CONSTRUCT_CASES].map((c) => ({ ...c, messages: c.messages ?? MESSAGES }));
const ORACLE = join(import.meta.dirname, "..", "..", "..", "test-support", "python", "provider_oracle.py");
/** Request headers both clients must agree on (User-Agent legitimately differs). */
const HEADERS = ["host", "content-type", "content-length", "authorization", "x-api-key", "anthropic-version", "accept-encoding", "connection"];

const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null));

function comparable(c: ProviderCase, outcome: CaseOutcome): unknown {
  const error = outcome.error && c.timing ? { ...outcome.error, exception_type: "(timing)" } : outcome.error;
  return plain({ result: outcome.result, error, calls: outcome.calls, sleeps: c.timing ? outcome.sleeps.length : outcome.sleeps });
}

function requests(recorded: RecordedRequest[]): unknown {
  return recorded.map((request) => ({
    method: request.method, path: request.path, body: request.body,
    headers: Object.fromEntries(HEADERS.filter((name) => name in request.headers).map((name) => [name, request.headers[name]])),
  }));
}

const skip = pythonUnavailableReason();

describe("provider adapters match Python over scripted HTTP", { skip: skip ?? false }, () => {
  let server: ScriptedServer | undefined;
  const python = new Map<string, CaseOutcome>();
  const typescript = new Map<string, CaseOutcome>();

  before(async () => {
    const started = await ScriptedServer.start();
    server = started;
    for (const c of CASES) started.script(c.id, c.responses ?? []);
    const input = JSON.stringify({ port: started.port, cases: CASES.map(({ responses: _responses, ...rest }) => rest) });
    const oracle = runPythonAsync(`import runpy; runpy.run_path(${JSON.stringify(ORACLE)}, run_name="__main__")`, input);
    const ours = (async () => {
      for (const c of CASES) typescript.set(c.id, await runTsCase(c, started.base("ts", c.id)));
    })();
    const [stdout] = await Promise.all([oracle, ours]);
    for (const outcome of JSON.parse(stdout) as CaseOutcome[]) python.set(outcome.id, outcome);
  });

  after(async () => {
    await server?.close();
  });

  for (const c of CASES) {
    it(c.id, () => {
      const expected = python.get(c.id);
      const actual = typescript.get(c.id);
      assert.ok(expected && actual, "both sides ran");
      assert.deepEqual(comparable(c, actual), comparable(c, expected));
      if (server) assert.deepEqual(requests(server.requests("ts", c.id)), requests(server.requests("py", c.id)));
    });
  }
});
