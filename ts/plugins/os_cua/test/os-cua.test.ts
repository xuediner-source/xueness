import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolEnv } from "@xueness/engine-tools";
import { createOsCua, EvidenceJournal, osCuaTools, PermissionLedger, platformAdapter, unwiredAdapter, type OsAdapterPort, type OsInputAction, type OsWindow } from "../src/index.ts";

const WINDOW: OsWindow = { id: "w1", title: "Report — Editor", app: "editor", bounds: { x: 10, y: 20, w: 800, h: 600 }, focused: true };

/** A fully wired in-memory adapter: isolated interactions, deterministic evidence. */
function fakeAdapter(overrides: Partial<OsAdapterPort> = {}): OsAdapterPort & { inputs: OsInputAction[]; captures: number } {
  const state = { inputs: [] as OsInputAction[], captures: 0 };
  return {
    platform: "darwin", available: true,
    async listWindows() { return [WINDOW]; },
    async captureScreen() { state.captures += 1; return { pngBase64: Buffer.from("fake-png").toString("base64"), width: 1280, height: 800 }; },
    async performInput(action) { state.inputs.push(action); return { applied: true }; },
    ...overrides,
    get inputs() { return state.inputs; },
    get captures() { return state.captures; },
  };
}

function envFor(session = "s1"): ToolEnv {
  return { cwd: ".", roots: [], tracker: undefined as never, artifactsDir: "/tmp", owner: session };
}

function tools(adapter: OsAdapterPort, ledger?: PermissionLedger, journal?: EvidenceJournal) {
  const theLedger = ledger ?? new PermissionLedger();
  return { ledger: theLedger, tools: osCuaTools({ adapter: async () => adapter, ledger: theLedger, journal: journal ?? new EvidenceJournal() }) };
}
const pick = <T extends { name: string }>(list: T[], name: string): T => list.find((tool) => tool.name === name)!;
const grantBoth = (ledger: PermissionLedger, session = "s1"): void => {
  ledger.grant(session, "screen", 60_000);
  ledger.grant(session, "input", 60_000);
};

describe("platform adapter port", () => {
  it("is explicitly unavailable on platforms without a wired adapter", () => {
    const linux = platformAdapter("linux");
    assert.equal(linux.available, false);
    assert.match(linux.unavailableReason ?? "", /no OS computer-use adapter is wired/);
    assert.equal(platformAdapter("freebsd").available, false);
  });
  it("is available only when the probe confirms a wired adapter", () => {
    assert.deepEqual(platformAdapter("darwin", () => true), { platform: "darwin", available: true });
    assert.equal(platformAdapter("darwin", () => false).available, false);
    assert.equal(platformAdapter("win32", () => true).available, true);
    assert.equal(platformAdapter("win32").available, false);
  });
  it("unwiredAdapter refuses every interaction with a stable code", async () => {
    const adapter = unwiredAdapter("linux");
    await assert.rejects(adapter.listWindows(), /unavailable/u);
    await assert.rejects(adapter.captureScreen({}), /unavailable/u);
    await assert.rejects(adapter.performInput({ type: "key", key: "enter" }), /unavailable/u);
  });
});

describe("permission ledger", () => {
  it("grants scoped access that check honors", () => {
    const ledger = new PermissionLedger();
    assert.equal(ledger.check("s1", "screen"), false);
    ledger.grant("s1", "screen", 60_000);
    assert.equal(ledger.check("s1", "screen"), true);
    assert.equal(ledger.check("s1", "input"), false);
    assert.equal(ledger.check("s2", "screen"), false);
  });
  it("expires grants after their ttl", () => {
    let clock = 1000;
    const ledger = new PermissionLedger({ now: () => clock });
    ledger.grant("s1", "input", 5_000);
    clock += 4_999;
    assert.equal(ledger.check("s1", "input"), true);
    clock += 1;
    assert.equal(ledger.check("s1", "input"), false);
    clock += 1;
    assert.equal(ledger.check("s1", "input"), false);
  });
  it("clamps ttl to the 24h ceiling and honors explicit clock overrides", () => {
    const ledger = new PermissionLedger({ now: () => 0 });
    const record = ledger.grant("s1", "screen", 10 ** 12);
    assert.equal(record.expiresAt, 24 * 60 * 60 * 1000);
    assert.equal(ledger.check("s1", "screen", 24 * 60 * 60 * 1000 - 1), true);
  });
  it("revokes one scope or the whole session", () => {
    const ledger = new PermissionLedger();
    grantBoth(ledger);
    ledger.revoke("s1", "screen");
    assert.equal(ledger.check("s1", "screen"), false);
    assert.equal(ledger.check("s1", "input"), true);
    ledger.revoke("s1");
    assert.equal(ledger.check("s1", "input"), false);
  });
  it("persists state and restores only unexpired grants", () => {
    const seen: unknown[] = [];
    const ledger = new PermissionLedger({ now: () => 1000, persist: (state) => seen.push(state) });
    ledger.grant("s1", "screen", 10_000);
    const saved = ledger.state();
    const revived = new PermissionLedger({ now: () => 5000 });
    revived.restore(saved, 5000);
    assert.equal(revived.check("s1", "screen", 5000), true);
    const late = new PermissionLedger({ now: () => 20_000 });
    late.restore(saved, 20_000);
    assert.equal(late.check("s1", "screen", 20_000), false);
    assert.ok(seen.length >= 1);
  });
});

describe("evidence journal", () => {
  it("stamps monotonic sequence numbers and ISO times", () => {
    let clock = 0;
    const journal = new EvidenceJournal({ now: () => clock });
    const first = journal.record({ sessionId: "s1", action: "screenshot" });
    clock += 5;
    const second = journal.record({ sessionId: "s1", action: "input:click", target: "w1", detail: { x: 1 } });
    assert.equal(first.seq, 1);
    assert.equal(second.seq, 2);
    assert.equal(first.at, new Date(0).toISOString());
    assert.equal(journal.entries().length, 2);
    assert.deepEqual(journal.entries("s2"), []);
    assert.deepEqual(journal.entries("s1")[1]!.detail, { x: 1 });
    assert.equal(journal.entries("s1").length, 2);
  });
  it("keeps only the newest entries at capacity", () => {
    const journal = new EvidenceJournal({ maxEntries: 2 });
    journal.record({ sessionId: "s1", action: "a" });
    journal.record({ sessionId: "s1", action: "b" });
    journal.record({ sessionId: "s1", action: "c" });
    assert.deepEqual(journal.entries().map((entry) => entry.action), ["b", "c"]);
  });
});

describe("os_cua tools on a wired adapter", () => {
  it("captures a screenshot with evidence and journal record", async () => {
    const adapter = fakeAdapter();
    const { ledger, tools: list } = tools(adapter);
    grantBoth(ledger);
    const result = await pick(list, "os_screenshot").run({}, envFor());
    assert.equal(result.ok, true);
    assert.equal(result.data!.width, 1280);
    assert.equal(typeof (result.data!.evidence as { seq: number }).seq, "number");
    assert.equal(adapter.captures, 1);
  });
  it("captures a window screenshot via windowId", async () => {
    const seen: string[] = [];
    const adapter = fakeAdapter({ captureScreen: async (options) => { seen.push(options.windowId ?? "full"); return { pngBase64: "aGk=", width: 800, height: 600 }; } });
    const { ledger, tools: list } = tools(adapter);
    grantBoth(ledger);
    const result = await pick(list, "os_screenshot").run({ windowId: "w1" }, envFor());
    assert.equal(result.ok, true);
    assert.deepEqual(seen, ["w1"]);
  });
  it("lists windows with bounded fields", async () => {
    const { ledger, tools: list } = tools(fakeAdapter());
    grantBoth(ledger);
    const result = await pick(list, "os_windows").run({}, envFor());
    assert.equal(result.ok, true);
    assert.equal((result.data!.windows as OsWindow[])[0]!.app, "editor");
  });
  it("performs each one-action input exactly once per call", async () => {
    const adapter = fakeAdapter();
    const { ledger, tools: list } = tools(adapter);
    grantBoth(ledger);
    const tool = pick(list, "os_input");
    const click = await tool.run({ action: { type: "click", x: 5, y: 6, button: "right", windowId: "w1" } }, envFor());
    const scroll = await tool.run({ action: { type: "scroll", x: 5, y: 6, deltaY: -120 } }, envFor());
    const key = await tool.run({ action: { type: "key", key: "enter" } }, envFor());
    const text = await tool.run({ action: { type: "text", text: "hello" } }, envFor());
    const dbl = await tool.run({ action: { type: "double_click", x: 1, y: 1 } }, envFor());
    for (const result of [click, scroll, key, text, dbl]) assert.equal(result.ok, true);
    assert.equal(adapter.inputs.length, 5);
    assert.deepEqual(adapter.inputs[0], { type: "click", x: 5, y: 6, button: "right", windowId: "w1" });
    assert.equal((key.data!.action as Extract<OsInputAction, { type: "key" }>).key, "enter");
  });
  it("refuses input when the adapter did not apply it", async () => {
    const { ledger, tools: list } = tools(fakeAdapter({ performInput: async () => ({ applied: false }) }));
    grantBoth(ledger);
    const result = await pick(list, "os_input").run({ action: { type: "key", key: "space" } }, envFor());
    assert.equal(result.ok, false);
    assert.equal(result.error!.code, "execution_error");
  });
  it("requires the matching grant scope per session", async () => {
    const { ledger, tools: list } = tools(fakeAdapter());
    ledger.grant("s1", "screen", 60_000);
    const input = await pick(list, "os_input").run({ action: { type: "key", key: "enter" } }, envFor());
    assert.equal(input.ok, false);
    assert.equal(input.error!.code, "permission_denied");
    const screenshot = await pick(list, "os_screenshot").run({}, envFor("s2"));
    assert.equal(screenshot.ok, false);
    assert.equal(screenshot.error!.code, "permission_denied");
  });
  it("records unavailable refusals in the journal without acting", async () => {
    const journal = new EvidenceJournal();
    const { ledger, tools: list } = tools(unwiredAdapter("linux"), undefined, journal);
    grantBoth(ledger);
    const result = await pick(list, "os_screenshot").run({}, envFor());
    assert.equal(result.ok, false);
    assert.equal(result.error!.code, "execution_error");
    assert.match(result.error!.message, /unavailable/u);
    assert.deepEqual(journal.entries("s1").map((entry) => entry.detail!.refused), ["unavailable"]);
  });
  it("rejects malformed actions and multi-action input", async () => {
    const { ledger, tools: list } = tools(fakeAdapter());
    grantBoth(ledger);
    const tool = pick(list, "os_input");
    const bad = [
      { action: { type: "click", x: -1, y: 5 } },
      { action: { type: "click", x: 1.5, y: 5 } },
      { action: { type: "scroll", x: 1, y: 1, deltaY: 10 ** 6 } },
      { action: { type: "key", key: "ctrl+enter" } },
      { action: { type: "text", text: "x".repeat(5001) } },
      { action: { type: "teleport", x: 1, y: 1 } },
      { action: "enter" },
      { action: { type: "click", x: 1, y: 1 }, extra: true },
      {},
    ];
    for (const input of bad) {
      const result = await tool.run(input as Record<string, unknown>, envFor());
      assert.equal(result.ok, false);
      assert.equal(result.error!.code, "invalid_argument");
    }
  });
  it("rejects oversized or malformed captures and window lists", async () => {
    const { ledger, tools: list } = tools(fakeAdapter({ captureScreen: async () => ({ pngBase64: "a".repeat(1_500_001), width: 1, height: 1 }) }));
    grantBoth(ledger);
    const shot = await pick(list, "os_screenshot").run({}, envFor());
    assert.equal(shot.ok, false);
    assert.equal(shot.error!.code, "invalid_argument");
    const { ledger: l2, tools: t2 } = tools(fakeAdapter({ listWindows: async () => "nope" as never }));
    grantBoth(l2);
    assert.equal((await pick(t2, "os_windows").run({}, envFor())).error!.code, "invalid_argument");
  });
  it("declares manifest-agreeing tool metadata", () => {
    const { tools: list } = tools(fakeAdapter());
    assert.deepEqual(list.map((tool) => [tool.name, tool.gate, tool.mutating]), [["os_screenshot", "exec", false], ["os_windows", "exec", false], ["os_input", "exec", true]]);
  });
});

describe("createOsCua", () => {
  it("bundles the manifest and a plugin named os_cua", () => {
    const bundled = createOsCua({ stateDir: "." });
    assert.equal((bundled.manifest as { id: string }).id, "os_cua");
    assert.equal((bundled.plugin as { name: string }).name, "os_cua");
    assert.equal((bundled.manifest as { tools: unknown[] }).tools.length, 3);
  });
  it("wires no adapter by default, so a granted session still hears unavailable", async () => {
    const bundled = createOsCua({ stateDir: ".", grants: { grants: [{ sessionId: "s1", scope: "screen", grantedAt: 0, expiresAt: Date.now() + 60_000 }] } });
    const registered: { name: string; run: (input: Record<string, unknown>, env: ToolEnv) => Promise<{ ok: boolean; error?: { code: string } }> }[] = [];
    (bundled.plugin as unknown as { apply: (ctx: unknown) => void }).apply({ tool: (tool: never) => registered.push(tool) });
    const screenshot = pick(registered, "os_screenshot");
    const result = await screenshot.run({}, envFor());
    assert.equal(result.ok, false);
    assert.equal(result.error!.code, "execution_error");
    assert.match(String((result.error as { code: string; message?: string }).message ?? result.error!.code), /unavailable|execution_error/u);
  });
  it("restores persisted grants for a host-wired adapter", async () => {
    const bundled = createOsCua({ stateDir: ".", adapter: fakeAdapter(), grants: { grants: [{ sessionId: "s1", scope: "screen", grantedAt: 0, expiresAt: Date.now() + 60_000 }] } });
    const registered: { name: string; run: (input: Record<string, unknown>, env: ToolEnv) => Promise<{ ok: boolean }> }[] = [];
    (bundled.plugin as unknown as { apply: (ctx: unknown) => void }).apply({ tool: (tool: never) => registered.push(tool) });
    assert.equal((await pick(registered, "os_screenshot").run({}, envFor())).ok, true);
  });
});
