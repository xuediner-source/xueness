import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bodyLimitFor, errorPayload, normalizeError } from "../src/index.ts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";

const CASES: Array<[number, unknown]> = [
  [404, { error: "not found" }],
  [403, { error: "plugin disabled", plugin: "office", code: "plugin_disabled" }],
  [400, { error: "", errorCode: "bad_thing" }],
  [409, { error: "busy", error_code: "busy_session", status: 200 }],
  [418, { error: "teapot" }],
  [500, "not an object"],
  [503, null],
  [413, { code: "", error_code: "", errorCode: "x", extra: [1, 2] }],
];

describe("http error envelope", () => {
  it("fills code and status and never lets extras replace the envelope", () => {
    assert.deepEqual(errorPayload(404, "missing"), { error: "missing", code: "not_found", status: 404 });
    assert.deepEqual(errorPayload(418, ""), { error: "request failed", code: "error", status: 418 });
    assert.deepEqual(errorPayload(400, "x", "c", { status: 200, hint: 1 }), { error: "x", code: "c", status: 400, hint: 1 });
  });

  it("uses the composer body limit only for /api/composer/prepare", () => {
    assert.equal(bodyLimitFor("/api/composer/prepare"), 6_000_000);
    assert.equal(bodyLimitFor("/api/sessions"), 1_000_000);
  });

  it("matches Python normalize_error", { skip: pythonUnavailableReason() ?? false }, () => {
    const output = runPython(`
import json, sys
from xueness.http_contract import normalize_error
print(json.dumps([normalize_error(status, payload) for status, payload in json.loads(sys.stdin.read())]))
`, JSON.stringify(CASES));
    const expected = JSON.parse(output);
    const actual = CASES.map(([status, payload]) => normalizeError(status, payload));
    assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  });
});
