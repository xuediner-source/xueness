import assert from "node:assert/strict";
import test from "node:test";
import { Parser } from "../src/cli/argparse.ts";
import { assistantResultForTurn, HEADLESS_SCHEMA, headlessRequest, register, resultEnvelope } from "../src/cli/headless.ts";

function parseHeadless(argv: string[]) {
  const root = new Parser("xueness");
  const sub = root.subparsers("cmd");
  register(sub);
  return root.parse(argv);
}

test("headless parser accepts new, resumed-input, and continue forms", () => {
  assert.deepEqual(headlessRequest(parseHeadless(["headless", "-p", "new task", "--root", "E:/work"])), {
    kind: "new", prompt: "new task", root: "E:/work", sessionId: null, attachments: [],
  });
  assert.deepEqual(headlessRequest(parseHeadless(["headless", "--resume", "a".repeat(32), "-p", "next"])), {
    kind: "resume", prompt: "next", root: null, sessionId: "a".repeat(32), attachments: [],
  });
  assert.equal(headlessRequest(parseHeadless(["headless", "--continue", "--root", "E:/work"])).kind, "continue");
});

test("headless parser rejects conflicting or underspecified selection modes", () => {
  assert.throws(() => headlessRequest(parseHeadless(["headless", "--resume", "a".repeat(32), "--continue", "--root", "E:/work"])), /mutually exclusive/);
  assert.throws(() => headlessRequest(parseHeadless(["headless", "--continue"])), /--root is required/);
  assert.throws(() => headlessRequest(parseHeadless(["headless", "-p", "new task"])), /--root is required/);
  assert.throws(() => headlessRequest(parseHeadless(["headless", "--resume", "a".repeat(32), "--attach", "file.txt"])), /--attach requires --prompt/);
});

test("headless result keeps the stable envelope and returns only final assistant content", () => {
  const session = {
    id: "a".repeat(32), status: "completed", steps: 3, mode: "plan", completion: { verified: true },
    messages: [
      { role: "assistant", _turn_id: "turn-2", content: "tool preface", tool_calls: [{ id: "call-1" }] },
      { role: "assistant", _turn_id: "turn-2", content: "final body", reasoning_content: "private thought" },
      { role: "assistant", _turn_id: "turn-3", content: "later turn" },
    ],
    usage: { input_tokens: 12, output_tokens: 4 },
  };
  assert.equal(assistantResultForTurn(session, "turn-2"), "final body");
  assert.equal(assistantResultForTurn({ messages: [
    { role: "assistant", _turn_id: "turn-2", content: "old answer" },
    { role: "assistant", _turn_id: "turn-2", content: "tool preface", tool_calls: [{ id: "call-1" }] },
  ] }, "turn-2"), "");
  assert.equal(assistantResultForTurn({ messages: [] }, "turn-2"), "");
  assert.deepEqual(resultEnvelope(session, "final body"), {
    schema: HEADLESS_SCHEMA, type: "result", sessionId: session.id, status: "completed", result: "final body", steps: 3,
    mode: "plan", completion: { verified: true }, pending: [], pending_question: null, usage: session.usage,
  });
});
