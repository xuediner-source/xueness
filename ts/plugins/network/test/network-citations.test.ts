import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ToolEnv } from "@xueness/engine-tools";
import { citationLines, citationsFromRows, extractCitations, fetchCitation, networkTools, withCitations,
  type HttpExchange, type HttpResponse, type Net, type SourceCitation } from "../src/index.ts";

interface Reply { status?: number; contentType?: string; location?: string; body: string }

function scripted(replies: Reply[], dns: Record<string, string[]> = {}): Net & { requests: HttpExchange[] } {
  const requests: HttpExchange[] = [];
  return { requests,
    async lookup(host) { return dns[host] ?? ["8.8.8.8"]; },
    async request(exchange): Promise<HttpResponse> {
      requests.push(exchange);
      const reply = replies[requests.length - 1] ?? { status: 200, contentType: "text/plain", body: "ok" };
      const bytes = Buffer.from(reply.body, "utf8");
      return { status: reply.status ?? 200, contentType: reply.contentType ?? "text/plain", ...(reply.location !== undefined ? { location: reply.location } : {}),
        async read(limit) { return bytes.subarray(0, limit); }, close() {} };
    },
  };
}

const state = (extra: Record<string, unknown> = {}): string => {
  const dir = mkdtempSync(join(tmpdir(), "network-citations-"));
  mkdirSync(join(dir, "network"), { recursive: true });
  writeFileSync(join(dir, "network", "settings.json"), JSON.stringify({ searchProvider: "brave", searchMode: "service", ...extra }));
  writeFileSync(join(dir, "network", "search-key.json"), JSON.stringify({ apiKey: "test-key" }));
  return dir;
};
const toolEnv = (cwd: string): ToolEnv => ({ cwd, roots: [cwd], tracker: undefined as never, artifactsDir: cwd });
const pick = (list: ReturnType<typeof networkTools>, name: string) => list.find((tool) => tool.name === name)!;
const BRAVE = { web: { results: [
  { title: "Glaciers 2026", url: "https://example.org/glaciers", description: "Retreat rates" },
  { title: "Second source", url: "https://second.example/paper", description: "More" },
] } };

describe("extractCitations (provider-native payloads)", () => {
  it("reads OpenAI-style url_citation annotations", () => {
    const payload = { annotations: [
      { type: "url_citation", url_citation: { title: "Docs", url: "https://docs.example/x", cited_text: "quoted" } },
      { type: "url_citation", url_citation: { title: "Alt", uri: "https://alt.example/y" } },
    ] };
    assert.deepEqual(extractCitations(payload).map((c) => [c.index, c.title, c.url]), [[1, "Docs", "https://docs.example/x"], [2, "Alt", "https://alt.example/y"]]);
    assert.equal(extractCitations(payload)[0]!.snippet, "quoted");
  });
  it("reads Anthropic-style web search result blocks", () => {
    const payload = { content: [
      { type: "text", text: "answer" },
      { type: "web_search_tool_result", content: [{ type: "web_search_result", title: "A", url: "https://a.example/1" }] },
      { type: "search_result_block", title: "B", url: "https://b.example/2" },
    ] };
    assert.deepEqual(extractCitations(payload).map((c) => c.url), ["https://a.example/1", "https://b.example/2"]);
    const legacy = extractCitations({ web_search_results: [{ title: "C", url: "https://c.example/3" }] });
    assert.deepEqual(legacy.map((c) => c.url), ["https://c.example/3"]);
  });
  it("reads the generic sources array and dedupes across shapes", () => {
    const payload = { sources: [{ title: "S", url: "https://s.example/1" }, { title: "S again", url: "https://s.example/1" }, { title: "T", url: "https://t.example/2" }] };
    assert.deepEqual(extractCitations(payload).map((c) => c.url), ["https://s.example/1", "https://t.example/2"]);
  });
  it("invents nothing for unknown, empty or non-https payloads", () => {
    assert.deepEqual(extractCitations(null), []);
    assert.deepEqual(extractCitations("nope"), []);
    assert.deepEqual(extractCitations({ irrelevant: true }), []);
    assert.deepEqual(extractCitations({ sources: [{ title: "x", url: "http://insecure.example/a" }] }), []);
    assert.deepEqual(extractCitations({ sources: [{ title: "x", url: "javascript:alert(1)" }] }), []);
  });
  it("caps at ten citations and marks them unverified provider-native", () => {
    const sources = Array.from({ length: 14 }, (_, i) => ({ title: `t${i}`, url: `https://cap.example/${i}` }));
    const citations = extractCitations({ sources });
    assert.equal(citations.length, 10);
    assert.ok(citations.every((c) => c.origin === "provider_native" && c.verified === false));
    assert.equal(citations[9]!.index, 10);
  });
});

describe("citation helpers", () => {
  it("citationsFromRows bounds and orders platform rows", () => {
    const rows = [{ title: "a", url: "https://a.example/", description: "d" }, { title: "b", url: "not-a-url" }, { title: "c", url: "https://c.example/" }];
    const citations = citationsFromRows(rows, "search_service", false);
    assert.deepEqual(citations.map((c) => c.url), ["https://a.example/", "https://c.example/"]);
    assert.equal(citations[0]!.index, 1);
    assert.equal(citations[0]!.snippet, "d");
  });
  it("fetchCitation marks the read page verified", () => {
    const [citation] = fetchCitation("Page title", "https://page.example/final");
    assert.equal(citation!.origin, "web_fetch");
    assert.equal(citation!.verified, true);
    assert.deepEqual(fetchCitation("t", "ftp://page.example/x"), []);
  });
  it("withCitations attaches the list and provenance without clobbering", () => {
    const result = withCitations({ ok: true, query: "q", provenance: { kind: "search_service", urlsVerified: false }, keep: 1 } as Record<string, unknown>,
      [{ index: 1, title: "a", url: "https://a.example/", origin: "search_service", verified: false } as SourceCitation]);
    assert.equal((result.citations as SourceCitation[]).length, 1);
    assert.equal((result.provenance as Record<string, unknown>).kind, "search_service");
    assert.equal((result.provenance as Record<string, unknown>).citations, 1);
    assert.deepEqual((result.provenance as Record<string, unknown>).citationOrigins, ["search_service"]);
    assert.equal(result.keep, 1);
    const untouched = withCitations({ ok: true }, []);
    assert.equal("citations" in untouched, false);
  });
  it("citationLines render one traceable line per source", () => {
    assert.deepEqual(citationLines([{ index: 1, title: "Docs", url: "https://docs.example/", origin: "web_fetch", verified: true }]), ["[1] Docs — https://docs.example/"]);
    assert.deepEqual(citationLines([{ index: 2, title: "", url: "https://plain.example/", origin: "provider_native", verified: false }]), ["[2] https://plain.example/"]);
  });
});

describe("network tools with the citation face", () => {
  it("web_search endpoint answers carry search_service citations", async () => {
    const dir = state();
    const net = scripted([{ contentType: "application/json", body: JSON.stringify(BRAVE) }]);
    const result = await pick(networkTools({ stateDir: dir, net, env: {} }), "web_search").run({ query: "glaciers" }, toolEnv(dir));
    assert.equal(result.ok, true);
    const citations = result.data!.citations as SourceCitation[];
    assert.deepEqual(citations.map((c) => c.url), ["https://example.org/glaciers", "https://second.example/paper"]);
    assert.ok(citations.every((c) => c.origin === "search_service" && c.verified === false));
    assert.equal((result.data!.provenance as Record<string, unknown>).citations, 2);
  });
  it("web_search delegates when the active provider negotiated native search", async () => {
    const dir = state();
    const net = scripted([{ contentType: "application/json", body: JSON.stringify(BRAVE) }]);
    const tools = networkTools({ stateDir: dir, net, env: {}, searchProviderView: () => ({ protocol: "anthropic", toolCalling: "native", nativeWebSearch: true }) });
    const result = await pick(tools, "web_search").run({ query: "glaciers" }, toolEnv(dir));
    assert.equal(result.ok, true);
    assert.equal(result.data!.native, "provider_web_search");
    assert.equal(result.data!.searchMode, "native");
    assert.equal(net.requests.length, 0);
  });
  it("a JSON tool-calling provider stays on endpoint search", async () => {
    const dir = state();
    const net = scripted([{ contentType: "application/json", body: JSON.stringify(BRAVE) }]);
    const tools = networkTools({ stateDir: dir, net, env: {}, searchProviderView: () => ({ protocol: "openai", toolCalling: "json", nativeWebSearch: true }) });
    const result = await pick(tools, "web_search").run({ query: "glaciers" }, toolEnv(dir));
    assert.equal(result.data!.sourceType, "search_service");
    assert.equal(net.requests.length, 1);
  });
  it("web_fetch cites the final URL it actually read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "network-cite-fetch-"));
    const net = scripted([{ status: 302, contentType: "text/plain", location: "https://next.example/final", body: "" }, { contentType: "text/html", body: "<p>Done</p>" }]);
    const result = await pick(networkTools({ stateDir: dir, net, env: {} }), "web_fetch").run({ url: "https://start.example/a" }, toolEnv(dir));
    assert.equal(result.ok, true);
    const [citation] = result.data!.citations as SourceCitation[];
    assert.equal(citation!.url, "https://next.example/final");
    assert.equal(citation!.verified, true);
  });
  it("image_search answers carry image citations from their source pages", async () => {
    const dir = state({ imageSearchEndpoint: "https://images.example/search" });
    const payload = { results: [{ title: "Iceberg", url: "https://source.example/iceberg", properties: { url: "https://img.example/iceberg.png" } }] };
    const net = scripted([{ contentType: "application/json", body: JSON.stringify(payload) }]);
    const result = await pick(networkTools({ stateDir: dir, net, env: { XUENESS_SEARCH_KEY: "test-key" } }), "image_search").run({ query: "iceberg" }, toolEnv(dir));
    assert.equal(result.ok, true);
    const citations = result.data!.citations as SourceCitation[];
    assert.equal(citations.length, 1);
    assert.equal(citations[0]!.url, "https://source.example/iceberg");
    assert.equal(citations[0]!.origin, "image_search");
  });
  it("failed searches carry no citations", async () => {
    const dir = state();
    const net = scripted([{ status: 401, contentType: "text/plain", body: "denied" }]);
    const result = await pick(networkTools({ stateDir: dir, net, env: {} }), "web_search").run({ query: "glaciers" }, toolEnv(dir));
    assert.equal(result.ok, false);
    assert.equal(result.data!.citations, undefined);
  });
});
