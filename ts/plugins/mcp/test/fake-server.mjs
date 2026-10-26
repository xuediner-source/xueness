// A scripted stdio MCP server for the plugin tests. Flags (argv):
//   --reject=<v,v>      answer initialize for these versions with a JSON-RPC error
//   --answer=<v>        reply with this protocolVersion (default: the requested one)
//   --resources         advertise resources/prompts
//   --subscribe         advertise resources with subscribe: true
//   --ask-first         send a server request before answering tools/call
//   --exit-after-call   exit after answering the first tools/call
//   --silent-call       never answer tools/call
//   --env               the echo tool also reports which env vars it sees
//   --progress          echo emits notifications/progress for the request's _meta.progressToken
//   --paged-catalogs    resources/list and prompts/list answer one item per cursor page
//   --endless-cursor    tools/list always returns a fresh nextCursor (page-limit probe)
//   --delay-call=<ms>   answer tools/call only after this delay
//   --change-after-call rename echo→beta and notify tools/list_changed on the first tools/call
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const flags = new Map(process.argv.slice(2).map((arg) => { const [k, v = "1"] = arg.replace(/^--/, "").split("="); return [k, v]; }));
const reject = new Set((flags.get("reject") ?? "").split(",").filter(Boolean));
const record = (name, value) => { if (process.env[name]) appendFileSync(process.env[name], `${value}\n`); };
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
process.stdout.write("not json, ignored\n");
process.stderr.write("server noise on stderr\n");
let tools = [
  { name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "fail", description: "Always fails" },
  { name: "structured", description: "Structured", inputSchema: { type: "object", properties: {} } },
  { name: "Weird Name!", description: "Sanitized" },
  // --rich adds this one so existing tool-list assertions stay exact.
  ...(flags.has("rich") ? [{ name: "rich", description: "Rich content blocks", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] : []),
];
// Valid magic-byte prefixes; rich-content tests only need the signature to check out.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64");
const WAV = Buffer.from("RIFFuave.wave").toString("base64");
let pendingAsk = null;
let pages = 0;
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.id === "ask-1" && pendingAsk) { const done = pendingAsk; pendingAsk = null; done(message); return; }
  const { id, method, params = {} } = message;
  if (method === "initialize") {
    if (reject.has(params.protocolVersion)) return send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Unsupported protocol version" } });
    const resources = flags.has("subscribe") ? { subscribe: true } : {};
    const capabilities = { tools: { listChanged: true }, ...(flags.has("resources") || flags.has("subscribe") ? { resources, prompts: {} } : {}) };
    return send({ jsonrpc: "2.0", id, result: { protocolVersion: flags.get("answer") ?? params.protocolVersion, capabilities, serverInfo: { name: "fake", version: "1" } } });
  }
  if (method === "notifications/initialized") return;
  if (method === "notifications/cancelled") { record("MCP_CANCEL_FILE", String(params.requestId)); return; }
  if (method === "tools/list") {
    if (flags.has("endless-cursor")) return send({ jsonrpc: "2.0", id, result: { tools, nextCursor: `forever-${++pages}` } });
    if (!params.cursor) return send({ jsonrpc: "2.0", id, result: { tools: tools.slice(0, 2), nextCursor: "page-2" } });
    return send({ jsonrpc: "2.0", id, result: { tools: tools.slice(2) } });
  }
  if (method === "tools/call") {
    if (flags.has("silent-call")) return;
    const answer = (result) => { send({ jsonrpc: "2.0", id, result }); if (flags.has("exit-after-call")) process.exit(0); };
    const name = params.name; const args = params.arguments ?? {};
    const run = (extra = "") => {
      if (flags.has("change-after-call")) {
        flags.delete("change-after-call");
        tools = [{ name: "beta", description: "Renamed", inputSchema: { type: "object" } }];
        send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
        return answer({ content: [{ type: "text", text: "renamed" }] });
      }
      if (name === "echo") {
        const token = params._meta?.progressToken;
        if (flags.has("progress") && token !== undefined) {
          send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: 1, total: 2 } });
          send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: 2, total: 2 } });
        }
        return answer({ content: [{ type: "text", text: "echo: " + args.text + extra }, ...(flags.has("env") ? [{ type: "text", text: "env: " + Object.keys(process.env).filter((key) => !key.startsWith("__")).sort().join(",") }] : [])] });
      }
      if (name === "beta") return answer({ content: [{ type: "text", text: "beta: " + args.text }] });
      if (name === "fail") return answer({ isError: true, content: [{ type: "text", text: "bad input" }] });
      if (name === "structured") return answer({ content: [], structuredContent: { a: 1, list: ["x"] } });
      if (name === "Weird Name!") return answer({ content: [{ type: "resource", resource: { uri: "file:///x", text: "resource text" } }] });
      if (name === "rich") return answer({ content: [
        { type: "text", text: "rich: " + args.text },
        { type: "image", mimeType: "image/png", data: PNG },
        { type: "audio", mimeType: "audio/wav", data: WAV },
        { type: "resource_link", uri: "file:///linked", name: "linked" },
        { type: "resource", resource: { uri: "file:///shot.png", mimeType: "image/png", blob: PNG } },
      ] });
      return send({ jsonrpc: "2.0", id, error: { code: -32601, message: "no such tool" } });
    };
    if (flags.has("ask-first")) {
      pendingAsk = (reply) => run(" / ask reply: " + (reply.error ? reply.error.message : "none"));
      return send({ jsonrpc: "2.0", id: "ask-1", method: "sampling/createMessage", params: {} });
    }
    if (flags.has("delay-call")) return setTimeout(run, Number(flags.get("delay-call")) || 0);
    return run();
  }
  if (method === "resources/subscribe" || method === "resources/unsubscribe") return send({ jsonrpc: "2.0", id, result: {} });
  if (method === "resources/list") {
    if (!flags.has("paged-catalogs")) return send({ jsonrpc: "2.0", id, result: { resources: [{ uri: "file:///a", name: "a" }] } });
    const catalog = [["file:///a", "a"], ["file:///b", "b"], ["file:///c", "c"]];
    const at = params.cursor ? catalog.findIndex(([uri]) => uri === params.cursor) : 0;
    const slice = at < 0 ? [] : catalog.slice(at, at + 1).map(([uri, label]) => ({ uri, name: label }));
    return send({ jsonrpc: "2.0", id, result: { resources: slice, ...(at + 1 < catalog.length ? { nextCursor: catalog[at + 1][0] } : {}) } });
  }
  if (method === "resources/read") {
    if (flags.has("rich") && params.uri === "file:///shot.png") return send({ jsonrpc: "2.0", id, result: { contents: [{ uri: params.uri, mimeType: "image/png", blob: PNG }] } });
    return send({ jsonrpc: "2.0", id, result: { contents: [{ uri: params.uri, text: "contents of " + params.uri }] } });
  }
  if (method === "prompts/list") {
    if (!flags.has("paged-catalogs")) return send({ jsonrpc: "2.0", id, result: { prompts: [{ name: "p" }] } });
    const names = ["p1", "p2", "p3"];
    const at = params.cursor ? names.indexOf(String(params.cursor)) : 0;
    const slice = at < 0 ? [] : names.slice(at, at + 1).map((prompt) => ({ name: prompt }));
    return send({ jsonrpc: "2.0", id, result: { prompts: slice, ...(at + 1 < names.length ? { nextCursor: names[at + 1] } : {}) } });
  }
  if (method === "prompts/get") return send({ jsonrpc: "2.0", id, result: { messages: [{ role: "user", content: { type: "text", text: "prompt " + params.name + (params.arguments?.topic ? " about " + params.arguments.topic : "") } }] } });
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
});
