/** Elicitation schema and the session HTTP surface against Python. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pyJsonDumps } from "@xueness/contracts";
import { normalizeSchema, validateContent } from "../src/elicitation-schema.ts";
import { createElicitationHttp } from "../src/elicitation-http.ts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";

const skip = pythonUnavailableReason() ?? false;
const flat = { type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 8 } }, required: ["name"], additionalProperties: false };

describe("elicitation schema matches Python", { skip }, () => {
  it("normalizes and validates the same codes", () => {
    const cases = [
      { op: "schema", schema: flat },
      { op: "schema", schema: { ...flat, extra: true } },
      { op: "schema", schema: { ...flat, additionalProperties: true } },
      { op: "schema", schema: { type: "object", properties: { password: { type: "string" } }, required: [] } },
      { op: "schema", schema: { type: "object", properties: { nest: { type: "object" } }, required: [] } },
      { op: "schema", schema: { type: "object", properties: { name: { type: "string", maxLength: 9000 } }, required: [] } },
      { op: "validate", schema: flat, content: {} },
      { op: "validate", schema: flat, content: { name: "ok", extra: 1 } },
      { op: "validate", schema: flat, content: { name: "ok" } },
      { op: "validate", schema: { type: "object", properties: { when: { type: "string", format: "date" } }, required: ["when"] }, content: { when: "2020-01-02" } },
    ];
    const python = runPython(`import json,sys\nfrom xueness.bundled_plugins.mcp.elicitation import _normalize_schema, validate_content\nout=[]\nfor case in json.loads(sys.stdin.read()):\n    if case["op"]=="schema":\n        out.append(list(_normalize_schema(case["schema"])))\n    else:\n        out.append(list(validate_content(case["schema"], case["content"])))\nprint(json.dumps(out))`, JSON.stringify(cases)).trim();
    const ours = cases.map((item) => item.op === "schema" ? normalizeSchema(item.schema) : validateContent(item.schema, item.content));
    assert.equal(pyJsonDumps(ours), python);
  });
});

describe("elicitation HTTP", () => {
  const api = createElicitationHttp({ stateDir: null, enabled: () => true });
  const sid = "ab".repeat(16);
  it("owns only the session elicitation path", async () => {
    assert.equal(api.owns("GET", ["api", "mcp", "check"]), false);
    assert.equal(api.owns("GET", ["api", "sessions", sid, "tasks"]), false);
    assert.equal(api.owns("GET", ["api", "sessions", sid, "elicitation"]), true);
    assert.deepEqual(await api.dispatch("GET", ["api", "sessions", "nope", "elicitation"], {}, null), [404, { error: "session not found" }]);
    assert.deepEqual(await api.dispatch("POST", ["api", "sessions", sid, "elicitation"], {}, []), [400, { error: "invalid elicitation response" }]);
    assert.deepEqual(await api.dispatch("PUT", ["api", "sessions", sid, "elicitation"], {}, {}), [405, { error: "method not allowed" }]);
    assert.deepEqual(await api.dispatch("GET", ["api", "sessions", sid, "elicitation"], {}, null), [200, { pending: null }]);
    assert.deepEqual(await api.dispatch("GET", ["api", "sessions", sid, "elicitation"], { wait: ["nope"] }, null), [400, { error: "invalid elicitation wait" }]);
    const off = createElicitationHttp({ stateDir: null, enabled: (id) => id !== "mcp" });
    assert.deepEqual(await off.dispatch("GET", ["api", "sessions", sid, "elicitation"], { wait: ["1"] }, null), [403, { error: "plugin disabled or dependency unavailable: mcp", plugin: "mcp" }]);
  });
});
