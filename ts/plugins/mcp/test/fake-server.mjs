// A scripted stdio MCP server for the plugin tests. Flags (argv):
//   --reject=<v,v>      answer initialize for these versions with a JSON-RPC error
//   --answer=<v>        reply with this protocolVersion (default: the requested one)
//   --resources         advertise resources/prompts
//   --ask-first         send a server request before answering tools/call
//   --exit-after-call   exit after answering the first tools/call
//   --silent-call       never answer tools/call
//   --env               the echo tool also reports which env vars it sees
import { createInterface } from "node:readline";
const flags = new Map(process.argv.slice(2).map((arg) => { const [k, v = "1"] = arg.replace(/^--/, "").split("="); return [k, v]; }));
const reject = new Set((flags.get("reject") ?? "").split(",").filter(Boolean));
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
process.stdout.write("not json, ignored\n");
process.stderr.write("server noise on stderr\n");
const tools = [
  { name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "fail", description: "Always fails" },
  { name: "structured", description: "Structured", inputSchema: { type: "object", properties: {} } },
  { name: "Weird Name!", description: "Sanitized" },
];
let pendingAsk = null;
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.id === "ask-1" && pendingAsk) { const done = pendingAsk; pendingAsk = null; done(message); return; }
  const { id, method, params = {} } = message;
  if (method === "initialize") {
    if (reject.has(params.protocolVersion)) return send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Unsupported protocol version" } });
    const capabilities = { tools: {}, ...(flags.has("resources") ? { resources: {}, prompts: {} } : {}) };
    return send({ jsonrpc: "2.0", id, result: { protocolVersion: flags.get("answer") ?? params.protocolVersion, capabilities, serverInfo: { name: "fake", version: "1" } } });
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") {
    if (!params.cursor) return send({ jsonrpc: "2.0", id, result: { tools: tools.slice(0, 2), nextCursor: "page-2" } });
    return send({ jsonrpc: "2.0", id, result: { tools: tools.slice(2) } });
  }
  if (method === "tools/call") {
    if (flags.has("silent-call")) return;
    const answer = (result) => { send({ jsonrpc: "2.0", id, result }); if (flags.has("exit-after-call")) process.exit(0); };
    const name = params.name; const args = params.arguments ?? {};
    const run = (extra = "") => {
      if (name === "echo") return answer({ content: [{ type: "text", text: "echo: " + args.text + extra }, ...(flags.has("env") ? [{ type: "text", text: "env: " + Object.keys(process.env).filter((key) => !key.startsWith("__")).sort().join(",") }] : [])] });
      if (name === "fail") return answer({ isError: true, content: [{ type: "text", text: "bad input" }] });
      if (name === "structured") return answer({ content: [], structuredContent: { a: 1, list: ["x"] } });
      if (name === "Weird Name!") return answer({ content: [{ type: "resource", resource: { uri: "file:///x", text: "resource text" } }] });
      return send({ jsonrpc: "2.0", id, error: { code: -32601, message: "no such tool" } });
    };
    if (flags.has("ask-first")) {
      pendingAsk = (reply) => run(" / ask reply: " + (reply.error ? reply.error.message : "none"));
      return send({ jsonrpc: "2.0", id: "ask-1", method: "sampling/createMessage", params: {} });
    }
    return run();
  }
  if (method === "resources/list") return send({ jsonrpc: "2.0", id, result: { resources: [{ uri: "file:///a", name: "a" }] } });
  if (method === "resources/read") return send({ jsonrpc: "2.0", id, result: { contents: [{ uri: params.uri, text: "contents of " + params.uri }] } });
  if (method === "prompts/list") return send({ jsonrpc: "2.0", id, result: { prompts: [{ name: "p" }] } });
  if (method === "prompts/get") return send({ jsonrpc: "2.0", id, result: { messages: [{ role: "user", content: { type: "text", text: "prompt " + params.name } }] } });
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
});
