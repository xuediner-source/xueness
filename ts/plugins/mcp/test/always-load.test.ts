import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolResult } from "@xueness/engine-tools";
import { validateRuntimeMcpServers } from "../src/config.ts";
import { serverTools } from "../src/index.ts";

type Row = Record<string, unknown>;
const call = async (): Promise<ToolResult> => ({ ok: true, output: "" });
const remoteTools: Row[] = [
  { name: "alpha", description: "a", inputSchema: { type: "object", properties: {} } },
  { name: "beta", description: "b", inputSchema: { type: "object", properties: {} } },
];
const namesOf = (definitions: { name: string; alwaysLoad?: boolean }[], loaded: boolean): string[] =>
  definitions.filter((definition) => loaded ? definition.alwaysLoad === true : definition.alwaysLoad !== true).map((definition) => definition.name).sort();

describe("mcp alwaysLoad passthrough", () => {
  it("marks every tool of the connection when alwaysLoad is true, and host specials never", () => {
    const definitions = serverTools({ id: "srv", alwaysLoad: true }, remoteTools, { resources: {} }, call);
    assert.deepEqual(namesOf(definitions, true), ["mcp__srv__alpha", "mcp__srv__beta"]);
    const specials = definitions.filter((definition) => definition.name.includes("_xueness_"));
    assert.ok(specials.length && specials.every((definition) => definition.alwaysLoad === undefined));
  });
  it("marks only the named server tools when alwaysLoad lists names", () => {
    const definitions = serverTools({ id: "srv", alwaysLoad: ["beta"] }, remoteTools, {}, call);
    assert.deepEqual(namesOf(definitions, true), ["mcp__srv__beta"]);
    assert.deepEqual(namesOf(definitions, false), ["mcp__srv__alpha"]);
  });
  it("marks nothing without the field or with a malformed value", () => {
    assert.deepEqual(namesOf(serverTools({ id: "srv" }, remoteTools, {}, call), true), []);
    assert.deepEqual(namesOf(serverTools({ id: "srv", alwaysLoad: "yes" }, remoteTools, {}, call), true), []);
  });
  it("validates the connection config field", () => {
    assert.doesNotThrow(() => validateRuntimeMcpServers({ srv: { command: "x", alwaysLoad: true } }));
    assert.doesNotThrow(() => validateRuntimeMcpServers({ srv: { command: "x", alwaysLoad: ["alpha", "beta"] } }));
    assert.doesNotThrow(() => validateRuntimeMcpServers({ srv: { command: "x", alwaysLoad: false } }));
    assert.throws(() => validateRuntimeMcpServers({ srv: { command: "x", alwaysLoad: "yes" } }));
    assert.throws(() => validateRuntimeMcpServers({ srv: { command: "x", alwaysLoad: [1] } }));
  });
});
