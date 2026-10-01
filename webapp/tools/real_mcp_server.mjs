// A real MCP server built on the OFFICIAL @modelcontextprotocol/sdk.
//
// Purpose: prove Xueness's stdlib McpClient interoperates with a genuine
// third-party implementation, not just the hand-rolled fake used in unit tests.
// The SDK is the same code real servers ship, so a passing run is real
// protocol evidence (handshake, tools/list, tools/call, error results).
//
// Run: node real_mcp_server.mjs
// Speaks newline-delimited JSON-RPC over stdio.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "xueness-compat-probe",
  version: "1.0.0",
});

server.registerTool(
  "echo",
  {
    description: "Echo the text argument back",
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({
    content: [{ type: "text", text: `SDK_ECHO:${text}` }],
  }),
);

server.registerTool(
  "add",
  {
    description: "Add two integers",
    inputSchema: { a: z.number(), b: z.number() },
  },
  async ({ a, b }) => ({
    content: [{ type: "text", text: String(a + b) }],
  }),
);

server.registerTool(
  "fail",
  {
    description: "Always returns an error result",
    inputSchema: {},
  },
  async () => ({
    content: [{ type: "text", text: "intentional failure" }],
    isError: true,
  }),
);

server.registerTool(
  "multipart",
  {
    description: "Returns several content blocks",
    inputSchema: {},
  },
  async () => ({
    content: [
      { type: "text", text: "part-one" },
      { type: "text", text: "part-two" },
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
