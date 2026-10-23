/**
 * Differential checks against the Python browser plugin: snapshot formatting
 * (fixed and generated trees), the navigate/selector/text checks `_call`
 * makes, screenshot and snapshot shaping, the approval subject and the tool facts.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pythonPredatesSecurityBackports, pythonUnavailableReason } from "../../../test-support/python-oracle.ts";
import { ACTIONS, b64Valid, browserSubject, checkArguments, formatSnapshot, schemaOf, shapeResult, toolDescription, type BrowserAction } from "../src/index.ts";
import { pythonBrowser, type OracleCase } from "./oracle.ts";

type Row = Record<string, unknown>;
const skip = pythonUnavailableReason() ?? false;

/** A small deterministic PRNG so generated trees are reproducible. */
function random(seed: number): () => number { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 2 ** 32; }; }
const NAMES = ["", " ", "OK", "Say \"hi\"\n[ref=e9]", "a\u3000b\u2028c\x1cd\ufeffe", "x".repeat(130), "名字 \t 名", "😀".repeat(70), "\u0085lead", "tab\tbed"];
const ROLES = ["button", "link", "text", "generic", "heading", "", "bad role", "9x", "a".repeat(64), "a".repeat(65), "check-box_2"];
const REFS = ["e1", "f2e3", "e1 >> x", "E1", "e", "e\u0661", "fe1", 7];
let budget = 0;
function tree(next: () => number, depth: number): unknown {
  budget -= 1;
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  const r = next();
  if (r < 0.08) return pick(["", "  ", "plain text", "\u00a0"]);
  if (r < 0.1) return pick([null, 3, ["nested"]]);
  const node: Row = { role: pick(ROLES), name: pick(NAMES) };
  if (next() < 0.4) node.ref = pick(REFS);
  if (next() < 0.1) node.disabled = pick([true, false, "true"]);
  if (next() < 0.1) node.checked = pick([true, "mixed", false, "true"]);
  if (next() < 0.1) node.level = pick([0, 1, 9, 10, true, 2.5]);
  if (next() < 0.1) node.text = pick(NAMES);
  if (budget > 0 && depth < 30 && next() < (depth < 4 ? 0.7 : 0.35)) node.children = Array.from({ length: Math.floor(next() * 6) }, () => tree(next, depth + 1));
  return node;
}
function chain(length: number): Row { const root: Row = { role: "generic", name: "d0" }; let cursor = root; for (let i = 1; i < length; i += 1) { const child = { role: "generic", name: `d${i}` }; cursor.children = [child]; cursor = child; } return root; }

describe("browser plugin against Python", { skip }, () => {
  it("formats snapshots identically", () => {
    const cases: OracleCase[] = [
      { op: "format", nodes: [{ role: "navigation", name: "Main", children: [{ role: "link", name: "Home", ref: "e1" }] }, "  ", { role: "text", text: "fallback" }] },
      { op: "format", nodes: Array.from({ length: 250 }, (_, i) => ({ role: "button", name: `n${String(i + 1).padStart(3, "0")}`, ref: `e${i + 1}` })) },
      { op: "format", nodes: Array.from({ length: 120 }, (_, i) => ({ role: "button", name: "n".repeat(120), ref: `e${i + 1}` })) },
      { op: "format", nodes: [chain(31)] },
      { op: "format", nodes: [{ children: [chain(40)] }] },
      { op: "format", nodes: Array.from({ length: 5200 }, (_, i) => ({ role: "button", name: String(i) })) },
      { op: "format", nodes: [{ role: "button", name: "Only", ref: "e1" }], total: 50, truncated: true },
      { op: "format", nodes: [{ role: "button", name: "Only" }], total: 6000 },
      { op: "format", nodes: [{ role: "button", name: "Only" }], total: true },
      { op: "format", nodes: [] },
      { op: "format", nodes: { role: "button" } },
      { op: "format", nodes: "text" },
    ];
    const next = random(20261019);
    for (let i = 0; i < 160; i += 1) budget = i % 10 === 0 ? 400 : 60, cases.push({ op: "format", nodes: Array.from({ length: 1 + Math.floor(next() * 8) }, () => tree(next, 0)), ...(next() < 0.2 ? { total: Math.floor(next() * 400), truncated: next() < 0.5 } : {}) });
    const expected = pythonBrowser(cases);
    cases.forEach((item, index) => {
      const want = expected[index]!, format = item as Extract<OracleCase, { op: "format" }>;
      let got: unknown;
      try { got = { value: formatSnapshot(format.nodes, { reportedTotal: format.total, reportedTruncated: format.truncated === true }) }; } catch { got = { error: "ValueError", message: "invalid snapshot" }; }
      assert.deepEqual(got, want, `case ${index}`);
    });
  });

  it("checks navigate, selector and text arguments like _call", () => {
    const urls = ["https://example.com", "HTTPS://Example.COM/a", "http://example.com", "https://", "https:///path", "https://user@example.com", "https://:pw@example.com", "https://@example.com", "https://:@example.com",
      " \x01https://example.com", "ht\ttps://example.com", "https://exa\nmple.com", "https://[::1]/", "https://[::1", "https://::1]/", "https://[1.2.3.4]/", "https://[v1.x]/", "https://[v1.]/", "https://[vz.x]/", "https://a[::1]/",
      "https://[::1]x/", "https://[::1]:443/", "https://[fe80::1%eth0]/", "https://[::ffff:1.2.3.4]/", "https://[1:2:3:4:5:6:7:8]/", "https://[1:2:3:4:5:6:7:8:9]/", "https://[1::2::3]/", "https://[:1]/", "https://[01.2.3.4]/",
      "https://example.com:99999/", "https://example.com:abc/", "https://ex\uff03ample.com/", "https://ex\u2100ample.com/", "https://名字.example/", "https:example.com", "//example.com", "1https://example.com", "https://example.com#frag",
      "https://" + "a".repeat(4090), "https://" + "a".repeat(4089), "https://" + "😀".repeat(2000), "https://ex@mple@host/", "https://example.com/@user", "https://?x", "https://#x", "https://%41/", "file:///etc/passwd", "javascript:alert(1)", "", 5, null];
    const cases: OracleCase[] = urls.map((url) => ({ op: "call", action: "navigate", args: { url } as Row }));
    const selectors = ["", "a", "x".repeat(1000), "x".repeat(1001), "😀".repeat(1000), 4];
    for (const selector of selectors) cases.push({ op: "call", action: "click", args: { selector } as Row }, { op: "call", action: "fill", args: { selector, text: "t" } as Row });
    for (const text of ["", "x".repeat(5000), "x".repeat(5001), "😀".repeat(5000), 3]) cases.push({ op: "call", action: "fill", args: { selector: "#q", text } as Row });
    const expected = pythonBrowser(cases);
    cases.forEach((item, index) => {
      const call = item as Extract<OracleCase, { op: "call" }>, want = expected[index]!;
      if (pythonPredatesSecurityBackports() && /^https:\/\/(a\[::1\]|\[::1\]x)\/$/.test(String(call.args.url))) return; // pre-3.11.17 urlsplit bracket check
      let refused: string | null = null;
      try { checkArguments(call.action as BrowserAction, call.args); } catch (error) { refused = (error as Error).message; }
      assert.equal(refused === null, want.error === undefined, `case ${index} ${JSON.stringify(call.args).slice(0, 80)}: python ${want.error ?? "ok"} ${want.message ?? ""}`);
      if (refused !== null && want.message && /required$/.test(want.message)) assert.equal(refused, want.message, `case ${index}`);
      if (want.calls) { const command: Row = { action: call.action, ...call.args }; assert.deepEqual(want.calls, [command]); assert.deepEqual(want.subjects, [["exec", browserSubject(command)]]); }
    });
  });

  it("shapes screenshots and snapshots like _call", () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest")]).toString("base64");
    const payloads: [string, Row][] = [
      ["screenshot", { ok: true, url: "https://e.example/", imageDataUrl: "data:image/png;base64," + png, mimeType: "image/png", untrusted: true }],
      ["screenshot", { ok: true, imageDataUrl: "data:image/png;base64," + png.replace(/=+$/, "") + "=" }],
      ["screenshot", { ok: true, imageDataUrl: "data:image/png;base64," + Buffer.from("GIF89a").toString("base64") }],
      ["screenshot", { ok: true, imageDataUrl: "data:image/jpeg;base64," + png }],
      ["screenshot", { ok: true, imageDataUrl: "data:image/png;base64,***" }],
      ["screenshot", { ok: true, imageDataUrl: "data:image/png;base64," + Buffer.concat([Buffer.from(png, "base64"), Buffer.alloc(460 * 1024)]).toString("base64") }],
      ["screenshot", { ok: false, error: "browser action failed" }],
      ["snapshot", { ok: true, url: "https://example.com/" + "p".repeat(5000), title: "T".repeat(600), nodes: [{ role: "button", name: "Go", ref: "e1" }], text: "dropped", totalNodes: 3, truncated: false }],
      ["snapshot", { ok: true, url: 5, nodes: [] }],
      ["snapshot", { ok: true, nodes: { role: "button" } }],
      ["snapshot", { ok: false, error: "browser action failed" }],
      ["inspect", { ok: true, url: "https://example.com/", title: "T", text: "body", links: [], untrusted: true }],
    ];
    const cases: OracleCase[] = payloads.map(([action, payload]) => ({ op: "call", action, args: {}, payload }));
    const expected = pythonBrowser(cases);
    payloads.forEach(([action, payload], index) => {
      const want = expected[index]!;
      let got: Row;
      try { got = { value: shapeResult(action as BrowserAction, payload) }; } catch (error) { got = { error: "RuntimeError", message: (error as Error).message }; }
      if (want.error) assert.deepEqual(got, { error: want.error, message: want.message }, `case ${index}`);
      else assert.deepEqual(got.value, want.value, `case ${index}`);
      if (action === "screenshot" && want.calls) assert.deepEqual(want.calls, [{ action, maxPngBytes: 450 * 1024 }]);
    });
  });

  it("decodes base64 and builds approval subjects the same way", () => {
    const texts = ["", "AAAA", "AAAA=", "AAAA==", "AA", "AA=", "AA==", "AAA", "AAA=", "AAA==", "A", "A==", "AB==", "AAAAA", "AAAAAA==", "AAAAAAA=", "AA AA", "AA\nAA", "-_==", "AAAA===", "AAAA=====", "AA===", "AAAA=A", "=", "==", "AAAAAA==AAAA", "名字"];
    const values: unknown[] = [{ action: "navigate", url: "https://例子.example/?q=\u2028\"" }, { b: 1, a: [1.5, 1e16, -0.0, true, null], c: { z: "😀", y: "\u0000" } }, { action: "fill", selector: "aria-ref=e1", text: "x" }];
    const expected = pythonBrowser([...texts.map((text): OracleCase => ({ op: "b64", text })), ...values.map((value): OracleCase => ({ op: "subject", value }))]);
    texts.forEach((text, index) => assert.equal(b64Valid(text), expected[index]!.value, JSON.stringify(text)));
    values.forEach((value, index) => assert.equal(browserSubject(value as Row), expected[texts.length + index]!.value));
  });

  it("publishes the same tool names, schemas, descriptions and gates", () => {
    const [facts] = pythonBrowser([{ op: "tools" }]);
    const rows = facts!.value as Row[];
    assert.deepEqual(rows.map((row) => (row.function as Row).name), ACTIONS.map((action) => "browser_" + action));
    ACTIONS.forEach((action, index) => {
      const row = rows[index]!, fn = row.function as Row;
      assert.equal(fn.description, toolDescription(action));
      assert.deepEqual(fn.parameters, schemaOf(action));
      assert.equal(row.gate, "exec");
      assert.equal(row.mutating, action === "click" || action === "fill");
      assert.equal(row.concurrency, false);
      assert.equal(row.subject, browserSubject({ action, x: 1 }));
    });
  });
});
