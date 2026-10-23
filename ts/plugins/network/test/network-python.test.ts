/** Parity with the Python network plugin (oracle.ts): text extraction, checks, and whole tool calls. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { pyJsonDumps } from "@xueness/contracts";
import { htmlText, idnaEncode, ipText, isGlobal, networkTools, NetworkError, parseHttpsUrl, parseIp, unescape, DESCRIPTIONS, modelSchema } from "../src/index.ts";
import { pythonNetwork, scriptedNet, type OracleCase, type ToolCase } from "./oracle.ts";
import { pythonPredatesSecurityBackports, pythonUnavailableReason } from "../../../test-support/python-oracle.ts";

function random(seed: number): () => number { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const pick = <T>(next: () => number, items: readonly T[]): T => items[Math.floor(next() * items.length)]!;

const HTML_PIECES = ["<p>", "</p>", "<script>", "</script>", "</SCRIPT >", "<style>x{}</style>", "<noscript>", "</noscript>", "<title>", "</title>", "<textarea>", "</textarea>",
  "<b class='a>b'>", "<img src=x />", "<br/>", "<!-- c -->", "<!--", "-->", "<!doctype html>", "<![CDATA[x]]>", "<?pi?>", "<!bogus>", "</>", "</ x>", "<", ">", "&", "&amp;", "&lt;", "&#65;",
  "&#x41;", "&#0;", "&#128;", "&#xD800;", "&notit;", "&notin;", "&ampx", "&#1114112;", " ", "\n", "\t", "\u00a0", "text", "中文", "😀", "a < b", "<plaintext>", "<xmp>", "</xmp>",
  "<iframe>", "</iframe>", "<div\n>", "<a href=\"x\"", "<a b=c d>", "&#x;", "&;", "\u3000", "\u200b", "<SCRIPT>", "<scriptx>", "</scriptx>", "&gt", "&GT;", "&nbsp", "&#9;", "\r\n"];

function htmlCases(): string[] {
  const next = random(7), out = ["", "<p>Hello</p><script>var x='<p>'</script>World", "a&amp;b &lt;c&gt; &#20013;&#x6587;", "<title>A &amp; B</title><p>x &", "x &am", "tail &#123"];
  for (let index = 0; index < 400; index += 1) out.push(Array.from({ length: 1 + Math.floor(next() * 12) }, () => pick(next, HTML_PIECES)).join(""));
  return out;
}

const URLS: unknown[] = ["https://example.com/", "https://Example.COM/a?b=1", "https://example.com:443/", "https://example.com:444/", "https://example.com:/", "https://u@example.com/",
  "https://u:p@example.com/", "https://example.com/#f", "https://example.com/?q#", "http://example.com/", "HTTPS://example.com", "https:example.com", "https://", "https:///x",
  "https://[::1]/", "https://[::ffff:1.2.3.4]:443/x", "https://[1.2.3.4]/", "https://[v1.x]/", "https://[fe80::1%25eth0]/", "https://ex ample.com", "https://example.com/\u00e9",
  "https://example.com/?q=\u00e9", "https://例子.测试/", "https://bücher.de/", "https://XN--bcher-kva.de/", "https://xn--abc.例子/", "https://a..b/", "https://" + "a".repeat(64) + ".com/",
  "https://" + "a".repeat(63) + ".com/", "https://" + ("a".repeat(60) + ".").repeat(5) + "com/", "https://example.com\\x", "https://exa\u2100mple.com/", "https://ｅｘａｍｐｌｅ.com/",
  "https://example.com:0443/", "https://example.com:99999/", "https://example.com:44a/", "https://[::1/", "https://::1]/", "https://a]b[/", "https://x/" + "a".repeat(4096), 5, null, "",
  "https://مثال.إختبار/", "https://مثالa.com/", "https://straße.de/", "https://\u00ad.com/", "https://a\u3002b\uff0ec/", "https://a.b./", "https://exam\u0000ple.com", "https://x.com/\u007f",
  "https://192.168.0.1/", "https://example.com?x", "https://\u{1F600}.com/", "https://ſ.com/"];

function ipCases(): unknown[] {
  return ["1.2.3.4", "8.8.8.8", "10.0.0.1", "127.0.0.1", "100.64.0.1", "198.18.0.1", "198.19.255.255", "198.20.0.1", "192.0.0.9", "192.0.0.10", "192.0.0.11", "240.0.0.1", "255.255.255.255",
    "224.0.0.1", "0.0.0.0", "01.2.3.4", "1.2.3", "256.1.1.1", "::1", "::", "2001:4860:4860::8888", "2001:db8::1", "::ffff:8.8.8.8", "::ffff:127.0.0.1", "64:ff9b::7f00:1", "64:ff9b:1::1",
    "2002::1", "fc00::1", "fe80::1%eth0", "fe80::1%", "2001:1::1", "2001:3::1", "2001:20::1", "3fff::1", "1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7:8:9", "1::2::3", ":1:2:3:4:5:6:7", "1:0:0:2:0:0:0:3",
    "0:0:1:0:0:1:0:0", "ABCD::EF", "1.2.3.4/32", "", 1, 0, true, false, 4294967295, 4294967296, -1, 1.5, null, [1], "١.٢.٣.٤", "::1.2.3.4", "1::1.2.3", "2606:4700:4700::1111"];
}

/** The TS tool call: precheck, then the Gate (recorded; refused when `deny`), then run. */
async function tsTool(item: ToolCase): Promise<{ result: string; checks: [string, string][]; lookups: string[]; requests: unknown[] }> {
  const state = mkdtempSync(join(tmpdir(), "net-state-"));
  for (const [name, text] of Object.entries(item.files ?? {})) { mkdirSync(dirname(join(state, name)), { recursive: true }); writeFileSync(join(state, name), text); }
  const net = scriptedNet(item);
  let clock = 0;
  const tools = networkTools({ stateDir: state, net, env: item.env ?? {}, now: () => (clock += item.clockStep ?? 0) * 1000 });
  const tool = tools.find((candidate) => candidate.name === item.tool)!;
  const checks: [string, string][] = [];
  const pre = tool.precheck?.(item.args);
  if (pre) return { result: pyJsonDumps(pre.data), checks, lookups: net.lookups, requests: net.requests };
  checks.push([tool.gate, tool.subject!(item.args)]);
  if (item.deny) return { result: "gate_denied", checks, lookups: net.lookups, requests: net.requests };
  const result = await tool.run(item.args, { cwd: state, roots: [state], artifactsDir: state, tracker: undefined as never });
  return { result: pyJsonDumps(result.data), checks, lookups: net.lookups, requests: net.requests };
}

export const b64 = (text: string | Buffer): string => Buffer.from(text).toString("base64");

describe("network plugin: Python parity", { skip: pythonUnavailableReason() ?? false }, () => {
  it("extracts page text like transport._Text and unescapes like html.unescape", () => {
    const texts = htmlCases();
    const extra = ["&#" + "0".repeat(4301) + "65;", "&#" + "9".repeat(30) + ";", "&#x" + "0".repeat(5000) + "41;"];
    const python = pythonNetwork([...texts.map((text): OracleCase => ({ op: "html", text })), ...[...texts, ...extra].map((text): OracleCase => ({ op: "unescape", text }))]);
    const oldParser = pythonPredatesSecurityBackports(); // pre-3.11.17 html.parser lacks the CDATA/plaintext fixes
    texts.forEach((text, index) => oldParser || assert.deepEqual({ value: htmlText(text) }, python[index], JSON.stringify(text)));
    [...texts, ...extra].forEach((text, index) => {
      const expected = python[texts.length + index]!;
      let actual: unknown;
      try { actual = { value: unescape(text) }; } catch (error) { actual = { error: "ValueError", message: (error as Error).message }; }
      if (expected.error) assert.equal((actual as { error?: string }).error, expected.error, JSON.stringify(text).slice(0, 80));
      else assert.deepEqual(actual, expected, JSON.stringify(text).slice(0, 80));
    });
  });

  it("checks URLs, IP answers and IDNA hosts like Python", () => {
    const hosts = ["example.com", "Bücher.de", "例子.测试", "a..b", "", ".", "a.", "xn--abc", "ß.de", "ς.gr", "a\u200db.com", "مثال", "مثالa", "١٢٣", "\u00ad", "\u0378", "a".repeat(64), "😀.com", "ǅ.com", "Ⅻ.com", "\ufb01.com", "a\u0301.com"];
    const ips = ipCases();
    const cases: OracleCase[] = [...URLS.flatMap((url): OracleCase[] => [{ op: "url", url, query: true }, { op: "url", url, query: false }]), ...ips.map((value): OracleCase => ({ op: "ip", value })), ...hosts.map((host): OracleCase => ({ op: "idna", host }))];
    const python = pythonNetwork(cases);
    cases.forEach((item, index) => {
      let actual: unknown;
      if (item.op === "url") { try { const { parsed, host } = parseHttpsUrl(item.url, item.query); actual = [host, parsed.path, parsed.query]; } catch (error) { actual = (error as NetworkError).asResult(); } }
      else if (item.op === "ip") { if (pythonPredatesSecurityBackports()) return; const ip = parseIp(item.value); actual = ip ? [ipText(ip), isGlobal(ip)] : null; }
      else if (item.op === "idna") { try { actual = idnaEncode(item.host); } catch { actual = null; } }
      assert.deepEqual({ value: actual }, python[index], JSON.stringify(item));
    });
  });

  it("offers the same three tools", () => {
    const [python] = pythonNetwork([{ op: "tools" }]);
    const tools = networkTools({ stateDir: tmpdir(), net: scriptedNet({}) });
    assert.deepEqual(tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.modelSchema }, gate: tool.gate, mutating: tool.mutating, concurrency: tool.concurrencySafe, subject: tool.subject!({ url: "u", query: "q" }) })), python!.value);
    assert.deepEqual(Object.keys(DESCRIPTIONS), ["web_fetch", "web_search", "image_search"]);
    assert.deepEqual(modelSchema("url").required, ["url"]);
  });

  it("runs whole tool calls like Python", async () => {
    const { TOOL_CASES } = await import("./network-cases.ts");
    const python = pythonNetwork(TOOL_CASES.map((item): OracleCase => ({ op: "tool", ...item })));
    for (const [index, item] of TOOL_CASES.entries()) {
      const actual = await tsTool(item);
      const expected = python[index]!;
      assert.equal(expected.error, undefined, `${index}: python raised ${expected.error}: ${expected.message}`);
      const label = `${index} ${item.tool} ${JSON.stringify(item.args).slice(0, 60)}`;
      // Python hands a missing or non-text argument to the gate as is; TS subjects are always text.
      const pythonChecks = (expected.checks as [string, unknown][]).map(([kind, subject]) => [kind, typeof subject === "string" ? subject : ""]);
      assert.deepEqual(actual.checks, pythonChecks, label);
      assert.deepEqual(actual.lookups, expected.lookups, label);
      assert.deepEqual(actual.requests, expected.requests, label);
      assert.equal(actual.result, expected.result, label);
    }
  });
});
