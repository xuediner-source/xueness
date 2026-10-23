/** Tabs own resources; mounting a view never opens or navigates a browser. */
export interface BrowserTab { pageId: string; workspaceId: string; sessionId: string; title: string; url: string; preview?: string; text?: string; error?: string; busy?: boolean; disposed?: boolean; pending?: { action: BrowserAction; approvalId: string; subject: string } }
export interface BrowserAction { action: 'navigate' | 'refresh' | 'inspect' | 'snapshot' | 'click' | 'fill' | 'screenshot'; url?: string; selector?: string; text?: string }
export interface BrowserResult { ok?: boolean; error?: string; url?: string; title?: string; text?: string; tree?: string; imageDataUrl?: string; approvalRequired?: boolean; approvalId?: string; subject?: string }
export interface BrowserApi { remote?: boolean; list(enabled?: () => boolean): Promise<{ tabs: BrowserTab[] }>; open(sessionId: string, enabled?: () => boolean): Promise<BrowserTab>; action(pageId: string, action: BrowserAction & { approvalId?: string }, enabled?: () => boolean): Promise<BrowserResult>; cancel(pageId: string, approval: { approvalId: string; subject: string }, enabled?: () => boolean): Promise<{ cancelled?: boolean; error?: string }>; close(pageId: string): Promise<unknown> }
export function screenshotBlob(value: string): Blob {
  const prefix = 'data:image/png;base64,';
  if (!value.startsWith(prefix) || value.length > prefix.length + 450 * 1024 * 4 / 3) throw new Error('Invalid screenshot');
  const raw = atob(value.slice(prefix.length));
  if (btoa(raw) !== value.slice(prefix.length) || !raw.startsWith('\x89PNG\r\n\x1a\n')) throw new Error('Invalid screenshot');
  return new Blob([Uint8Array.from(raw, char => char.charCodeAt(0))], { type: 'image/png' });
}
export class BrowserSessionRegistry {
  private entries = new Map<string, BrowserTab>();
  private listeners = new Set<() => void>();
  private selection = new Map<string, string>();
  private removed = new Set<string>();
  private workspaceEpochs = new Map<string, number>();
  private closing = new Set<string>();
  private failedClosures = new Set<string>();
  private cleanupInFlight = new Set<string>();
  get cleanupPending() { return this.failedClosures.size > 0; }
  retryCleanup() { for (const id of this.failedClosures) if (!this.cleanupInFlight.has(id)) { this.closing.delete(id); this.closeId(id); } }
  private enabled = false;
  private epoch = 0;
  private restoring?: Promise<void>;
  constructor(private api: BrowserApi, private urls = { create: (blob: Blob) => URL.createObjectURL(blob), revoke: (url: string) => URL.revokeObjectURL(url) }) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private changed() { for (const listener of this.listeners) listener(); }
  tabs(workspace: string) { return [...this.entries.values()].filter(tab => tab.workspaceId === workspace); }
  selected(workspace: string) { return this.tabs(workspace).find(tab => tab.pageId === this.selection.get(workspace)) ?? this.tabs(workspace).at(-1); }
  select(tab: BrowserTab) { this.selection.set(tab.workspaceId, tab.pageId); this.changed(); }
  setEnabled(value: boolean) { if (this.enabled === value) return; this.enabled = value; this.epoch++; this.restoring = undefined; if (!value) for (const tab of [...this.entries.values()]) this.close(tab); }
  restore() { if (!this.enabled) return Promise.resolve(); return this.restoring ??= this.restoreImpl(); }
  refresh() { if (!this.enabled) return Promise.resolve(); return this.restoreImpl(); }
  private async restoreImpl() {
    const epoch = this.epoch;
    const existing = [...this.entries.values()];
    const generations = new Map(this.workspaceEpochs);
    try {
      const response = await this.api.list(() => this.enabled && epoch === this.epoch);
      if (!this.enabled || epoch !== this.epoch) return;
      const live = new Set(response.tabs.map(tab => tab.pageId));
      // This endpoint is the complete bounded tab inventory, not a partial session index.
      for (const tab of existing) if (!live.has(tab.pageId) && this.entries.get(tab.pageId) === tab) this.close(tab);
      for (const tab of response.tabs.slice(0, 8)) {
        if (this.entries.has(tab.pageId) || this.closing.has(tab.pageId)) continue;
        if (this.removed.has(tab.workspaceId) || (generations.get(tab.workspaceId) ?? 0) !== (this.workspaceEpochs.get(tab.workspaceId) ?? 0)) { this.closeId(tab.pageId); continue; }
        this.entries.set(tab.pageId, { ...tab, pending: undefined, preview: undefined, busy: false });
      }
      this.changed();
    } catch { /* A list failure cannot trigger a replacement browser or navigation. */ }
  }
  async create(workspace: string, sessionId: string, remote = false) {
    if (!this.enabled || (remote && !this.api.remote) || !workspace || !sessionId || this.entries.size >= 8) return;
    const epoch = this.epoch, workspaceEpoch = this.workspaceEpochs.get(workspace) ?? 0;
    this.removed.delete(workspace); // Only explicit creation re-adds a removed workspace.
    const tab = await this.api.open(sessionId, () => this.enabled && epoch === this.epoch && workspaceEpoch === (this.workspaceEpochs.get(workspace) ?? 0) && !this.removed.has(workspace));
    if (!this.enabled || epoch !== this.epoch || workspaceEpoch !== (this.workspaceEpochs.get(workspace) ?? 0) || this.removed.has(workspace) || tab.workspaceId !== workspace) { this.closeId(tab.pageId); return; }
    this.entries.set(tab.pageId, tab); this.select(tab); return tab;
  }
  async act(tab: BrowserTab, action: BrowserAction, approved = false) {
    if (!this.enabled || tab.disposed || tab.busy || this.entries.get(tab.pageId) !== tab) return;
    const pending = tab.pending;
    if (approved && (!pending || JSON.stringify(pending.action) !== JSON.stringify(action))) return;
    tab.busy = true; tab.error = ''; tab.pending = undefined; this.changed();
    try {
      const result = await this.api.action(tab.pageId, { ...action, ...(approved ? { approvalId: pending!.approvalId } : {}) }, () => this.enabled && !tab.disposed && this.entries.get(tab.pageId) === tab);
      if (!this.enabled || tab.disposed) return;
      if (result.approvalRequired && result.approvalId && result.subject) tab.pending = { action: { ...action }, approvalId: result.approvalId, subject: result.subject };
      else {
        if (!result.ok) throw new Error(result.error || 'Browser action failed');
        if (result.imageDataUrl) {
          const next = this.urls.create(screenshotBlob(result.imageDataUrl));
          if (tab.preview) this.urls.revoke(tab.preview);
          tab.preview = next;
        } else if (['navigate', 'refresh', 'click', 'fill'].includes(action.action) && tab.preview) { this.urls.revoke(tab.preview); tab.preview = undefined; }
        tab.url = result.url ?? tab.url; tab.title = result.title ?? tab.title;
        tab.text = result.tree ?? result.text ?? '';
      }
    } catch (error) { if (!tab.disposed) tab.error = error instanceof Error ? error.message : String(error); }
    finally { tab.busy = false; this.changed(); }
  }
  async cancel(tab: BrowserTab) {
    if (!this.enabled || tab.disposed || tab.busy || !tab.pending || this.entries.get(tab.pageId) !== tab) return;
    const pending = tab.pending;
    // Disable approval immediately, but do not claim server revocation until acknowledged.
    tab.pending = undefined; tab.busy = true; tab.error = ''; this.changed();
    try {
      const result = await this.api.cancel(tab.pageId, { approvalId: pending.approvalId, subject: pending.subject }, () => this.enabled && !tab.disposed && this.entries.get(tab.pageId) === tab);
      if (!tab.disposed && !result.cancelled) tab.error = result.error || 'Cancellation not confirmed. The action may already have been submitted; cancellation cannot undo its effects.';
    } catch {
      if (!tab.disposed) tab.error = 'Cancellation not confirmed. Do not reuse the old approval. No browser action was retried.';
    } finally { tab.busy = false; this.changed(); }
  }
  private closeId(id: string) {
    if (this.closing.has(id)) return;
    this.closing.add(id); this.cleanupInFlight.add(id);
    void this.api.close(id).then(() => { this.failedClosures.delete(id); })
      .catch(() => { this.failedClosures.add(id); })
      .finally(() => { this.cleanupInFlight.delete(id); this.changed(); });
  }
  close(tab: BrowserTab) { if (tab.disposed) return; tab.disposed = true; tab.pending = undefined; if (tab.preview) this.urls.revoke(tab.preview); tab.preview = undefined; this.entries.delete(tab.pageId); this.closeId(tab.pageId); this.changed(); }
  removeWorkspace(workspace: string) { this.workspaceEpochs.set(workspace, (this.workspaceEpochs.get(workspace) ?? 0) + 1); this.removed.add(workspace); for (const tab of this.tabs(workspace)) this.close(tab); }
}
