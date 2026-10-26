/**
 * H05.01–H05.02 — Desktop harness panel view-model.
 *
 * Pure state machine for the harness side-panel: mount list, selection,
 * verify/bench status chips, and empty/loading/error presentation. No DOM.
 */
export type HarnessPanelStatus = "idle" | "loading" | "ready" | "error";

export interface HarnessPanelItem {
  readonly id: string;
  readonly kind: string;
  readonly version: string;
  readonly source: string;
  readonly contributionCount: number;
}

export interface HarnessPanelModel {
  readonly status: HarnessPanelStatus;
  readonly items: readonly HarnessPanelItem[];
  readonly selectedId: string | null;
  readonly lastError: string | null;
  readonly verifySummary: string | null;
}

export interface HarnessPanelActions {
  setLoading(): HarnessPanelModel;
  setItems(items: readonly HarnessPanelItem[]): HarnessPanelModel;
  select(id: string | null): HarnessPanelModel;
  setError(message: string): HarnessPanelModel;
  setVerifySummary(summary: string | null): HarnessPanelModel;
  clearError(): HarnessPanelModel;
}

const freeze = (model: HarnessPanelModel): HarnessPanelModel => Object.freeze({
  status: model.status,
  items: Object.freeze([...model.items]),
  selectedId: model.selectedId,
  lastError: model.lastError,
  verifySummary: model.verifySummary,
});

export function createHarnessPanelModel(seed: Partial<HarnessPanelModel> = {}): HarnessPanelModel & HarnessPanelActions {
  let state: HarnessPanelModel = freeze({
    status: seed.status ?? "idle",
    items: seed.items ?? [],
    selectedId: seed.selectedId ?? null,
    lastError: seed.lastError ?? null,
    verifySummary: seed.verifySummary ?? null,
  });

  const commit = (next: HarnessPanelModel): HarnessPanelModel => {
    state = freeze(next);
    return state;
  };

  return {
    get status() { return state.status; },
    get items() { return state.items; },
    get selectedId() { return state.selectedId; },
    get lastError() { return state.lastError; },
    get verifySummary() { return state.verifySummary; },
    setLoading() {
      return commit({ ...state, status: "loading", lastError: null });
    },
    setItems(items) {
      const selectedId = items.some((item) => item.id === state.selectedId) ? state.selectedId : (items[0]?.id ?? null);
      return commit({ status: "ready", items, selectedId, lastError: null, verifySummary: state.verifySummary });
    },
    select(id) {
      if (id !== null && !state.items.some((item) => item.id === id)) {
        return commit({ ...state, status: "error", lastError: `unknown harness id: ${id}` });
      }
      return commit({ ...state, selectedId: id, lastError: null });
    },
    setError(message) {
      return commit({ ...state, status: "error", lastError: message });
    },
    setVerifySummary(summary) {
      return commit({ ...state, verifySummary: summary });
    },
    clearError() {
      return commit({ ...state, status: state.items.length ? "ready" : "idle", lastError: null });
    },
  };
}

export function renderHarnessPanelTitle(model: HarnessPanelModel): string {
  if (model.status === "loading") return "Harnesses (loading…)";
  if (model.status === "error") return `Harnesses (error)`;
  if (model.items.length === 0) return "Harnesses (empty)";
  return `Harnesses (${model.items.length})`;
}
