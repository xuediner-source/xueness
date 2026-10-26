/** H05.01-02 harness panel view-model. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHarnessPanelModel, renderHarnessPanelTitle, type HarnessPanelItem } from "../src/renderer/harness-panel-model.ts";

const item = (id: string): HarnessPanelItem => ({ id, kind: "dir", version: "1", source: `/tmp/${id}`, contributionCount: 1 });

describe("harness panel model (H05.01-02)", () => {
  it("starts idle and transitions loading -> ready with selection", () => {
    const model = createHarnessPanelModel();
    assert.equal(model.status, "idle");
    model.setLoading();
    assert.equal(model.status, "loading");
    model.setItems([item("a"), item("b")]);
    assert.equal(model.status, "ready");
    assert.equal(model.selectedId, "a");
    assert.equal(renderHarnessPanelTitle(model), "Harnesses (2)");
  });

  it("rejects selecting an unknown id", () => {
    const model = createHarnessPanelModel();
    model.setItems([item("a")]);
    model.select("missing");
    assert.equal(model.status, "error");
    assert.match(model.lastError ?? "", /unknown harness id/);
  });

  it("clearError restores ready when items exist", () => {
    const model = createHarnessPanelModel();
    model.setItems([item("a")]);
    model.setError("boom");
    model.clearError();
    assert.equal(model.status, "ready");
    assert.equal(model.lastError, null);
  });

  it("setVerifySummary is independent of selection", () => {
    const model = createHarnessPanelModel();
    model.setItems([item("a")]);
    model.setVerifySummary("2/2 ok");
    assert.equal(model.verifySummary, "2/2 ok");
    model.select("a");
    assert.equal(model.verifySummary, "2/2 ok");
  });
});
