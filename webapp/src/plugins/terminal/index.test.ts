import test from "node:test";
import assert from "node:assert/strict";
import { decodeTerminalData, nextTerminalBackoff, terminalResizePayload } from "./index";

test("nextTerminalBackoff doubles backoff delay up to 1000ms cap", () => {
  assert.equal(nextTerminalBackoff(150), 300);
  assert.equal(nextTerminalBackoff(300), 600);
  assert.equal(nextTerminalBackoff(600), 1000);
  assert.equal(nextTerminalBackoff(1000), 1000);
  assert.equal(nextTerminalBackoff(1500), 1000);
});

test("decodeTerminalData safely decodes valid base64 and returns null without throwing on malformed data", () => {
  // Valid base64: "aGVsbG8=" -> "hello"
  const bytes = decodeTerminalData("aGVsbG8=");
  assert.notEqual(bytes, null);
  assert.equal(String.fromCharCode(...bytes!), "hello");

  // Empty string
  const empty = decodeTerminalData("");
  assert.notEqual(empty, null);
  assert.equal(empty!.length, 0);

  // Malformed base64
  const origError = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    const invalid = decodeTerminalData("not-valid-base64!!!");
    assert.equal(invalid, null);
    assert.equal(decodeTerminalData("YQ"), null, "un-padded base64 is rejected");
    assert.equal(decodeTerminalData("YR=="), null, "non-canonical trailing bits are rejected");
    assert.equal(logged.length, 3);
  } finally {
    console.error = origError;
  }
});

test("terminalResizePayload skips hidden zero-sized terminals", () => {
  assert.deepEqual(terminalResizePayload(80, 24), { cols: 80, rows: 24 });
  assert.equal(terminalResizePayload(0, 24), null);
  assert.equal(terminalResizePayload(80, 0), null);
  assert.equal(terminalResizePayload(-1, 24), null);
  assert.equal(terminalResizePayload(80.5, 24), null);
});
