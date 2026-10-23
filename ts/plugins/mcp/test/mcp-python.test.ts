/** Differential: names, schemas, approval subjects and result text against the Python plugin. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { callResultText, extractText, mcpSubject, parseNamespaced, sanitizeNamePart, toolSchema } from "../src/index.ts";
import { pythonUnavailableReason, runPython } from "../../../test-support/python-oracle.ts";

const skip = pythonUnavailableReason() ?? false;
const NAMES: unknown[] = ["read", "Weird Name!", "  spaced  ", "", "   ", ".", "..", "a..b", "über-tool", "x".repeat(80), "a__b", "tab\tname", "dots.and-dashes", "日本語", "_", "__", "a\u00a0b", "\u2003lead", "emoji😀tool", "\ufeffbom", "sep\u001c", "\u0085next", "x".repeat(63) + "😀😀", 7, null];
const PARSE: unknown[] = ["mcp__srv__read", "mcp__a__b__c", "mcp____x", "mcp__.__x", "mcp__srv__", "read", "mcp__srv__..", "mcp__s.v__t-1", "mcp__" + "a".repeat(65) + "__t", 3];
const TOOLS: unknown[] = [{ name: "echo", description: "d", inputSchema: { type: "object", properties: { a: { type: "string" } } } }, { name: "x y" }, { name: "" }, { description: 5, inputSchema: [] }, "not a dict", { name: "q", inputSchema: null }];
const ARGS: unknown[] = [{ b: 1, a: "ü", nested: { z: [1, 2], y: null } }, {}, [], "text", { "": true }];
const CONTENT: unknown[] = [
  [{ type: "text", text: "one" }, { type: "text", text: "two" }],
  [{ type: "resource", resource: { uri: "file:///a", text: "inline" } }, { type: "resource", resource: { uri: "file:///b", mimeType: "image/png", blob: "AAA" } }],
  [{ type: "image", data: "xx", mimeType: "image/png" }, "junk", { type: "text", text: 5 }],
  "plain", null, [],
];
const STRUCTURED: unknown[] = [undefined, null, {}, [], { a: 1, "ü": ["x"] }, [1, { b: 2 }]];

describe("MCP helpers match Python", { skip }, () => {
  it("names, parsing, schemas, subjects and result text", () => {
    const output = runPython(String.raw`
import json, sys
from xueness.bundled_plugins.mcp import mcp
cases = json.load(sys.stdin)
text = []
for content in cases["content"]:
    for structured in cases["structured"]:
        raw = mcp._extract_text(content)
        value = structured.get("v") if isinstance(structured, dict) else None
        if value is not None and isinstance(value, (dict, list)) and len(value) > 0:
            block = "Structured content:\n" + json.dumps(value, ensure_ascii=False, indent=2)
            raw = (raw + "\n\n" + block) if raw else block
        text.append(raw)
print(json.dumps({
  "sanitize": [mcp.sanitize_mcp_name_part(n) for n in cases["names"]],
  "parse": [list(mcp.parse_namespaced(n)) if mcp.parse_namespaced(n) else None for n in cases["parse"]],
  "schema": [mcp.tool_schema("srv", t) for t in cases["tools"]],
  "subject": [__import__("xueness.core", fromlist=["mcp_subject"]).mcp_subject("mcp__srv__t", a) for a in cases["args"]],
  "extract": [mcp._extract_text(c) for c in cases["content"]],
  "text": text,
}, ensure_ascii=False))
`, JSON.stringify({ names: NAMES, parse: PARSE, tools: TOOLS, args: ARGS, content: CONTENT, structured: STRUCTURED.map((v) => v === undefined ? null : { v }) }));
    const python = JSON.parse(output) as Record<string, unknown[]>;
    assert.deepEqual(NAMES.map(sanitizeNamePart), python.sanitize);
    assert.deepEqual(PARSE.map(parseNamespaced), python.parse);
    assert.deepEqual(TOOLS.map((tool) => toolSchema("srv", tool)), python.schema);
    assert.deepEqual(ARGS.map((args) => mcpSubject("mcp__srv__t", args)), python.subject);
    assert.deepEqual(CONTENT.map(extractText), python.extract);
    const text = CONTENT.flatMap((content) => STRUCTURED.map((structured) => callResultText({ content, ...(structured === undefined ? {} : { structuredContent: structured }) }, Number.MAX_SAFE_INTEGER).text));
    assert.deepEqual(text, python.text);
  });
});
