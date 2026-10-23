/**
 * The bots plugin on TS (Python `bundled_plugins/bots`): an opt-in Telegram
 * inbox that turns allowlisted chat text into pending local sessions, and
 * explicitly confirmed replies. It registers no model tools. Tokens are named
 * environment references and are never saved or returned. The `bots` CLI
 * belongs to the TS CLI (roadmap step 9).
 */
import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };

export { fullMatch, isRelativeTo, loadState, pyResolve, saveChannel, validateChannel, withConfigLock, writeState, type BotState } from "./store.ts";
export { botRequest, fetchTransport, type BotTransport } from "./telegram.ts";
export { ChannelNotFound, poll, reply, type InboxOptions } from "./inbox.ts";
export { BOTS_ROUTES, createBotsHttp, type BotsHttpOptions } from "./http.ts";

export const bots: BundledPlugin = { manifest, plugin: definePlugin({ name: "bots", apply() { /* HTTP-only: no model tools */ } }) };
export const botsPlugin = bots.plugin;
