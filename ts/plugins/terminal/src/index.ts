/** Interactive terminals: a real PTY where the platform has a prebuilt binary, pipes otherwise. */
import { definePlugin, type BundledPlugin } from "@xueness/kernel";
import manifest from "../manifest.json" with { type: "json" };
import { Broker } from "./broker.ts";

export const terminalBroker = new Broker();

export { Broker, Terminal } from "./broker.ts";
export { createTerminalHttp, TERMINAL_ROUTES, type TerminalHttpOptions } from "./http.ts";
export { availableShells, resolveShell, shellPaths } from "./shells.ts";

export const terminal: BundledPlugin = {
  manifest,
  plugin: definePlugin({
    name: "terminal",
    apply(ctx) {
      try { ctx.provide("terminal.broker", terminalBroker); } catch { /* the host wires HTTP with its own broker */ }
    },
  }),
};
