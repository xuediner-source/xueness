import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { normalizeCapabilities, type CapabilityDeclaration } from "@xueness/contracts";
import { checkPlugins, scanSource } from "../plugin-gate.ts";

function scan(code: string, declared: CapabilityDeclaration = {}): string[] {
  const manifest = { capabilities: normalizeCapabilities(declared) };
  const inside = (specifier: string): boolean => !specifier.startsWith("../../");
  return scanSource("plugin.ts", code, manifest, inside).findings.map((finding) => `${finding.line}: ${finding.message}`);
}

describe("plugin gate", () => {
  it("requires a declared capability for builtins and engine exports that reach outside", () => {
    assert.deepEqual(scan('import { spawn } from "node:child_process";'), ["1: node:child_process needs a declared exec capability"]);
    assert.deepEqual(scan('import { spawn } from "node:child_process";', { exec: ["git"] }), []);
    assert.deepEqual(scan('import type { ChildProcess } from "node:child_process";\nimport { type Server } from "node:net";'), []);
    assert.deepEqual(scan('import { readFile } from "node:fs/promises";\nimport http from "http";'), [
      "1: node:fs/promises needs a declared fs capability", "2: http needs a declared net capability",
    ]);
    assert.deepEqual(scan('import { runProcess, readTool, type ToolDefinition } from "@xueness/engine-tools";', { fs: { read: ["workspace"] } }), [
      "1: runProcess from @xueness/engine-tools needs a declared exec capability",
    ]);
    assert.deepEqual(scan('import * as engine from "@xueness/engine-tools";'), ["1: import named exports from @xueness/engine-tools"]);
  });

  it("treats global network APIs as net, but not the context's mediated ones", () => {
    assert.deepEqual(scan('await fetch("https://example.com");\nnew WebSocket("wss://x");\nglobalThis.fetch("x");'), [
      "1: global fetch needs a declared net capability", "2: global WebSocket needs a declared net capability", "3: global fetch needs a declared net capability",
    ]);
    assert.deepEqual(scan('await ctx.fetch("http://127.0.0.1/");\ninterface Client { fetch(url: string): void }'), []);
  });

  it("refuses code loading, foreign packages and paths outside the plugin", () => {
    assert.deepEqual(scan('eval("1");\nnew Function("return 1");\nrequire("fs");\nawait import(name);\nimport vm from "node:vm";\nprocess.binding("fs");'), [
      "1: eval() is not allowed in plugins", "2: Function() is not allowed in plugins", "3: require() is not allowed in plugins",
      "4: import() of a computed specifier is not allowed in plugins", "5: node:vm loads or inspects code and is not allowed in plugins",
      "6: process.binding is not allowed in plugins",
    ]);
    assert.deepEqual(scan('import pad from "left-pad";\nimport { files } from "@xueness/plugin-files";\nexport * from "../../server/src/index.ts";'), [
      "1: left-pad is not allowed: plugins import node builtins, capability-checked infrastructure packages and their own files",
      "2: @xueness/plugin-files is not allowed: plugins import node builtins, capability-checked infrastructure packages and their own files",
      "3: ../../server/src/index.ts reaches outside the plugin directory",
    ]);
    assert.deepEqual(scan('import manifest from "../manifest.json" with { type: "json" };\nimport { definePlugin } from "@xueness/kernel";'), []);
  });

  it("passes for the bundled plugins", () => {
    const result = checkPlugins(join(import.meta.dirname, "..", ".."));
    assert.deepEqual(result.problems, []);
    assert.equal(result.plugins, 35);
  });
  it("keeps shared persistence and provider adapters behind declared capabilities", () => {
    assert.deepEqual(scan('import { SessionStore } from "@xueness/sessions";'), ["1: @xueness/sessions needs a declared fs capability"]);
    assert.deepEqual(scan('import { OpenAICompatible } from "@xueness/providers";'), ["1: @xueness/providers needs a declared net capability"]);
    assert.deepEqual(scan('import { SessionStore } from "@xueness/sessions";', { fs: { read: ["state"], write: ["state"] } }), []);
    assert.deepEqual(scan('import { OpenAICompatible } from "@xueness/providers";', { net: { connect: ["*"] } }), []);
  });
});
