/** F14.01 entry acceptance: verdicts, anti-extrapolation, completeness, persistence. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  EntryAcceptanceError, assessEntry, buildEntryAcceptanceMatrix, entryPlatformOf,
  loadEntryAcceptance, saveEntryAcceptance, validateEntryAcceptance,
  type BuildEvidence, type EntryAcceptanceMatrix, type KeyLinkEvidence,
} from "../src/entry-acceptance.ts";

const NOW = () => new Date("2026-10-26T10:00:00.000Z");
const PASSING_LINK: KeyLinkEvidence = { name: "entry boots and answers a health request", ok: true, detail: "GET /api/health -> 200" };

function build(ranOn: "windows" | "linux" | "macos", exitCode = 0): BuildEvidence {
  return { command: `bun run build (${ranOn})`, exitCode, artifacts: [`dist/${ranOn}/server.js`], ranOn };
}

describe("entry acceptance", () => {
  it("maps node platforms and rejects unknown ones", () => {
    assert.equal(entryPlatformOf("win32" as NodeJS.Platform), "windows");
    assert.equal(entryPlatformOf("linux" as NodeJS.Platform), "linux");
    assert.equal(entryPlatformOf("darwin" as NodeJS.Platform), "macos");
    assert.equal(entryPlatformOf("freebsd" as NodeJS.Platform), null);
  });

  it("accepts a cell only with a real build and passing key links on the same platform", () => {
    const cell = assessEntry("linux", "server", { build: build("linux"), keyLinks: [PASSING_LINK] }, NOW);
    assert.equal(cell.verdict, "accepted");
    assert.deepEqual(cell.reasons, ["real build and all key links passed on this platform"]);
    assert.equal(cell.recordedAt, "2026-10-26T10:00:00.000Z");
  });

  it("refuses evidence produced on another platform (no extrapolation)", () => {
    const cell = assessEntry("linux", "server", { build: build("windows"), keyLinks: [PASSING_LINK] }, NOW);
    assert.equal(cell.verdict, "not_accepted");
    assert.ok(cell.reasons.some((reason) => reason.includes("cross-platform evidence is not acceptance")));
  });

  it("marks unexecuted probes, missing builds, and failed key links explicitly", () => {
    assert.equal(assessEntry("macos", "desktop", undefined, NOW).verdict, "not_run");
    const noBuild = assessEntry("macos", "desktop", { keyLinks: [PASSING_LINK] }, NOW);
    assert.equal(noBuild.verdict, "not_run");
    assert.ok(noBuild.blocker?.includes("no build evidence"));
    const explicit = assessEntry("macos", "remote", { blocker: "no macOS host allocated this round" }, NOW);
    assert.equal(explicit.verdict, "not_run");
    assert.equal(explicit.blocker, "no macOS host allocated this round");
    const failedLink = assessEntry("windows", "cli", { build: build("windows"), keyLinks: [{ name: "cli prints version", ok: false, detail: "exit 1" }, PASSING_LINK] }, NOW);
    assert.equal(failedLink.verdict, "not_accepted");
    assert.ok(failedLink.reasons.some((reason) => reason.includes("cli prints version")));
    const failedBuild = assessEntry("windows", "cli", { build: build("windows", 2), keyLinks: [PASSING_LINK] }, NOW);
    assert.equal(failedBuild.verdict, "not_accepted");
    assert.ok(failedBuild.reasons.some((reason) => reason.includes("exit code 2")));
    const noArtifacts = assessEntry("windows", "cli", { build: { ...build("windows"), artifacts: [] }, keyLinks: [PASSING_LINK] }, NOW);
    assert.equal(noArtifacts.verdict, "not_accepted");
    const noLinks = assessEntry("windows", "cli", { build: build("windows") }, NOW);
    assert.equal(noLinks.verdict, "not_accepted");
    assert.ok(noLinks.reasons.some((reason) => reason.includes("no key-link evidence")));
  });

  it("builds the full 12-cell matrix with category counts only", () => {
    const matrix = buildEntryAcceptanceMatrix({
      round: "F14.01",
      probes: { "linux:server": { build: build("linux"), keyLinks: [PASSING_LINK] } },
      now: NOW,
    });
    assert.equal(matrix.schema, "xueness.entry-acceptance.v1");
    assert.equal(matrix.cells.length, 12);
    assert.deepEqual(matrix.summary, { accepted: 1, not_accepted: 0, not_run: 11 });
    const server = matrix.cells.find((cell) => cell.platform === "linux" && cell.entry === "server");
    assert.equal(server?.verdict, "accepted");
    const windowsCli = matrix.cells.find((cell) => cell.platform === "windows" && cell.entry === "cli");
    assert.equal(windowsCli?.verdict, "not_run");
    assert.ok(windowsCli?.blocker?.includes("no cli probe executed on windows"));
    assert.deepEqual(Object.keys(matrix).sort(), ["cells", "host", "recordedAt", "round", "schema", "summary"]);
  });

  it("validates structure, verdict pairing, and evidence quality", () => {
    const good = buildEntryAcceptanceMatrix({ round: "F14.01", now: NOW });
    assert.deepEqual(validateEntryAcceptance(good), []);
    const acceptedNoBuild = { ...good, cells: good.cells.map((cell) => cell.entry === "cli" && cell.platform === "linux" ? { ...cell, verdict: "accepted" } : cell) };
    const problems = validateEntryAcceptance(acceptedNoBuild);
    assert.ok(problems.some((problem) => problem.includes("accepted requires a real build command")));
    assert.ok(problems.some((problem) => problem.includes("accepted requires passing key links")));
    const noBlocker = { ...good, cells: good.cells.map((cell) => ({ ...cell, blocker: undefined })) };
    assert.ok(validateEntryAcceptance(noBlocker).some((problem) => problem.includes("not_run requires a blocker")));
    const dropped = { ...good, cells: good.cells.slice(1) };
    assert.ok(validateEntryAcceptance(dropped).some((problem) => problem.includes("missing cell windows:cli")));
    const rated = { ...good, successRate: 0.5 };
    assert.ok(validateEntryAcceptance(rated).some((problem) => problem.includes("successRate")));
    const badVerdict = { ...good, cells: good.cells.map((cell) => ({ ...cell, verdict: "pass" })) };
    assert.ok(validateEntryAcceptance(badVerdict).some((problem) => problem.includes("verdict must be accepted")));
    const wrongHostEvidence = {
      ...good,
      cells: good.cells.map((cell) => cell.entry === "server" && cell.platform === "macos"
        ? { ...cell, verdict: "accepted", build: build("windows"), keyLinks: [PASSING_LINK], reasons: ["smuggled"] }
        : cell),
    };
    assert.ok(validateEntryAcceptance(wrongHostEvidence).some((problem) => problem.includes("accepted but build ran on windows")));
  });

  it("saves and reloads a matrix, and refuses invalid files", () => {
    const state = mkdtempSync(join(tmpdir(), "xueness-entry-"));
    try {
      const matrix = buildEntryAcceptanceMatrix({
        round: "F14.01",
        probes: { "linux:server": { build: build("linux"), keyLinks: [PASSING_LINK] } },
        now: NOW,
      });
      const file = saveEntryAcceptance(matrix, state);
      assert.ok(existsSync(file));
      assert.match(file, /2026-10-26-F14\.01\.json$/);
      const reloaded = loadEntryAcceptance(file);
      assert.equal(reloaded.round, "F14.01");
      assert.deepEqual(reloaded.summary, matrix.summary);
      const tampered = join(state, "tampered.json");
      writeFileSync(tampered, JSON.stringify({ ...matrix, summary: { ...matrix.summary, passRate: 0.9 } }));
      assert.throws(() => loadEntryAcceptance(tampered), EntryAcceptanceError);
      const broken = join(state, "broken.json");
      writeFileSync(broken, "{not json");
      assert.throws(() => loadEntryAcceptance(broken), EntryAcceptanceError);
      const missingCell = join(state, "missing.json");
      const truncated: EntryAcceptanceMatrix = { ...matrix, cells: matrix.cells.slice(0, 11) };
      writeFileSync(missingCell, JSON.stringify(truncated));
      assert.throws(() => loadEntryAcceptance(missingCell), (error: unknown) => {
        assert.ok(error instanceof EntryAcceptanceError);
        assert.ok(error.problems.some((problem) => problem.includes("missing cell")));
        return true;
      });
      assert.throws(() => saveEntryAcceptance(truncated, state), EntryAcceptanceError);
      assert.equal(readFileSync(file, "utf8").endsWith("\n"), true);
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });
});

describe("summary derivation", () => {
  it("rejects summary counts that disagree with the cells", () => {
    // Regression: a hand-edited file could claim more accepted cells than carry evidence.
    const matrix = buildEntryAcceptanceMatrix({ round: "F14.01" });
    assert.equal(matrix.summary.accepted, 0);
    const tampered = { ...matrix, summary: { accepted: 3, not_accepted: 0, not_run: matrix.cells.length } };
    const problems = validateEntryAcceptance(tampered);
    assert.ok(problems.some((problem) => problem.includes("summary.accepted is 3")));
  });
});

