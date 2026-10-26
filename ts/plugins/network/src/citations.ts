/**
 * Source citation face for web and media reading (F12.04): one shape for
 * citations from every search origin — endpoint search services, search-model
 * answers, image results, fetched pages and provider-native search payloads —
 * so every network tool answer can carry traceable sources.
 */
import { pySlice } from "@xueness/contracts";
import type { Row } from "./errors.ts";

export const MAX_CITATIONS = 10;
const TITLE_MAX = 300;
const URL_MAX = 4096;
const SNIPPET_MAX = 500;

/** One traceable source: where a claim or result came from. */
export interface SourceCitation {
  index: number;
  title: string;
  url: string;
  snippet?: string;
  origin: "search_service" | "search_model" | "image_search" | "web_fetch" | "provider_native";
  verified: boolean;
}

const httpsUrl = (value: unknown): string | null => {
  if (typeof value !== "string" || !value || value.length > URL_MAX) return null;
  return /^https:\/\/[^\s]+$/u.test(value) ? value : null;
};

function one(item: unknown, index: number, origin: SourceCitation["origin"], verified: boolean): SourceCitation | null {
  if (typeof item !== "object" || item === null) return null;
  const row = item as Row;
  const url = httpsUrl(row.url);
  if (!url) return null;
  return {
    index: index + 1,
    title: pySlice(typeof row.title === "string" ? row.title : "", TITLE_MAX),
    url,
    ...(typeof row.snippet === "string" && row.snippet ? { snippet: pySlice(row.snippet, SNIPPET_MAX) } : typeof row.description === "string" && row.description ? { snippet: pySlice(row.description, SNIPPET_MAX) } : {}),
    origin,
    verified,
  };
}

/**
 * Extract citations from a provider-native search answer: OpenAI-style
 * `message.annotations[].url_citation`, Anthropic-style `web_search_results`
 * / `search_result_content` blocks, and the generic `sources` array the
 * search-model prompt asks for. Unknown shapes yield no citations, never
 * invented ones.
 */
export function extractCitations(payload: unknown): SourceCitation[] {
  if (typeof payload !== "object" || payload === null) return [];
  const doc = payload as Row;
  const found: unknown[] = [];
  const push = (item: unknown): void => { if (item !== undefined && item !== null) found.push(item); };
  // OpenAI responses API: annotations with url_citation objects carrying title/url/uri.
  for (const annotation of Array.isArray(doc.annotations) ? doc.annotations : []) {
    if (typeof annotation !== "object" || annotation === null) continue;
    const citation = (annotation as Row).url_citation;
    if (typeof citation === "object" && citation !== null) {
      const row = citation as Row;
      push({ title: row.title, url: row.url ?? row.uri, snippet: row.cited_text });
    }
  }
  // Anthropic web search: tool_result / content blocks with url+title or a results array.
  for (const block of Array.isArray(doc.content) ? doc.content : []) {
    if (typeof block !== "object" || block === null) continue;
    const row = block as Row;
    if (row.type === "web_search_tool_result" && Array.isArray(row.content)) {
      for (const inner of row.content) if (typeof inner === "object" && inner !== null) push({ title: (inner as Row).title, url: (inner as Row).url });
    }
    if (row.type === "search_result_block" || row.type === "search_result_content") push({ title: row.title, url: row.url });
  }
  if (Array.isArray(doc.web_search_results)) for (const result of doc.web_search_results) { if (typeof result === "object" && result !== null) push({ title: (result as Row).title, url: (result as Row).url }); }
  if (Array.isArray(doc.sources)) for (const source of doc.sources) push(source);
  const citations: SourceCitation[] = [];
  const seen = new Set<string>();
  for (const item of found) {
    const citation = one(item, citations.length, "provider_native", false);
    if (!citation || seen.has(citation.url)) continue;
    seen.add(citation.url);
    citations.push(citation);
    if (citations.length >= MAX_CITATIONS) break;
  }
  return citations;
}

/** The citation list for a platform search/fetch result's own output rows. */
export function citationsFromRows(rows: unknown, origin: SourceCitation["origin"], verified: boolean): SourceCitation[] {
  if (!Array.isArray(rows)) return [];
  const citations: SourceCitation[] = [];
  for (const item of rows) {
    const citation = one(item, citations.length, origin, verified);
    if (citation) citations.push(citation);
    if (citations.length >= MAX_CITATIONS) break;
  }
  return citations;
}

/** One citation for the page a fetch actually read (the final URL after redirects). */
export function fetchCitation(title: unknown, url: unknown): SourceCitation[] {
  const citation = one({ title, url }, 0, "web_fetch", true);
  return citation ? [citation] : [];
}

/** Attach `citations` and a provenance note to a result row, preserving existing fields. */
export function withCitations(result: Row, citations: SourceCitation[]): Row {
  if (!citations.length) return result;
  const provenance = (typeof result.provenance === "object" && result.provenance !== null ? { ...(result.provenance as Row) } : {}) as Row;
  provenance.citations = citations.length;
  provenance.citationOrigins = [...new Set(citations.map((citation) => citation.origin))];
  return { ...result, citations: citations.map(({ index, title, url, snippet, origin, verified }) => ({ index, title, url, ...(snippet !== undefined ? { snippet } : {}), origin, verified })), provenance };
}

/** Render the trailing source list the model sees: one `[n] title — url` line per citation. */
export function citationLines(citations: SourceCitation[]): string[] {
  return citations.map((citation) => `[${citation.index}] ${citation.title || citation.url}${citation.title ? ` — ${citation.url}` : ""}`);
}
