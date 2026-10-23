/** Office outputs on the TS front door: native office tools and delivery checks, no Python fallback. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { Row } from "@xueness/agent";
import type { RunPolicy } from "@xueness/plugin-sessions";
import { SessionStore } from "@xueness/sessions";
import { configuredAgentFeatures } from "../src/agent-features.ts";
import { createAgentService } from "../src/agent-service.ts";

const call = (id: string, name: string, args: Row): Row => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const policy: RunPolicy = { mode: "build", permissionMode: "yolo", disallowed: [], selection: {}, request: {} };

it("creates, reads and delivery-checks an Office file without the Python executor", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "xue-office-ws-"))), state = mkdtempSync(join(tmpdir(), "xue-office-state-"));
  const store = new SessionStore(state);
  const on = (office: boolean) => (id: string): boolean => ["sessions", "providers", "files", "shell", "planning"].includes(id) || office && id === "office";
  const session = await store.new("Create report.docx with the quarterly summary", root);
  assert.ok(configuredAgentFeatures(session, {}, { stateDir: state, enabled: on(true), settings: {} }).includes("office.delivery"));
  const service = createAgentService({ store, stateDir: state, enabled: on(true) });
  const offline = createAgentService({ store, stateDir: state, enabled: on(false) });
  try {
    assert.equal(service.supports(session, {}), true, "Office delivery runs on the TS office plugin");
    assert.ok(service.knownTools().includes("office_replace"));
    session.delivery_seeded = true;
    session.delivery_requirements = [{ id: "output_1", label: "目标文件：report.docx", path: "report.docx", contains: ["收入增长"], min_links: 0 }];
    let turn = 0;
    const seenTools: string[][] = [];
    await service.createRunner(session, { complete: async (_messages, tools) => {
      seenTools.push((tools ?? []).map((tool) => String((tool as Row).name ?? ((tool as Row).function as Row | undefined)?.name)));
      turn += 1;
      if (turn === 1) return { tool_calls: [call("c1", "office_create", { path: "report.docx", format: "docx", document: { title: "季度总结", paragraphs: [{ text: "收入增长" }] } })] };
      if (turn === 2) return { tool_calls: [call("c2", "office_read", { path: "report.docx" })] };
      return { content: "Created report.docx.\nEvidence: E1, E2" };
    } }, policy).run(session);
    assert.ok(seenTools[0]!.includes("office_create") && seenTools[0]!.includes("office_read"), JSON.stringify(seenTools[0]));
    assert.equal(session.status, "completed", JSON.stringify(session.completion ?? session.error ?? null));
    assert.ok(existsSync(join(root, "report.docx")));
    const completion = session.completion as Row;
    assert.equal(completion.delivery_status, "passed", "the docx text is extracted by the TS office plugin");
    assert.deepEqual(((completion.delivery_checks as Row).planning as Row).items, [{ id: "output_1", label: "目标文件：report.docx", path: "report.docx", contains: ["收入增长"], min_links: 0, passed: true, missing: [], link_count: 0 }]);
    assert.deepEqual(Object.keys(session._office_read_proofs as Row), ["report.docx"]);
    const saved = await store.load(String(session.id));
    assert.ok(JSON.stringify(saved).includes("收入增长"), "the office_read result is in the journal");
    assert.equal(offline.supports(session, {}), true, "with Office disabled nothing requires office.delivery");
  } finally { await service.dispose(); await offline.dispose(); rmSync(root, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); }
});
