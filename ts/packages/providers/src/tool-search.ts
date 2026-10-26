/**
 * ToolSearch local/native negotiation, gated on protocol capability.
 *
 * Upstream resolves the mode the same way: native deferred-loading search is
 * only offered by a protocol adapter that actually implements the surface
 * (Anthropic's tool-search beta header and `deferLoading` mapping), while every
 * other tool-calling model uses the local catalog search. The gate key is the
 * declared protocol capability — never a model, brand or endpoint list.
 */
export type ToolSearchMode = "local" | "native";

/** The protocol view the negotiation reads; adapters and switchable providers satisfy it structurally. */
export interface ToolSearchProviderView {
  protocol?: string | null;
  toolCalling?: string | null;
  /**
   * Declared only by a protocol adapter that implements the provider-side
   * deferred-loading tool-search surface. No bundled adapter declares it yet,
   * so every provider resolves local; a JSON tool-calling provider has no
   * protocol-native surface at all and always resolves local.
   */
  nativeToolSearch?: boolean;
}

/** `resolveToolSearchMode`: native only on a real protocol capability, local otherwise. */
export function resolveToolSearchMode(provider: ToolSearchProviderView | null | undefined): ToolSearchMode {
  if (provider?.nativeToolSearch === true && provider.toolCalling !== "json") return "native";
  return "local";
}
