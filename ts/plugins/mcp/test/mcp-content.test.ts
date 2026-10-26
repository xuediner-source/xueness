/**
 * F06.03: rich MCP content projection — images, audio, embedded resources,
 * resource_link blocks and attachment references, unit level and through the
 * real stdio plugin path (fake-server.mjs --rich).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Context, PluginHost } from "@xueness/kernel";
import { createToolEnv, runTool, type ToolDefinition } from "@xueness/engine-tools";
import { attachmentLine, MCP_MEDIA_MAX_ITEMS, projectBlocks, projectCallContent, projectResourceContents } from "../src/content.ts";
import { callResultText, MCP_MODEL_BYTES } from "../src/names.ts";
import { createMcp, type McpRun } from "../src/index.ts";

const SERVER = join(import.meta.dirname, "fake-server.mjs");
const WS = mkdtempSync(join(tmpdir(), "xueness-mcp-rich-ws-"));
after(() => rmSync(WS, { recursive: true, force: true }));

const PNG_RAW = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PNG = PNG_RAW.toString("base64");
const WAV = Buffer.from("RIFFuave.wave").toString("base64");

describe("MCP rich content projection", () => {
  it("keeps plain-text results identical to the parity converter", () => {
    const content = [{ type: "text", text: "one" }, { type: "text", text: "two" }, { type: "resource", resource: { uri: "file:///a", text: "inline" } }];
    const projected = projectCallContent("srv", { content });
    assert.equal(projected.text, callResultText({ content }).text);
    assert.deepEqual(projected.media, []);
    assert.equal(projected.ok, true);
  });

  it("attaches valid images with MIME, bytes and source intact", () => {
    const projected = projectCallContent("srv", { content: [{ type: "text", text: "shot" }, { type: "image", mimeType: "image/png", data: PNG }] });
    assert.equal(projected.text, `shot\n${attachmentLine({ mimeType: "image/png", placeholder: "mcp-srv-image-1" })}`);
    assert.equal(projected.text, "shot\n[Attached image/png: mcp-srv-image-1]");
    assert.deepEqual(projected.media, [{ mimeType: "image/png", data: PNG, placeholder: "mcp-srv-image-1" }]);
    assert.equal(Buffer.from(projected.media[0]!.data, "base64").toString("hex"), PNG_RAW.toString("hex"));
    assert.deepEqual(projected.attachments, [{ mimeType: "image/png", size: PNG_RAW.length, placeholder: "mcp-srv-image-1", source: "srv", untrusted: true }]);
  });

  it("keeps audio as a labeled reference with MIME and byte size", () => {
    const projected = projectCallContent("srv", { content: [{ type: "audio", mimeType: "audio/wav", data: WAV }] });
    assert.equal(projected.text, `[Audio: audio/wav, ${Buffer.from(WAV, "base64").length} bytes]`);
    assert.deepEqual(projected.media, []);
  });

  it("projects resource links with their uri and optional name", () => {
    const projected = projectCallContent("srv", { content: [{ type: "resource_link", uri: "file:///big", name: "big" }, { type: "resource_link", uri: "file:///anon" }] });
    assert.equal(projected.text, "[Resource link: file:///big (big)]\n[Resource link: file:///anon]");
  });

  it("attaches image blobs from embedded resources, references the rest", () => {
    const projected = projectCallContent("srv", { content: [
      { type: "resource", resource: { uri: "file:///shot.png", mimeType: "image/png", blob: PNG } },
      { type: "resource", resource: { uri: "file:///data.bin", mimeType: "application/octet-stream", blob: Buffer.from("0123456789").toString("base64") } },
    ] });
    assert.equal(projected.text, "[Attached image/png: mcp-srv-resource-1]\n[Resource: file:///data.bin (application/octet-stream, 10 bytes)]");
    assert.deepEqual(projected.media.map((item) => item.placeholder), ["mcp-srv-resource-1"]);
  });

  it("degrades forged signatures and broken base64 to references", () => {
    const forgedRaw = Buffer.from("not a png at all");
    const projected = projectCallContent("srv", { content: [
      { type: "image", mimeType: "image/png", data: forgedRaw.toString("base64") },
      { type: "image", mimeType: "image/png", data: "!!not base64!!" },
      { type: "image", mimeType: "image/svg+xml", data: Buffer.from("<svg/>").toString("base64") },
    ] });
    assert.deepEqual(projected.media, []);
    assert.equal(projected.text, [
      `[Image: image/png, ${forgedRaw.length} bytes]`,
      `[Image: image/png]`,
      `[Image: image/svg+xml, 6 bytes]`,
    ].join("\n"));
  });

  it("caps attachments like the agent's tool-media budget", () => {
    const blocks = Array.from({ length: MCP_MEDIA_MAX_ITEMS + 2 }, (_, index) => ({ type: "image", mimeType: "image/png", data: PNG, id: index }));
    const projected = projectBlocks("srv", blocks);
    assert.equal(projected.media.length, MCP_MEDIA_MAX_ITEMS);
    const lines = projected.parts;
    assert.equal(lines.filter((line) => line.startsWith("[Attached")).length, MCP_MEDIA_MAX_ITEMS);
    assert.deepEqual(lines.slice(-2), [`[Image: image/png, ${PNG_RAW.length} bytes]`, `[Image: image/png, ${PNG_RAW.length} bytes]`]);
  });

  it("still clips the model text and structured content survives", () => {
    const big = "x".repeat(MCP_MODEL_BYTES + 100);
    const clipped = projectCallContent("srv", { content: [{ type: "text", text: big }] });
    assert.ok(clipped.text.length < big.length);
    assert.ok(clipped.text.endsWith("…(truncated)"));
    const structured = projectCallContent("srv", { content: [{ type: "text", text: "body" }], structuredContent: { a: 1 } });
    assert.ok(structured.text.includes("Structured content:"));
    assert.equal(projectCallContent("srv", { content: [], isError: true }).ok, false);
  });

  it("projects rich resource reads and leaves plain reads to the legacy dump", () => {
    const rich = projectResourceContents("srv", { contents: [{ uri: "file:///a", text: "plain" }, { uri: "file:///b.png", mimeType: "image/png", blob: PNG }] });
    assert.ok(rich);
    assert.equal(rich!.text, `plain\n[Attached image/png: mcp-srv-resource-1]`);
    assert.deepEqual(rich!.media, [{ mimeType: "image/png", data: PNG, placeholder: "mcp-srv-resource-1" }]);
    assert.equal(projectResourceContents("srv", { contents: [{ uri: "file:///a", text: "plain" }] }), null);
    assert.equal(projectResourceContents("srv", { messages: [{ role: "user", content: { type: "text", text: "p" } }] }), null);
  });

  it("projects rich prompt messages (audio and links stay references)", () => {
    const rich = projectResourceContents("srv", { messages: [
      { role: "user", content: [{ type: "text", text: "hi" }, { type: "resource_link", uri: "file:///doc" }] },
      { role: "assistant", content: { type: "audio", mimeType: "audio/wav", data: WAV } },
    ] });
    assert.ok(rich);
    assert.equal(rich!.text, `hi\n[Resource link: file:///doc]\n[Audio: audio/wav, ${Buffer.from(WAV, "base64").length} bytes]`);
    assert.deepEqual(rich!.media, []);
  });
});

async function withPlugin<T>(run: McpRun, body: (kernel: Context, call: (name: string, input?: Record<string, unknown>) => Promise<Record<string, unknown>>) => Promise<T>): Promise<T> {
  const kernel = Context.create();
  const host = new PluginHost(kernel, [createMcp({ run: () => run })], { enabled: { mcp: false } });
  const artifacts = mkdtempSync(join(tmpdir(), "xueness-mcp-rich-artifacts-"));
  const env = createToolEnv({ cwd: run.cwd, artifactsDir: artifacts });
  try {
    await host.start();
    await host.enable("mcp");
    return await body(kernel, async (name, input = {}) => {
      const tool = kernel.tools.get<ToolDefinition>(name);
      assert.ok(tool, `tool ${name} registered`);
      return await runTool(tool, input, env) as unknown as Record<string, unknown>;
    });
  } finally {
    await host.dispose(); await kernel.dispose(); rmSync(artifacts, { recursive: true, force: true });
  }
}

describe("MCP rich content through the plugin", () => {
  it("a rich tool call returns attachments and labeled references", async () => {
    await withPlugin({ servers: [{ id: "fake", command: process.execPath, args: [SERVER, "--rich"] }], cwd: WS }, async (_kernel, call) => {
      const result = await call("mcp__fake__rich", { text: "hi" }) as unknown as {
        ok: boolean; output: string;
        media?: { mimeType: string; data: string; placeholder: string }[];
        data?: { server: string; media?: { mimeType: string; size: number; placeholder: string; source: string; untrusted: boolean }[] };
      };
      assert.equal(result.ok, true);
      assert.equal(result.output, [
        "rich: hi",
        "[Attached image/png: mcp-fake-image-1]",
        `[Audio: audio/wav, ${Buffer.from(WAV, "base64").length} bytes]`,
        "[Resource link: file:///linked (linked)]",
        "[Attached image/png: mcp-fake-resource-1]",
      ].join("\n"));
      assert.deepEqual(result.media, [
        { mimeType: "image/png", data: PNG, placeholder: "mcp-fake-image-1" },
        { mimeType: "image/png", data: PNG, placeholder: "mcp-fake-resource-1" },
      ]);
      assert.deepEqual(result.data, { server: "fake", media: [
        { mimeType: "image/png", size: PNG_RAW.length, placeholder: "mcp-fake-image-1", source: "fake", untrusted: true },
        { mimeType: "image/png", size: PNG_RAW.length, placeholder: "mcp-fake-resource-1", source: "fake", untrusted: true },
      ] });
      // The attachment lines the agent's tool-media binder matches must be present verbatim.
      assert.ok(result.output.includes("[Attached image/png: mcp-fake-image-1]"));
      assert.ok(result.output.includes("[Attached image/png: mcp-fake-resource-1]"));
    });
  });

  it("plain tool calls keep their exact result shape (no media field)", async () => {
    await withPlugin({ servers: [{ id: "fake", command: process.execPath, args: [SERVER] }], cwd: WS }, async (_kernel, call) => {
      assert.deepEqual(await call("mcp__fake__echo", { text: "hi" }), { ok: true, output: "echo: hi", data: { server: "fake" } });
    });
  });

  it("a rich resource read attaches the blob as media", async () => {
    await withPlugin({ servers: [{ id: "res", command: process.execPath, args: [SERVER, "--resources", "--rich"] }], cwd: WS }, async (_kernel, call) => {
      const plain = await call("mcp__res___xueness_resources_read", { key: "file:///a" }) as unknown as { output: string; media?: unknown };
      assert.equal(plain.output, '{"contents": [{"uri": "file:///a", "text": "contents of file:///a"}]}');
      assert.equal(plain.media, undefined);
      const rich = await call("mcp__res___xueness_resources_read", { key: "file:///shot.png" }) as unknown as {
        output: string; media: { mimeType: string; data: string; placeholder: string }[]; data: { server: string; untrusted: boolean; media: unknown[] };
      };
      assert.equal(rich.output, "[Attached image/png: mcp-res-resource-1]");
      assert.deepEqual(rich.media, [{ mimeType: "image/png", data: PNG, placeholder: "mcp-res-resource-1" }]);
      assert.deepEqual(rich.data.media, [{ mimeType: "image/png", size: PNG_RAW.length, placeholder: "mcp-res-resource-1", source: "res", untrusted: true }]);
    });
  });
});
