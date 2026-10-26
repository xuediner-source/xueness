/**
 * Web search local/native negotiation, gated on protocol capability (F12.04).
 *
 * Mirrors `tool-search.ts`: provider-native web search is only chosen for a
 * protocol adapter that actually implements the provider-side search surface
 * (server-side search tools and their citation blocks). Every other provider —
 * including JSON tool-calling ones — keeps the endpoint search path, so the
 * platform's configured search service stays the source of truth.
 */

/** The resolved search capability face for the active provider. */
export type WebSearchMode = "native" | "endpoint";

/**
 * The protocol view the negotiation reads; adapters and switchable providers
 * satisfy it structurally. `nativeWebSearch` is declared only by a protocol
 * adapter that implements the provider-side search surface; nothing bundled
 * declares it yet, so every bundled provider resolves endpoint.
 */
export interface WebSearchProviderView {
  protocol?: string | null;
  toolCalling?: string | null;
  nativeWebSearch?: boolean;
}

/** `resolveWebSearchMode`: native only on a real protocol capability, endpoint otherwise. */
export function resolveWebSearchMode(provider: WebSearchProviderView | null | undefined): WebSearchMode {
  if (provider?.nativeWebSearch === true && provider.toolCalling !== "json") return "native";
  return "endpoint";
}

/**
 * The stable result the platform `web_search` tool returns when the active
 * provider runs search natively: the query is delegated to the provider's own
 * search surface, and answers must cite the sources that surface returned
 * (parsed back through the network plugin's citation face).
 */
export function nativeSearchDelegation(query: string): Record<string, unknown> {
  return {
    ok: true,
    query,
    native: "provider_web_search",
    searchMode: "native",
    notice: "The active provider runs web search natively; the endpoint search tool is delegated. Search through the provider's native search surface and cite the sources it returns.",
    provenance: { kind: "provider_native_search", delegated: true },
  };
}
