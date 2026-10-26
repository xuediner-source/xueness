/** F13.04: unified execution-mode capability announcement, unavailability reasons and degradation. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createProvidersApi } from "../src/http-api.ts";
import { announceExecutionCapabilities, capabilityRows, degradeSelection, EXECUTION_MODES, type ExecutionAnnouncement } from "../src/execution-capabilities.ts";

type Row = Record<string, unknown>;

const saved = { id: "p1", model: "gpt-6", baseUrl: "https://example.invalid/v1" };
const subscription = { id: "s1", model: "m", source: "subscription", subscriptionId: "qoder" };
const pool = { id: "w1", model: "m", source: "subscription", subscriptionId: "workbuddy" };
const allFlags = { subscriptionsAvailable: true, entitlementsConfigured: true };

const codes = (announcement: ExecutionAnnouncement, mode: string): string[] =>
  announcement.modes.find((entry) => entry.mode === mode)?.reasons.map((reason) => reason.code) ?? [];

describe("execution capability announcement", () => {
  it("announces both modes for a saved profile and explains the missing ticket interface", () => {
    const announcement = announceExecutionCapabilities(saved);
    assert.deepEqual(announcement.modes.map((mode) => mode.mode), [...EXECUTION_MODES]);
    assert.deepEqual(announcement.modes.map((mode) => mode.available), [true, true]);
    assert.equal(announcement.effective, "standard");
    assert.equal(announcement.requested, null);
    assert.equal(announcement.fallback, null);
    assert.equal(announcement.source, "saved");
    for (const mode of announcement.modes) assert.equal(mode.ticketPath, false);
    // The missing-ticket reason is attached once, to the always-available mode.
    assert.deepEqual(codes(announcement, "standard"), ["entitlements.not_account_backed"]);
    assert.deepEqual(codes(announcement, "lightweight"), []);
    assert.ok(announcement.notes.length === 1 && announcement.notes[0]!.length > 0);
    assert.equal(new Set(announcement.notes).size, announcement.notes.length); // no duplicate explanations
  });

  it("announces the real ticket path for entitled subscription records", () => {
    const announcement = announceExecutionCapabilities(subscription, allFlags, "lightweight");
    const standard = announcement.modes.find((mode) => mode.mode === "standard")!;
    const lightweight = announcement.modes.find((mode) => mode.mode === "lightweight")!;
    assert.equal(standard.available, true);
    assert.equal(standard.ticketPath, true);
    assert.deepEqual(standard.reasons, []);
    assert.equal(lightweight.available, false);
    assert.equal(lightweight.ticketPath, false);
    assert.deepEqual(codes(announcement, "lightweight"), ["subscriptions.standard_only"]);
    // The requested-but-unsupported mode degrades instead of failing; the model still runs.
    assert.equal(announcement.effective, "standard");
    assert.deepEqual(announcement.fallback, { from: "lightweight", to: "standard", reason: "subscription-backed models run on the standard runtime profile only" });
    assert.match(announcement.notes[0]!, /^the lightweight execution mode is unavailable here/);
  });

  it("states why the ticket path is missing for every unentitled case", () => {
    assert.deepEqual(codes(announceExecutionCapabilities(subscription, { subscriptionsAvailable: true }), "standard"), ["entitlements.not_configured"]);
    assert.deepEqual(codes(announceExecutionCapabilities(subscription, { subscriptionsAvailable: true, entitlementsConfigured: false, pendingEntitlements: ["qoder"] }), "standard"), ["entitlements.pending_external"]);
    assert.deepEqual(codes(announceExecutionCapabilities(subscription, { subscriptionsAvailable: false, entitlementsConfigured: true }), "standard"), ["subscriptions.unavailable"]);
    assert.deepEqual(codes(announceExecutionCapabilities(pool, allFlags), "standard"), ["workbuddy.pool_gateway"]);
    assert.equal(announceExecutionCapabilities(pool, allFlags).modes[0]!.ticketPath, false);
  });

  it("keeps every model running: standard is always available and effective is always an available mode", () => {
    for (const record of [saved, subscription, pool]) {
      for (const flags of [{}, { subscriptionsAvailable: true }, allFlags, { subscriptionsAvailable: false }]) {
        for (const requested of [null, "standard", "lightweight", "turbo"] as (string | null)[]) {
          const announcement = announceExecutionCapabilities(record, flags, requested as unknown as "lightweight");
          assert.equal(announcement.modes[0]!.mode, "standard");
          assert.equal(announcement.modes[0]!.available, true, `${JSON.stringify(record)} ${JSON.stringify(flags)} ${requested}`);
          const effective = announcement.modes.find((mode) => mode.mode === announcement.effective)!;
          assert.equal(effective.available, true); // the run would actually proceed on this mode
          if (requested === null || (requested as string) === "turbo") assert.equal(announcement.effective, "standard");
        }
      }
    }
  });

  it("treats an unknown requested mode as no request and never throws", () => {
    const announcement = announceExecutionCapabilities(saved, {}, "turbo" as unknown as "lightweight");
    assert.equal(announcement.requested, null);
    assert.equal(announcement.effective, "standard");
    assert.equal(announcement.fallback, null);
    const plain = announceExecutionCapabilities(subscription, allFlags, "standard");
    assert.equal(plain.requested, "standard");
    assert.equal(plain.fallback, null);
  });

  it("resolves user selections through degradation with the reason attached", () => {
    const open = announceExecutionCapabilities(saved);
    assert.deepEqual(degradeSelection("lightweight", open), { effective: "lightweight", fallback: null });
    assert.deepEqual(degradeSelection("standard", open), { effective: "standard", fallback: null });
    assert.deepEqual(degradeSelection("turbo", open), { effective: "standard", fallback: null });

    const restricted = announceExecutionCapabilities(subscription, allFlags);
    assert.deepEqual(degradeSelection("standard", restricted), { effective: "standard", fallback: null });
    const degraded = degradeSelection("lightweight", restricted);
    assert.equal(degraded.effective, "standard");
    assert.equal(degraded.fallback!.from, "lightweight");
    assert.equal(degraded.fallback!.to, "standard");
    assert.match(degraded.fallback!.reason, /standard runtime/);
    // A usable announcement without an explicit request keeps its own effective mode.
    assert.deepEqual(degradeSelection(undefined, restricted), { effective: "standard", fallback: null });
  });

  it("flattens announcement rows for display surfaces", () => {
    const announcement = announceExecutionCapabilities(subscription, { subscriptionsAvailable: true }, "lightweight");
    const rows = capabilityRows(announcement);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ["available", "mode", "reasons", "ticketPath"]);
      assert.ok(Array.isArray(row.reasons));
      for (const reason of row.reasons as Row[]) {
        assert.equal(typeof reason.code, "string");
        assert.equal(typeof reason.detail, "string");
      }
    }
    assert.equal(rows.find((row) => row.mode === "lightweight")!.available, false);
  });
});

describe("capability announcement HTTP surface", () => {
  const root = mkdtempSync(join(tmpdir(), "xueness-capabilities-"));
  const stateDir = join(root, "state");

  after(() => { rmSync(root, { recursive: true, force: true }); });

  const api = createProvidersApi({ stateDir, enabled: () => true });
  const subscriptionRecord = { id: "sub1", name: "Qoder · m", model: "m", baseUrl: "https://subscriptions.xueness.invalid", source: "subscription", subscriptionId: "qoder" };
  let flagsSeen = 0;
  const flagged = createProvidersApi({
    stateDir, enabled: () => true,
    capabilityFlags: (record) => { flagsSeen += 1; return record.id === "sub1" ? { subscriptionsAvailable: true, entitlementsConfigured: true } : {}; },
  });
  flagged.store.external = {
    list: (): Row[] => [subscriptionRecord],
    record: (id: string) => (id === "sub1" ? subscriptionRecord : null),
    resolve: () => { throw new Error("not needed here"); },
    supplier: () => null,
  };

  it("saves a profile and announces its capabilities over GET /api/providers/capabilities", async () => {
    const savedReply = await api.dispatch("POST", ["api", "providers"], {}, { id: "cap1", name: "Cap", baseUrl: "https://example.invalid/v1", model: "gpt" });
    assert.equal(savedReply![0], 200);
    const reply = await api.dispatch("GET", ["api", "providers", "capabilities"], { id: "cap1" }, {});
    assert.equal(reply![0], 200);
    const body = reply![1] as Row;
    const announcement = body.announcement as ExecutionAnnouncement;
    assert.equal(announcement.effective, "standard");
    assert.equal(announcement.providerId, "cap1");
    const rows = body.capabilities as Row[];
    assert.equal(rows.length, 2);
    assert.equal(rows.find((row) => row.mode === "standard")!.ticketPath, false);
    assert.ok(announcement.notes.length > 0); // UI gets a sentence explaining the missing ticket interface

    const lightweight = await api.dispatch("GET", ["api", "providers", "capabilities"], { id: "cap1", mode: "lightweight" }, {});
    assert.equal(lightweight![0], 200);
    const lightweightBody = (lightweight![1] as Row).announcement as ExecutionAnnouncement;
    assert.equal(lightweightBody.requested, "lightweight");
    assert.equal(lightweightBody.effective, "lightweight"); // saved profiles support it: no degradation
  });

  it("announces the real ticket path for external subscription records using front-door flags", async () => {
    const reply = await flagged.dispatch("GET", ["api", "providers", "capabilities"], { id: "sub1" }, {});
    assert.equal(reply![0], 200);
    const rows = (reply![1] as Row).capabilities as Row[];
    assert.equal(rows.find((row) => row.mode === "standard")!.ticketPath, true);
    assert.equal(rows.find((row) => row.mode === "lightweight")!.available, false);
    assert.ok(flagsSeen >= 1); // the availability flags really flowed through the seam
  });

  it("answers 404 for unknown profiles and missing selections", async () => {
    assert.deepEqual(await api.dispatch("GET", ["api", "providers", "capabilities"], { id: "nope" }, {}), [404, { error: "provider profile not found" }]);
    assert.deepEqual(await api.dispatch("GET", ["api", "providers", "capabilities"], {}, {}), [404, { error: "provider profile not found" }]);
  });
});
