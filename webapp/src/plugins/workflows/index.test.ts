import test from "node:test";
import assert from "node:assert/strict";
import { parseArgv, parsePlan } from "./index";

test("parsePlan accepts valid JSON and rejects malformed text with a readable message", () => {
  assert.deepEqual(parsePlan('{"name":"check","nodes":[]}'), { name: "check", nodes: [] });
  assert.throws(() => parsePlan('{"name": '), /JSON/);
});

test("parseArgv requires a JSON array of strings", () => {
  assert.deepEqual(parseArgv('["python3","-c","print(1)"]'), ["python3", "-c", "print(1)"]);
  // Malformed JSON and a valid-JSON value of the wrong shape are both rejected.
  assert.throws(() => parseArgv('python3 -c'), /JSON/);
  assert.throws(() => parseArgv('{"argv":["x"]}'), /字符串数组/);
  assert.throws(() => parseArgv('[1,2]'), /字符串数组/);
});
