import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { catalogIssues, dependencyOrder, validateManifest, type PluginManifest } from "../src/index.ts";

const minimal = { apiVersion: 2, id: "demo", name: "Demo", description: "A demo plugin.", version: "1.0.0", defaultEnabled: true };

function issuesOf(document: unknown): string[] {
  return validateManifest(document).issues.map((issue) => `${issue.path} ${issue.message}`);
}

function manifest(extra: Record<string, unknown>): PluginManifest {
  const result = validateManifest({ ...minimal, ...extra });
  assert.deepEqual(result.issues, []);
  return result.manifest as PluginManifest;
}

describe("plugin manifest v2", () => {
  it("normalises a minimal manifest with empty declarations", () => {
    const result = manifest({});
    assert.equal(result.apiVersion, 2);
    assert.deepEqual(result.inject, { required: [], optional: [] });
    assert.deepEqual(result.capabilities, { fs: { read: [], write: [] }, net: { connect: [], listen: [] }, exec: [], secrets: [] });
    assert.deepEqual([result.tools, result.dependencies, result.features, result.config, result.toolEvents, result.installPackage], [[], [], [], null, null, null]);
  });

  it("refuses code, unknown fields and missing basics", () => {
    assert.deepEqual(issuesOf({ ...minimal, entrypoint: "plugin.js", capabilites: [] }), [
      "/entrypoint external plugin code requires a separate audit",
      "/capabilites is not a known field",
    ]);
    assert.deepEqual(issuesOf({ apiVersion: 1, id: "Demo", version: "1.0", defaultEnabled: "yes", name: " " }), [
      "/apiVersion must be 2",
      "/id is not a valid plugin id",
      "/version must be MAJOR.MINOR.PATCH",
      "/defaultEnabled must be a boolean",
      "/name must be a non-empty string",
      "/description is required",
    ]);
    for (const value of [null, 1, "x", [], [minimal]]) assert.deepEqual(issuesOf(value), [" manifest must be a JSON object"]);
  });

  it("checks names, routes, services and paths like the Python contract", () => {
    assert.deepEqual(issuesOf({
      ...minimal,
      dependencies: ["demo", "Files", "git", "git"],
      provides: ["demo.worker", "plugin.demo", "kernel.tools", "Bad Name"],
      inject: { required: ["plugin.files", "kernel.tools"], optional: ["x"], extra: [] },
      httpFamilies: ["demo", "sessions/*/demo", "*/x", "a/B", "sessions/*/file-bytes"],
      dataFiles: ["catalog.json", "../secret", "/etc/passwd"],
      desktopModules: ["src/demo.cjs", "lib/demo.cjs"],
      pluginsActions: ["validate", "Update"],
    }), [
      "/dependencies/0 must not depend on the plugin itself",
      "/dependencies/1 is not a valid plugin id",
      "/dependencies/3 duplicates \"git\"",
      "/provides/1 is reserved for the kernel",
      "/provides/2 is reserved for the kernel",
      "/provides/3 is not a valid service name",
      "/inject/required/0 use dependencies to depend on a plugin",
      "/inject/extra is not a known field",
      "/httpFamilies/2 is not a valid route pattern",
      "/httpFamilies/3 is not a valid route pattern",
      "/dataFiles/1 is not a safe relative path",
      "/dataFiles/2 is not a safe relative path",
      "/desktopModules/1 is not a safe relative path",
      "/pluginsActions/1 is not a valid action name",
    ]);
    assert.deepEqual(manifest({ inject: ["kernel.tools"] }).inject, { required: ["kernel.tools"], optional: [] });
  });

  it("declares tools with their Gate kind and flags, and families without overlaps", () => {
    const result = manifest({ tools: [
      { name: "read", gate: "read", mutating: false, concurrencySafe: true },
      { name: "mcp__*", gate: "mcp", mutating: true },
    ] });
    assert.deepEqual(result.tools[1], { name: "mcp__*", gate: "mcp", mutating: true, concurrencySafe: false });
    assert.deepEqual(issuesOf({ ...minimal, tools: [
      "read",
      { name: "mcp__*", gate: "mcp", mutating: true },
      { name: "mcp__fs", gate: "mcp", mutating: true },
      { name: "write", gate: "Write", mutating: "yes" },
      { name: "grep", gate: "grep", mutating: true, concurrencySafe: true, description: "x" },
    ] }), [
      "/tools/0 must be an object",
      "/tools/2/name overlaps another tool of this plugin",
      "/tools/3/gate is not a valid gate kind",
      "/tools/3/mutating must be a boolean",
      "/tools/4/description is not a known field",
      "/tools/4 a concurrency-safe tool must not be mutating",
    ]);
  });

  it("validates config schemas and requires valid defaults", () => {
    const schema = {
      type: "object", additionalProperties: false,
      properties: { timeoutMs: { type: "integer", minimum: 1000 }, shell: { type: "string" } },
    };
    assert.deepEqual(manifest({ config: { schema, default: { timeoutMs: 5000 } } }).config, { schema, default: { timeoutMs: 5000 } });
    assert.deepEqual(issuesOf({ ...minimal, config: { schema: { ...schema, oneOf: [] }, default: {} } }), ["/config/schema/oneOf is not a supported schema keyword"]);
    assert.deepEqual(issuesOf({ ...minimal, config: { schema: { type: "array" } } }), ["/config/schema/type must be \"object\""]);
    assert.deepEqual(issuesOf({ ...minimal, config: { schema, default: { timeoutMs: 5, other: 1 } } }), [
      "/config/default/timeoutMs must be >= 1000",
      "/config/default/other is not allowed",
    ]);
    assert.deepEqual(issuesOf({ ...minimal, config: { schema: { type: "object", required: ["key"], properties: { key: { type: "string" } } } } }), [
      "/config/default/key is required",
    ]);
    assert.deepEqual(issuesOf({ ...minimal, config: { schema: { type: "object", additionalProperties: 42, properties: { a: { pattern: "(" } } } } }), [
      "/config/schema/additionalProperties must be a schema object",
      "/config/schema/properties/a/pattern must be a valid regular expression",
    ]);
  });

  it("never throws on arbitrary JSON", () => {
    const values: unknown[] = [null, true, 0, -1.5, "", "x", [], {}, [null], { a: null }, { length: 3 }];
    const keys = ["apiVersion", "id", "tools", "config", "capabilities", "inject", "features", "toolEvents", "dependencies", "entrypoint"];
    let seed = 7;
    const pick = <T>(items: readonly T[]): T => items[(seed = (seed * 1103515245 + 12345) % 2 ** 31) % items.length] as T;
    for (let round = 0; round < 2000; round += 1) {
      const document: Record<string, unknown> = { ...minimal };
      for (let count = 0; count < 3; count += 1) document[pick(keys)] = pick(values);
      assert.doesNotThrow(() => validateManifest(document));
    }
  });
});

describe("plugin catalog", () => {
  it("finds shared owners, overlapping tools, unknown dependencies and cycles", () => {
    const a = manifest({ id: "a", provides: ["a.svc"], httpFamilies: ["a"], tools: [{ name: "mcp__*", gate: "mcp", mutating: true }], dependencies: ["c"] });
    const b = manifest({ id: "b", provides: ["a.svc"], httpFamilies: ["a"], tools: [{ name: "mcp__x", gate: "mcp", mutating: true }], dependencies: ["missing"] });
    const c = manifest({ id: "c", dependencies: ["d"] });
    const d = manifest({ id: "d", dependencies: ["c"] });
    assert.deepEqual(catalogIssues([a, b, c, d]).map((issue) => `${issue.plugin}${issue.path} ${issue.message}`), [
      "b/provides/0 is also declared by a",
      "b/httpFamilies/0 is also declared by a",
      "b/tools/0/name overlaps tool mcp__* of a",
      "b/dependencies/0 names an unknown plugin",
      "c/dependencies is part of a dependency cycle",
      "d/dependencies is part of a dependency cycle",
    ]);
    assert.deepEqual(dependencyOrder([a, b, c, d]), { order: ["b"], cyclic: ["c", "d"] });
  });

  it("orders dependencies first and otherwise keeps the given order", () => {
    const nodes = [
      { id: "workflows", dependencies: ["sessions", "files", "shell"] },
      { id: "sessions", dependencies: [] },
      { id: "terminal", dependencies: ["sessions", "shell"] },
      { id: "files", dependencies: [] },
      { id: "shell", dependencies: [] },
    ];
    assert.deepEqual(dependencyOrder(nodes), { order: ["sessions", "files", "shell", "workflows", "terminal"], cyclic: [] });
  });
});
