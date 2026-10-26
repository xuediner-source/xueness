import assert from "node:assert/strict";
import { it } from "node:test";
import type { HttpResponse } from "../src/http.ts";
import { readOpenAiStream } from "../src/streams.ts";
import { NativeCallAssembler } from "../src/tool-protocol.ts";

function response(events: unknown[]): HttpResponse {
  const raw = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  const lines = raw.match(/[^\n]*\n/g)!.map(line => Buffer.from(line));
  return { readline: async () => lines.shift() ?? Buffer.alloc(0), close() {} } as unknown as HttpResponse;
}
const event = (tool_calls: unknown[], finish_reason: string | null = null) => ({ choices: [{ index: 0, delta: { tool_calls }, finish_reason }] });

it("keeps bound identities when a compatible gateway ends the final tool delta with an empty id", async () => {
  // Sanitized shape captured from the real WorkBuddy MiniMax-M3.1-flash stream.
  const parsed = await readOpenAiStream(response([
    event([{ index: 0, id: "first", type: "function", function: { name: "read", arguments: "" } }]),
    event([{ index: 0, function: { name: "", arguments: '{"path":"a.txt"}' } }]),
    event([{ index: 1, id: "second", type: "function", function: { name: "read", arguments: "" } }]),
    event([{ index: 1, function: { name: "", arguments: '{"path":"b.txt"}' } }]),
    event([{ index: 1, id: "", function: { name: "", arguments: "" } }], "tool_calls"),
  ]), { markDelivered() {} });
  assert.deepEqual(parsed.calls, [
    { id: "first", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } },
    { id: "second", type: "function", function: { name: "read", arguments: '{"path":"b.txt"}' } },
  ]);
});

it("accepts empty continuation identity hints without losing argument fragments", () => {
  const calls = new NativeCallAssembler();
  calls.add([{ index: 0, id: "bound", function: { name: "read", arguments: '{"path":' } }]);
  calls.add([{ index: 0, id: "", function: { arguments: '"a.txt"}' } }]);
  calls.close();
  assert.deepEqual(calls.finish(true)[0], { id: "bound", type: "function", function: { name: "read", arguments: '{"path":"a.txt"}' } });
});

it("still rejects unbound empty ids, identity replacement and cross-index duplicates", () => {
  assert.throws(() => new NativeCallAssembler().add([{ index: 0, id: "", function: { name: "read", arguments: "{}" } }]), /conflicting tool call identity/);
  const calls = new NativeCallAssembler();
  calls.add([{ index: 0, id: "bound", function: { name: "read", arguments: "{}" } }]);
  assert.throws(() => calls.add([{ index: 0, id: "replacement", function: {} }]), /conflicting tool call identity/);
  assert.throws(() => calls.add([{ index: 1, id: "bound", function: {} }]), /conflicting tool call identity/);
  assert.throws(() => calls.add([{ index: 2, id: "", function: {} }]), /conflicting tool call identity/);
});
