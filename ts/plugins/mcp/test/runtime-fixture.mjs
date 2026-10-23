import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const flags = new Set(process.argv.slice(2).map((arg) => arg.replace(/^--/, "")));
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let tools = flags.has("dynamic-tools") ? [{ name: "echo", inputSchema: { type: "object" } }] : [{ name: "echo", inputSchema: { type: "object" } }];
const record = (name, value) => { if (process.env[name]) appendFileSync(process.env[name], `${value}\n`); };
process.on("SIGTERM", () => { record("MCP_CLOSE_FILE", "closed"); process.exit(0); });
const lines = createInterface({ input: process.stdin });
lines.on("close", () => record("MCP_CLOSE_FILE", "closed"));
lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params = {} } = message;
  const answer = (result) => send({ jsonrpc: "2.0", id, result });
  if (method === "initialize") {
    record("MCP_INIT_FILE", "initialize");
    const resources = flags.has("subscriptions") ? { resources: { subscribe: true } } : flags.has("resources") ? { resources: {} } : {};
    answer({ protocolVersion: params.protocolVersion, capabilities: { tools: {}, ...resources }, serverInfo: { name: "runtime-fixture" } });
  } else if (method === "notifications/initialized") return;
  else if (method === "notifications/cancelled") { record("MCP_CANCEL_FILE", String(params.requestId)); return; }
  else if (method === "tools/list") answer({ tools });
  else if (method === "tools/call") {
    const args = params.arguments ?? {};
    if (flags.has("dynamic-tools") && args.text === "__change_tools__") {
      tools = [{ name: "alpha!", inputSchema: { type: "object" } }, { name: "alpha?", inputSchema: { type: "object" } }];
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      answer({ content: [{ type: "text", text: "changed" }] });
    } else answer({ content: [{ type: "text", text: `raw:${String(params.name)}` }] });
  } else if (method === "resources/subscribe" || method === "resources/unsubscribe") {
    send({ jsonrpc: "2.0", method: "notifications/resources/list_changed" });
    send({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri: String(params.uri), text: "private content must not enter metadata" } });
    answer({});
  } else if (method === "resources/list") answer({ resources: [{ uri: "file:///private" }] });
  else if (method === "resources/read") answer({ contents: [{ uri: params.uri, text: "private content" }] });
  else if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
});
