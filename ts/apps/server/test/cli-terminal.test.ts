import assert from "node:assert/strict";
import { it } from "node:test";
import { buildParser } from "../src/cli/main.ts";

it("chat defaults to inline approval and explicit non-interactive still disables it", () => {
  const parser = buildParser();
  assert.equal(parser.parse(["chat"]).interactive, true);
  assert.equal(parser.parse(["chat", "--tui"]).interactive, true);
  assert.equal(parser.parse(["chat", "--non-interactive"]).interactive, false);
  assert.equal(parser.parse(["chat", "--tui", "--non-interactive"]).interactive, false);
  assert.equal(parser.parse(["run", "id"]).interactive, false);
});
