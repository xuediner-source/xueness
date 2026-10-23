/** Round 8: request-only tool media survives the sessions media binding's message copies. */
import assert from "node:assert/strict";
import { it } from "node:test";
import { bindToolMedia, openAiMessages } from "@xueness/providers";
import type { Session } from "@xueness/sessions";
import { bindMediaPrompt, type MediaArtifactStore } from "../src/index.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
it("carries tool media onto the bound copy", async () => {
  const synthetic = bindToolMedia({ role: "user", content: "Tool result media: Read image (c1)" }, [{ mimeType: "image/png", data: PNG }]);
  const session = { id: "b".repeat(32), root: "/tmp", messages: [] } as unknown as Session;
  const bound = await bindMediaPrompt({} as MediaArtifactStore, session, [{ role: "system", content: "s" }, synthetic], () => true);
  try {
    assert.notEqual(bound.messages[1], synthetic);
    const converted = openAiMessages(bound.messages, { capabilities: new Set(["image"]) }, bound.media);
    assert.deepEqual((converted[1]!.content as Record<string, unknown>[]).map((part) => part.type), ["text", "image_url"]);
    assert.equal(typeof openAiMessages([{ ...synthetic }], { capabilities: new Set(["image"]) })[0]!.content, "string");
  } finally { await bound.release(); }
});
