/**
 * Network tools on the TS front door: web_fetch, web_search and image_search
 * reach a TS-native run through the network plugin, keep Python's names and
 * approval subjects (the URL or the query), refuse an invalid query before
 * any approval, honour `disallowed` and the plugin switch, and a session that
 * already holds Python-era network tool calls continues on TS.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { Row } from "@xueness/agent";
import type { RunPolicy } from "@xueness/plugin-sessions";
import { SessionStore } from "@xueness/sessions";
import { createAgentService } from "../src/agent-service.ts";

const call = (id: string, name: string, args: Row): Row => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const policy = (permissionMode: string, disallowed: string[] = []): RunPolicy => ({ mode: "build", permissionMode, disallowed, selection: {}, request: {} }) as RunPolicy;
const base = mkdtempSync(join(tmpdir(), "xue-network-srv-"));
after(() => rmSync(base, { recursive: true, force: true }));
const NETWORK = ["web_fetch", "web_search", "image_search"];
const nameOf = (tool: unknown): string => String(((tool as Row).function as Row | undefined)?.name ?? (tool as Row).name);

function setup(name: string) {
  const root = realpathSync(mkdtempSync(join(base, `${name}-ws-`))), state = join(base, `${name}-state`); mkdirSync(state);
  const flags = new Set(["sessions", "providers", "files", "shell", "planning", "network"]);
  return { root, state, flags, store: new SessionStore(state), enabled: (id: string): boolean => flags.has(id) };
}

describe("network plugin in the agent service", () => {
  it("offers the three tools and answers with Python's result JSON without touching the network", async () => {
    const t = setup("run");
    const service = createAgentService({ store: t.store, stateDir: t.state, enabled: t.enabled });
    try {
      for (const name of NETWORK) assert.ok(service.knownTools().includes(name), name);
      const session = await t.store.new("Look something up", t.root);
      assert.equal(service.supports(session, {}), true);
      let turn = 0; const seen: string[][] = [];
      await service.createRunner(session, { complete: async (_messages, tools) => {
        seen.push((tools ?? []).map(nameOf)); turn += 1;
        if (turn === 1) return { tool_calls: [call("c1", "web_search", { query: "   " }), call("c2", "web_fetch", { url: "ftp://example.com/" }), call("c3", "image_search", { query: "" })] };
        return { content: "done" };
      } }, policy("yolo")).run(session);
      for (const name of NETWORK) assert.ok(seen[0]!.includes(name), `${name} in ${JSON.stringify(seen[0])}`);
      assert.equal(session.status, "completed", JSON.stringify(session.error ?? null));
      const results = session.results as Record<string, Row>;
      for (const id of ["c1", "c2", "c3"]) assert.equal(results[id]!.ok, false, JSON.stringify(results[id]));
      assert.match(JSON.stringify(results.c1), /invalid_query|query/u);
      assert.match(JSON.stringify(results.c2), /"error_code\\": \\"invalid_url/u, "non-HTTP schemes are refused before transport");
    } finally { await service.dispose(); }
  });

  it("asks for the exact URL outside yolo and refuses an invalid query before any approval", async () => {
    const t = setup("ask");
    t.flags.delete("sessions");
    const service = createAgentService({ store: t.store, stateDir: t.state, enabled: t.enabled });
    try {
      const session = await t.store.new("Read example.com", t.root);
      let turn = 0;
      await service.createRunner(session, { complete: async () => { turn += 1; return turn === 1 ? { tool_calls: [call("c1", "web_fetch", { url: "https://example.com/a" })] } : { content: "done" }; } }, policy("build")).run(session);
      assert.match(JSON.stringify(session.pending_approvals ?? session.results ?? {}), /https:\/\/example\.com\/a/u, "the approval subject is the URL");
      const empty = await t.store.new("Search nothing", t.root);
      let step = 0;
      await service.createRunner(empty, { complete: async () => { step += 1; return step === 1 ? { tool_calls: [call("d1", "web_search", { query: "" })] } : { content: "ok" }; } }, policy("build")).run(empty);
      assert.equal((empty.results as Record<string, Row>).d1!.ok, false);
      assert.equal(JSON.stringify(empty.pending_approvals ?? []).includes("web_search"), false, "Python validates the query before its Gate");
    } finally { await service.dispose(); }
  });

  it("honours disallowed and the plugin switch", async () => {
    const t = setup("off");
    const service = createAgentService({ store: t.store, stateDir: t.state, enabled: t.enabled });
    try {
      const session = await t.store.new("No web", t.root);
      let turn = 0;
      await service.createRunner(session, { complete: async () => { turn += 1; return turn === 1 ? { tool_calls: [call("c1", "web_fetch", { url: "https://example.com/" })] } : { content: "ok" }; } }, policy("yolo", NETWORK)).run(session);
      assert.equal((session.results as Record<string, Row>).c1!.ok, false);
      t.flags.delete("network");
      await service.refresh();
      const later = await t.store.new("Still no web", t.root);
      const seen: string[][] = [];
      await service.createRunner(later, { complete: async (_messages, tools) => { seen.push((tools ?? []).map(nameOf)); return { content: "ok" }; } }, policy("yolo")).run(later);
      for (const name of NETWORK) assert.equal(seen[0]!.includes(name), false, name);
    } finally { await service.dispose(); }
  });

  it("continues a session that holds Python-era network tool calls", async () => {
    const t = setup("legacy");
    const service = createAgentService({ store: t.store, stateDir: t.state, enabled: t.enabled });
    try {
      const session = await t.store.new("Summarize the page again", t.root);
      const legacy = { ok: true, output: "Example Domain", url: "https://example.com/", status: 200, contentType: "text/html", bytes: 14, truncated: false };
      session.messages = [...session.messages as Row[],
        { role: "assistant", content: "", tool_calls: [call("old1", "web_fetch", { url: "https://example.com/" })] },
        { role: "tool", tool_call_id: "old1", content: JSON.stringify(legacy) },
        { role: "assistant", content: "It is the Example Domain page." },
        { role: "user", content: "Summarize the page again" }];
      session.results = { old1: legacy };
      await service.createRunner(session, { complete: async () => ({ content: "Still the Example Domain page." }) }, policy("yolo")).run(session);
      assert.equal(session.status, "completed", JSON.stringify(session.error ?? null));
    } finally { await service.dispose(); }
  });
});
