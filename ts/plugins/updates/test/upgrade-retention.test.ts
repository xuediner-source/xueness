import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildRetentionReport, RETENTION_SCHEMA, seedLegacyUserState, snapshotUserState,
} from "../src/upgrade-retention.ts";

describe("upgrade retention (F14.04)", () => {
  it("seeds a legacy user state and snapshots sessions/config/creds/plugins", () => {
    const root = mkdtempSync(join(tmpdir(), "retain-"));
    try {
      seedLegacyUserState(root);
      const snap = snapshotUserState(root);
      assert.equal(snap.sessionsSummary.count, 2);
      assert.equal(snap.sessionsSummary.latestId, "ses-2");
      assert.equal(snap.configSummary.defaultModel, "GLM-5.3");
      assert.equal(snap.credentials.present, true);
      assert.equal(snap.credentials.insideStateRoot, true);
      assert.equal(snap.plugins.filter((p) => p.optional).length, 2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("preserves sessions, credentials location and optional plugin flags across a simulated upgrade", () => {
    const root = mkdtempSync(join(tmpdir(), "retain-up-"));
    try {
      seedLegacyUserState(root);
      const report = buildRetentionReport(root, () => new Date("2026-10-26T00:00:00Z"));
      assert.equal(report.schema, RETENTION_SCHEMA);
      assert.equal(report.round, "F14.04");
      assert.equal(report.pass, true);
      assert.deepEqual(report.gates, {
        sessionsPreserved: true,
        configPreserved: true,
        credentialsInsideState: true,
        optionalPluginsUnchanged: true,
      });
      assert.equal(report.after.configSummary.schemaVersion, 2);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
