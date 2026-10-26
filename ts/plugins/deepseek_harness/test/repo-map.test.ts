/** H02.03 / H02.04: symbol graph + compact repo-map. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRepoMap, summarizeFile } from "../src/builtins/repo-map.ts";
import { buildSymbolGraph, detectLanguage, findSymbol } from "../src/builtins/symbol-graph.ts";

const tsSource = `
export function alpha(x: number): number { return beta(x) + 1; }
export class Beta { run() { return alpha(1); } }
export const gamma = () => alpha(2);
function beta(x: number) { return x; }
`;

const pySource = `
class Worker:
    def run(self):
        return helper(1)

def helper(x):
    return x + 1

async def fetch():
    return helper(2)
`;

describe("symbol-graph", () => {
  it("detects languages from extensions", () => {
    assert.equal(detectLanguage("a.ts"), "typescript");
    assert.equal(detectLanguage("a.py"), "python");
    assert.equal(detectLanguage("a.md"), "unknown");
  });

  it("extracts TS functions/classes/consts deterministically", () => {
    const graph = buildSymbolGraph("src/demo.ts", tsSource);
    assert.deepEqual(graph.nodes.map((n) => n.name), ["alpha", "Beta", "gamma", "beta"]);
    assert.ok(findSymbol(graph, "alpha"));
    assert.ok(graph.edges.some((e) => e.from.endsWith("#alpha") && e.to.endsWith("#beta")));
  });

  it("extracts Python defs/classes", () => {
    const graph = buildSymbolGraph("demo.py", pySource);
    assert.ok(findSymbol(graph, "Worker"));
    assert.ok(findSymbol(graph, "helper"));
    assert.ok(findSymbol(graph, "fetch"));
  });
});

describe("repo-map", () => {
  it("builds a compact ranked map within a budget", () => {
    const map = buildRepoMap([
      { path: "src/demo.ts", source: tsSource, weight: 2 },
      { path: "demo.py", source: pySource, weight: 1 },
    ], { budget: 6000 });
    assert.equal(map.files.length, 2);
    assert.equal(map.files[0]?.path, "src/demo.ts");
    assert.ok(map.text.includes("src/demo.ts"));
    assert.ok(map.text.includes("function:alpha"));
    assert.ok(map.totalSymbols >= 4);
    assert.deepEqual(buildRepoMap([{ path: "src/demo.ts", source: tsSource }]), buildRepoMap([{ path: "src/demo.ts", source: tsSource }]));
  });

  it("truncates when the budget is tight but keeps at least one file", () => {
    const map = buildRepoMap([
      { path: "a.ts", source: tsSource, weight: 5 },
      { path: "b.py", source: pySource, weight: 1 },
      { path: "c.py", source: pySource, weight: 1 },
    ], { budget: 90 });
    assert.ok(map.files.length >= 1);
    assert.equal(map.files[0]?.path, "a.ts");
    assert.equal(map.truncated, true);
    assert.ok(map.files.length < 3);
  });

  it("summarizeFile mirrors a single-file map", () => {
    const summary = summarizeFile("src/demo.ts", tsSource);
    assert.equal(summary.path, "src/demo.ts");
    assert.ok(summary.symbols.some((s) => s.startsWith("function:alpha")));
  });
});
