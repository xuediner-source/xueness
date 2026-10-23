/**
 * Round 8: Read images/PDFs reach the model. Media leaves the tool result for a
 * per-session sidecar, and each request re-attaches it after the tool results
 * (newest first within the budget) or says why it was omitted.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { anthropicMessages, openAiMessages } from "@xueness/providers";
import { loadToolMedia, modelInputOf, modelTools, saveToolMedia, toolMediaExtension, TOOL_CONTRACTS, type AgentContext, type AgentProvider, type ModelRequest, type Row } from "../src/index.ts";
import { call, fixture, schemas } from "./fixtures.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PDF = Buffer.from("%PDF-1.4\n%%EOF\n").toString("base64");
const SID = "a".repeat(32);
const base = mkdtempSync(join(tmpdir(), "xueness-tool-media-"));
after(() => rmSync(base, { recursive: true, force: true }));
const image = (placeholder = "Read image") => ({ mimeType: "image/png", data: PNG, placeholder });
const provider = (caps: string[], pdf = false): AgentProvider => ({ capabilities: new Set(caps), ...pdf ? { acceptsPdfDocuments: true } : {}, async complete() { return {}; } });

async function prepare(stateDir: string, journal: Row[], messages: Row[], chosen: AgentProvider): Promise<ModelRequest> {
  const context = { session: { id: SID, messages: journal }, stateDir, provider: chosen } as unknown as AgentContext;
  return await toolMediaExtension().prepareRequest!(context, { messages, tools: [], options: {} });
}

describe("tool media sidecar", () => {
  it("stores valid media by digest and refuses tampered or invalid items", async () => {
    const stateDir = join(base, "sidecar");
    const refs = await saveToolMedia(stateDir, SID, [image(), { mimeType: "image/png", data: PDF, placeholder: "x" }, { mimeType: "text/plain", data: PNG, placeholder: "x" }, { mimeType: "image/png", data: "%%%", placeholder: "x" }]);
    assert.equal(refs.length, 1);
    assert.deepEqual(Object.keys(refs[0]!), ["sha256", "mimeType", "size", "placeholder"]);
    assert.equal(await loadToolMedia(stateDir, SID, refs[0]!), PNG);
    assert.deepEqual(await saveToolMedia(stateDir, "../escape", [image()]), []);
    writeFileSync(join(stateDir, "tool-media", SID, refs[0]!.sha256), Buffer.from(PDF, "base64"));
    assert.equal(await loadToolMedia(stateDir, SID, refs[0]!), null);
  });

  it("keeps base64 out of the journal and attaches the image to the next request", async () => {
    const stateDir = join(base, "run");
    const seen: Row[][] = [];
    const responses: Row[] = [{ content: "", tool_calls: [call("c1", JSON.stringify({ path: "a.png" }))] }, { content: "done", tool_calls: [] }];
    const scripted: AgentProvider = { capabilities: new Set(["image"]), runtimeProfile: "standard", toolCalling: "native", async complete(messages) {
      seen.push(openAiMessages(messages, { capabilities: new Set(["image"]) })); return structuredClone(responses[seen.length - 1]!);
    } };
    const hooks = { enabled: (id: string) => ["providers", "sessions", "files"].includes(id), toolOwner: (name: string) => name === "read" ? "files" : null, tools: () => schemas, extensions: [toolMediaExtension()] };
    const run = fixture([], [{ ok: true, output: "[Attached image/png: Read image]", data: { path: "a.png" }, media: [image()] }], { provider: scripted, hooks, stateDir });
    try {
      await run.runner.run(run.session, { maxSteps: 4 });
      assert.equal(seen.length, 2);
      const last = seen[1]!.at(-1)!;
      assert.equal(last.role, "user");
      assert.deepEqual(last.content, [{ type: "text", text: "Tool result media: Read image (c1)" }, { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } }]);
      const tool = (run.session.messages as Row[]).find((message) => message.role === "tool")!;
      assert.ok(!String(tool.content).includes(PNG) && !Object.hasOwn((run.session.results as Row).c1 as Row, "media"));
      const [ref] = tool._tool_media as { sha256: string }[];
      assert.ok(existsSync(join(stateDir, "tool-media", SID, ref!.sha256)));
      assert.ok(!readFileSync(join(run.directory, "state", `${SID}.json`), "utf8").includes(PNG));
    } finally { run.close(); }
  });
});

describe("tool media in requests", () => {
  const stateDir = join(base, "requests");
  const journalFor = async (id: string, media: Row[]): Promise<Row> => ({ role: "tool", tool_call_id: id, content: "{}", _tool_media: await saveToolMedia(stateDir, SID, media) });

  it("binds media after the run of tool results for OpenAI and Anthropic", async () => {
    const journal = [await journalFor("c1", [image()]), await journalFor("c2", [image("PDF page 1")])];
    const messages: Row[] = [{ role: "assistant", content: "", tool_calls: [] }, { role: "tool", tool_call_id: "c1", content: "[Attached image/png: Read image]" },
      { role: "tool", tool_call_id: "c2", content: "PDF pages extracted\n\n[Attached image/png: PDF page 1]" }, { role: "user", content: "next" }];
    const request = await prepare(stateDir, journal, messages, provider(["image"]));
    assert.deepEqual(request.messages.map((message) => message.content), ["", messages[1]!.content, messages[2]!.content, "Tool result media: Read image (c1), PDF page 1 (c2)", "next"]);
    const openai = openAiMessages(request.messages, { capabilities: new Set(["image"]) });
    assert.equal((openai[3]!.content as Row[]).filter((part) => part.type === "image_url").length, 2);
    const [, turns] = anthropicMessages(request.messages, { capabilities: new Set(["image"]) });
    assert.deepEqual((turns[0]!.content as Row[]).map((block) => block.type), ["tool_result", "tool_result", "text", "image", "image", "text"]);
    assert.equal(await prepare(stateDir, journal, [messages[0]!, { role: "tool", tool_call_id: "c1", content: "[Old tool result content cleared]" }], provider(["image"])).then((r) => r.messages.length), 2);
  });

  it("says why media is omitted: unsupported model, budget, missing sidecar", async () => {
    const journal = [await journalFor("c1", [image()])];
    const messages: Row[] = [{ role: "tool", tool_call_id: "c1", content: "[Attached image/png: Read image]" }];
    const unsupported = await prepare(stateDir, journal, messages, provider([]));
    assert.deepEqual(unsupported.messages, [{ role: "tool", tool_call_id: "c1", content: "[Attached image/png: Read image]\n[Media omitted from provider request because the selected model does not support image input.]" }]);
    const many = await Promise.all(Array.from({ length: 21 }, (_, index) => journalFor(`m${index}`, [image(`img ${index}`)])));
    const budget = await prepare(stateDir, many, many.map((row, index) => ({ ...row, content: `[Attached image/png: img ${index}]` })), provider(["image"]));
    assert.match(String(budget.messages[0]!.content), /tool media budget exceeded; Read the file again/);
    assert.equal(String(budget.messages[21]!.content).split(", ").length, 20);
    const missing = [{ ...journal[0]!, _tool_media: [{ ...(journal[0]!._tool_media as Row[])[0], sha256: "0".repeat(64) }] }];
    assert.match(String((await prepare(stateDir, missing, messages, provider(["image"]))).messages[0]!.content), /the stored attachment is unavailable/);
  });

  it("sends PDFs only to providers that accept PDF documents", async () => {
    const journal = [await journalFor("p1", [{ mimeType: "application/pdf", data: PDF, placeholder: "a.pdf" }])];
    const messages: Row[] = [{ role: "tool", tool_call_id: "p1", content: "PDF file read: /a.pdf (15 bytes)\n\n[Attached application/pdf: a.pdf]" }];
    const accepted = await prepare(stateDir, journal, messages, provider(["image", "pdf"], true));
    const [, turns] = anthropicMessages(accepted.messages, { capabilities: new Set(["image", "pdf"]) });
    assert.deepEqual((turns[0]!.content as Row[]).at(-1), { type: "document", source: { type: "base64", media_type: "application/pdf", data: PDF } });
    // Chat Completions has no `document` block: a PDF rides as a base64 `file`
    // part, which OpenAI's own families and Gemini's compatible endpoint read.
    const openai = openAiMessages(accepted.messages, { capabilities: new Set(["image", "pdf"]) });
    assert.deepEqual((openai.at(-1)!.content as Row[]).at(-1), { type: "file", file: { filename: "a.pdf", file_data: `data:application/pdf;base64,${PDF}` } });
    const refused = await prepare(stateDir, journal, messages, provider(["image", "pdf"]));
    assert.match(String(refused.messages[0]!.content), /does not support PDF input/);
  });

  it("follows a pending model switch and shows the PDF Read contract only when supported", () => {
    const next = provider(["image", "pdf"], true);
    assert.deepEqual(modelInputOf({ ...provider([]), upcomingProvider: () => next } as AgentProvider), { image: true, pdf: true });
    const tools = [{ type: "function", function: { name: "read", description: "", parameters: {} } }];
    const pdf = modelTools(tools, { pdf: true })[0]!.function as Row, plain = modelTools(tools)[0]!.function as Row;
    const lines = String(pdf.description).split("\n");
    assert.equal(lines[lines.findIndex((line) => line.startsWith("- Reads images")) + 1], '- Reads PDFs via the `pages` parameter (e.g. "1-5", max 20 pages/request; required for PDFs over 10 pages).');
    assert.ok(Object.hasOwn((pdf.parameters as { properties: Row }).properties, "pages") && !Object.hasOwn((plain.parameters as { properties: Row }).properties, "pages"));
    assert.deepEqual(TOOL_CONTRACTS.get("read")!.toInternal({ file_path: "/w/a.pdf", pages: "1-3" }, { root: "/w", accepts: () => true }), { path: "/w/a.pdf", pages: "1-3" });
  });
});
