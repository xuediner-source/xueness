/**
 * Tavern: roleplay with SillyTavern-compatible character cards and world books. An official optional plugin,
 * downloaded from the plugin center; off until installed and enabled. It is a native Xueness implementation:
 * cards are imported as data, and a roleplay is an ordinary chat that opens with a brief built from the card.
 */
import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };

export { bookEntries, CardError, contentId, MAX_CARD_BYTES, parseCharacter, parseWorldBook, type BookEntry, type Character, type WorldBook } from "./cards.ts";
export { createTavernHttp, TAVERN_ROUTES, type TavernHttpOptions } from "./http.ts";
export { applyMacros, roleplayBrief, selectEntries, type Brief, type BriefInput } from "./prompt.ts";
export { TavernStore, type TavernKind } from "./store.ts";

export const tavern: BundledPlugin = { manifest, plugin: definePlugin({ name: "tavern", apply() {} }) };
