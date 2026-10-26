/** Round F14.05: discrepancy-ledger closure and delivery-manifest consistency gate. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildClosureReport,
  checkManifest,
  checksums,
  closeLedger,
  evidenceExists,
  evidencePath,
  splitEvidence,
  verdictFromStatus,
  type LedgerItem,
} from "../delivery-closure.ts";

describe("verdictFromStatus", () => {
  it("counts only explicit closure statuses as complete", () => {
    assert.equal(verdictFromStatus("closed_f02_04"), "complete");
    assert.equal(verdictFromStatus("aligned"), "complete");
  });
  it("never counts pending/open/unknown as complete", () => {
    assert.equal(verdictFromStatus("core_aligned_f01_03_pending_f03_02"), "external_pending");
    assert.equal(verdictFromStatus("open_for_alignment"), "open");
    assert.equal(verdictFromStatus("external_wait_on_upstream_release"), "external_pending");
    assert.equal(verdictFromStatus(""), "open");
    assert.equal(verdictFromStatus(undefined), "open");
    assert.equal(verdictFromStatus("some_unknown_words"), "open");
  });
});

describe("evidence references", () => {
  it("splits on fullwidth/ASCII semicolons and the source ` + ` test joiner", () => {
    assert.deepEqual(splitEvidence("a.md；b.md ; c.md；"), ["a.md", "b.md", "c.md"]);
    assert.deepEqual(splitEvidence("src/x.ts + test/x.test.ts"), ["src/x.ts", "test/x.test.ts"]);
    assert.deepEqual(splitEvidence(undefined), []);
  });
  it("strips path:line anchors but keeps the path intact", () => {
    assert.equal(evidencePath("ts/packages/agent/src/x.ts:12"), "ts/packages/agent/src/x.ts");
    assert.equal(evidencePath("ts/packages/agent/src/x.ts:12:34"), "ts/packages/agent/src/x.ts");
    assert.equal(evidencePath("F02.04-result.md"), "F02.04-result.md");
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "xueness-closure-"));
  mkdirSync(join(root, "docs", "audits", "20261024"), { recursive: true });
  mkdirSync(join(root, "ts", "packages", "agent", "src"), { recursive: true });
  writeFileSync(join(root, "docs", "audits", "20261024", "models-runtime-evidence.md"), "evidence");
  writeFileSync(join(root, "F01.04-result.md"), "result");
  writeFileSync(join(root, "ts", "packages", "agent", "src", "execution-selection.ts"), "src");
  return root;
}

describe("closeLedger", () => {
  it("flags complete items whose evidence cannot be located", () => {
    const root = fixtureRoot();
    try {
      const ledgerDir = join(root, "docs", "audits", "20261024");
      const items: LedgerItem[] = [
        { id: "G02", status: "closed_f01_05", evidence: "models-runtime-evidence.md；F01.04-result.md" },
        { id: "G03", status: "core_aligned_f01_03_pending_f03_02", evidence: "F01.03-result.md" },
        { id: "G09", status: "open_for_alignment", evidence: "missing-evidence.md" },
      ];
      const { checks, violations } = closeLedger(items, root, ledgerDir);
      assert.deepEqual(checks.map((check) => check.verdict), ["complete", "external_pending", "open"]);
      assert.equal(checks[0]!.countedWithoutEvidence, false);
      // G03 evidence file does not exist, but a pending item is never counted complete, so no violation from it.
      assert.deepEqual(checks.map((check) => check.missingEvidence.length), [0, 1, 1]);
      assert.deepEqual(violations, []);
      const bad = closeLedger([{ id: "G99", status: "closed_f02_04", evidence: "nowhere.md" }], root, ledgerDir);
      assert.equal(bad.checks[0]!.countedWithoutEvidence, true);
      assert.equal(bad.violations.length, 1);
      assert.match(bad.violations[0]!, /^G99:/);
      const noRefs = closeLedger([{ id: "G98", status: "aligned" }], root, ledgerDir);
      assert.equal(noRefs.checks[0]!.countedWithoutEvidence, true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("resolves root-relative refs and refs anchored next to the ledger", () => {
    const root = fixtureRoot();
    try {
      const { checks } = closeLedger(
        [{ id: "R01", status: "closed_f02_04", evidence: "ts/packages/agent/src/execution-selection.ts:9；models-runtime-evidence.md" }],
        root, join(root, "docs", "audits", "20261024"),
      );
      assert.deepEqual(checks[0]!.missingEvidence, []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("resolves the test-file half of a `src + test` evidence pair via the source directory", () => {
    const root = fixtureRoot();
    try {
      mkdirSync(join(root, "ts", "packages", "tool-bridge", "test"), { recursive: true });
      mkdirSync(join(root, "ts", "packages", "tool-bridge", "src"), { recursive: true });
      writeFileSync(join(root, "ts", "packages", "tool-bridge", "src", "tool-deadline.ts"), "src");
      writeFileSync(join(root, "ts", "packages", "tool-bridge", "test", "tool-deadline.test.ts"), "test");
      const { checks, violations } = closeLedger(
        [{ id: "G04", status: "closed_f02_05", evidence: "ts/packages/tool-bridge/src/tool-deadline.ts + test/tool-deadline.test.ts" }],
        root, join(root, "docs", "audits", "20261024"),
      );
      assert.deepEqual(checks[0]!.missingEvidence, []);
      assert.equal(checks[0]!.countedWithoutEvidence, false);
      assert.deepEqual(violations, []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("checkManifest", () => {
  it("reports consistency and drift between tree and delivery manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "xueness-closure-manifest-"));
    try {
      writeFileSync(join(root, "a.txt"), "a");
      const manifest = {
        exclusions: ["node_modules", "complete-project-manifest.json", "delivery-closure-report.json"],
        files: [{ path: "a.txt", sizeBytes: 1, sha256: "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb" }],
      };
      writeFileSync(join(root, "complete-project-manifest.json"), JSON.stringify(manifest));
      assert.equal(checkManifest(root).consistent, true);
      writeFileSync(join(root, "b.txt"), "b");
      const drift = checkManifest(root);
      assert.equal(drift.consistent, false);
      assert.deepEqual(drift.added, ["b.txt"]);
      assert.deepEqual([drift.changed, drift.removed], [[], []]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("buildClosureReport", () => {
  it("assembles gates, remaining-external list and checksums from the real inputs", () => {
    const root = fixtureRoot();
    try {
      writeFileSync(join(root, "docs", "audits", "20261024", "gap-register.json"), JSON.stringify({
        schema: "xueness.engine-gap-register.v1",
        items: [
          { id: "G01", rounds: "F02", status: "closed_f02_04", evidence: "models-runtime-evidence.md" },
          { id: "G03", rounds: "F01 / F13", status: "core_aligned_f01_03_pending_f03_02", evidence: "F01.03-result.md" },
          { id: "G05", rounds: "F05", status: "open_for_alignment", evidence: "models-runtime-evidence.md" },
        ],
      }));
      writeFileSync(join(root, "complete-project-manifest.json"), JSON.stringify({
        exclusions: ["node_modules", "complete-project-manifest.json", "delivery-closure-report.json"],
        files: [{ path: "docs/audits/20261024/models-runtime-evidence.md", sizeBytes: 8, sha256: "x" }],
      }));
      writeFileSync(join(root, "docs", "audits", "20261024", "public-capability-contracts.json"), "{}");
      writeFileSync(join(root, "docs", "audits", "20261024", "upstream-engine-delta.json"), "{}");
      writeFileSync(join(root, "docs", "ZCODE-FULL-ALIGNMENT-TASKS-20261024.json"), "{}");
      writeFileSync(join(root, "ts", "package.json"), "{}");
      writeFileSync(join(root, "README.md"), "readme");
      const report = buildClosureReport(root, new Date("2026-10-26T00:00:00Z"));
      assert.equal(report.schema, "xueness.delivery-closure.v1");
      assert.equal(report.task, "F14.05");
      assert.deepEqual(
        [report.ledger.total, report.ledger.complete, report.ledger.externalPending, report.ledger.open],
        [3, 1, 1, 1],
      );
      assert.deepEqual(report.remainingExternal.map((item) => item.id), ["G03", "G05"]);
      assert.match(report.remainingExternal[0]!.status, /\[external_pending\]$/);
      assert.equal(report.gates.ledgerEvidence, true);
      assert.equal(report.gates.noExternalCountedComplete, true);
      assert.equal(report.gates.manifestConsistency, false); // tree carries files the fixture manifest omits
      assert.equal(report.pass, false);
      assert.equal(report.checksums["README.md"], "711a6108ba2ce6ca93dd47d6817f2361db10d8ab6eec89460b2dfc2c325efabe");
      const direct = checksums(root, ["README.md"]);
      assert.equal(direct["README.md"], report.checksums["README.md"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("passes end to end when the manifest matches the tree and evidence resolves", () => {
    const root = fixtureRoot();
    try {
      const sha = (content: string): string => createHash("sha256").update(content).digest("hex");
      const contents: Record<string, string> = {
        "F01.04-result.md": "result",
        "README.md": "readme",
        "docs/ZCODE-FULL-ALIGNMENT-TASKS-20261024.json": "{}",
        "docs/audits/20261024/gap-register.json": JSON.stringify({
          items: [{ id: "G01", rounds: "F02", status: "closed_f02_04", evidence: "models-runtime-evidence.md" }],
        }),
        "docs/audits/20261024/models-runtime-evidence.md": "evidence",
        "docs/audits/20261024/public-capability-contracts.json": "{}",
        "docs/audits/20261024/upstream-engine-delta.json": "{}",
        "ts/package.json": "{}",
        "ts/packages/agent/src/execution-selection.ts": "src",
      };
      for (const [rel, content] of Object.entries(contents)) writeFileSync(join(root, rel), content);
      writeFileSync(join(root, "complete-project-manifest.json"), JSON.stringify({
        exclusions: ["node_modules", "complete-project-manifest.json", "delivery-closure-report.json"],
        files: Object.entries(contents)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([path, content]) => ({ path, sizeBytes: Buffer.byteLength(content), sha256: sha(content) })),
      }));
      const report = buildClosureReport(root);
      assert.deepEqual(report.gates, { ledgerEvidence: true, manifestConsistency: true, noExternalCountedComplete: true });
      assert.equal(report.pass, true);
      assert.deepEqual(report.remainingExternal, []);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("evidence must be a file", () => {
  it("does not accept a directory as evidence of closure", () => {
    // Regression: existsSync() is true for directories, so `ts/packages/agent/src`
    // counted as locateable evidence for a complete item.
    const root = fixtureRoot();
    try {
      const ledgerDir = join(root, "docs", "audits", "20261024");
      assert.equal(evidenceExists("ts/packages/agent/src", root, ledgerDir), false);
      assert.equal(evidenceExists("ts/packages/agent/src/execution-selection.ts", root, ledgerDir), true);
      const { violations } = closeLedger([{ id: "X", status: "closed_f01", evidence: "ts/packages/agent/src" }], root, ledgerDir);
      assert.equal(violations.length, 1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

