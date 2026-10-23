/** Resource lifetime is workspace + tab, never the lifetime of a React view. */
export interface TerminalDescriptor { workspaceId: string; tabId: string; sessionId: string; terminalId: string; title: string }
export interface TerminalSurface {
  write(data: Uint8Array | string): void;
  attach(host: HTMLElement): void;
  detach(): void;
  configure(size: number, family: string): void;
  dispose(): void;
}
export interface TerminalApi {
  list(): Promise<{ terminals: { id: string; session_id: string; closed: boolean }[] }>;
  open(sessionId: string, current?: () => boolean): Promise<{ id: string }>;
  poll(id: string, cursor: number, signal: AbortSignal): Promise<{ data: string; cursor: number; truncated: boolean; closed: boolean }>;
  input(id: string, text: string): Promise<unknown>;
  resize(id: string, cols: number, rows: number): Promise<unknown>;
  close(id: string): Promise<unknown>;
  hasPendingCleanup?(): boolean;
  reconcilePending?(): Promise<void>;
}
export interface TerminalResource extends TerminalDescriptor {
  status: 'connecting' | 'running' | 'stopped'; error: string; cursor: number; ownsTerminal: boolean;
  surface?: TerminalSurface; surfacePromise?: Promise<void>; host?: HTMLElement;
  disposed: boolean; controller: AbortController; timer?: ReturnType<typeof setTimeout>; sending: Promise<unknown>;
}
export function nextTerminalBackoff(value: number): number { return Math.min(value * 2, 1000); }
export function terminalResizePayload(cols: number, rows: number): { cols: number; rows: number } | null {
  return Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0 ? { cols, rows } : null;
}
export function decodeTerminalData(data: string): Uint8Array | null {
  try {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error('invalid base64');
    const decoded = atob(data);
    if (btoa(decoded) !== data) throw new Error('non-canonical base64');
    return Uint8Array.from(decoded, c => c.charCodeAt(0));
  } catch (error) { console.error('Failed to decode terminal output:', error); return null; }
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const key = (workspaceId: string, tabId: string) => JSON.stringify([workspaceId, tabId]);
export class TerminalSessionRegistry {
  error = '';
  private entries = new Map<string, TerminalResource>();
  private listeners = new Set<() => void>();
  private closing = new Set<string>();
  private epoch = 0;
  private selection = new Map<string, string>();
  private removedWorkspaces = new Set<string>();
  private workspaceEpochs = new Map<string, number>();
  private enabled = true;
  private restorePromise?: Promise<void>;
  constructor(private api: TerminalApi, private surface: (entry: TerminalResource, input: (text: string) => void, resize: (cols: number, rows: number) => void) => Promise<TerminalSurface>, private storage?: Pick<Storage, 'getItem' | 'setItem'>) {}
  hasPendingCleanup() { return this.api.hasPendingCleanup?.() ?? false; }
  async retryCleanup() {
    try { await this.api.reconcilePending?.(); this.error = ''; }
    catch (error) { this.error = message(error); }
    this.changed();
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private changed() { for (const listener of this.listeners) listener(); }
  tabs(workspaceId: string) { return [...this.entries.values()].filter(entry => entry.workspaceId === workspaceId); }
  selected(workspaceId: string) { const tabs = this.tabs(workspaceId); return tabs.find(t => t.tabId === this.selection.get(workspaceId)) ?? tabs.at(-1); }
  select(entry: TerminalResource) { this.selection.set(entry.workspaceId, entry.tabId); this.changed(); }
  private save() {
    try { this.storage?.setItem('xueness.terminal.tabs.v1', JSON.stringify([...this.entries.values()].map(({ workspaceId, tabId, sessionId, terminalId, title }) => ({ workspaceId, tabId, sessionId, terminalId, title })))); } catch { /* Storage unavailable; live ownership is unaffected. */ }
  }
  private entry(descriptor: TerminalDescriptor): TerminalResource {
    return { ...descriptor, status: 'connecting', error: '', cursor: 0, ownsTerminal: false, disposed: false, controller: new AbortController(), sending: Promise.resolve() };
  }
  setEnabled(value: boolean) {
    if (value === this.enabled) return;
    this.enabled = value;
    if (!value) { this.epoch++; for (const entry of [...this.entries.values()]) this.close(entry); }
    else { void this.restore(); this.changed(); }
  }
  /** Reconcile saved IDs against the broker. Never create a process during restore. */
  restore(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    return this.restorePromise ??= this.restoreImpl();
  }
  private async restoreImpl() {
    const epoch = this.epoch;
    let saved: unknown;
    try { saved = JSON.parse(this.storage?.getItem('xueness.terminal.tabs.v1') || '[]'); } catch { saved = []; }
    if (!Array.isArray(saved)) return;
    const descriptors = saved.filter((d): d is TerminalDescriptor => d && ['workspaceId', 'tabId', 'sessionId', 'terminalId', 'title'].every(k => typeof d[k] === 'string' && d[k].length > 0)).slice(0, 32);
    if (!descriptors.length) return;
    let running: Awaited<ReturnType<TerminalApi['list']>>['terminals'] = [];
    let error = '';
    try { running = (await this.api.list()).terminals; } catch (e) { error = message(e); }
    if (!this.enabled || epoch !== this.epoch) return;
    const seen = new Set([...this.entries.values()].map(e => e.terminalId));
    for (const d of descriptors) {
      if (this.removedWorkspaces.has(d.workspaceId)) {
        if (running.some(t => t.id === d.terminalId && t.session_id === d.sessionId)) this.closeId(d.terminalId);
        continue;
      }
      if (seen.has(d.terminalId) || this.entries.has(key(d.workspaceId, d.tabId))) continue;
      seen.add(d.terminalId);
      const entry = this.entry(d);
      const actual = running.find(t => t.id === d.terminalId && t.session_id === d.sessionId);
      entry.ownsTerminal = Boolean(actual);
      entry.status = actual && !actual.closed ? 'running' : 'stopped';
      entry.error = error;
      this.entries.set(key(d.workspaceId, d.tabId), entry);
    }
    this.save(); this.changed();
  }
  async create(workspaceId: string, sessionId: string, remote = false): Promise<TerminalResource | undefined> {
    if (!this.enabled || remote || !workspaceId || !sessionId) return;
    const epoch = this.epoch;
    const workspaceEpoch = this.workspaceEpochs.get(workspaceId) ?? 0;
    await this.restore();
    // Removal and plugin disable cancel the original intent, even if a later
    // explicit action re-adds this workspace or re-enables the plugin.
    if (!this.enabled || epoch !== this.epoch || workspaceEpoch !== (this.workspaceEpochs.get(workspaceId) ?? 0)) return;
    this.removedWorkspaces.delete(workspaceId);
    const entry = this.entry({ workspaceId, sessionId, tabId: crypto.randomUUID(), terminalId: '', title: `Terminal ${this.tabs(workspaceId).length + 1}` });
    this.entries.set(key(workspaceId, entry.tabId), entry); this.changed();
    try {
      const opened = await this.api.open(sessionId, () => this.enabled && !entry.disposed && epoch === this.epoch && workspaceEpoch === (this.workspaceEpochs.get(workspaceId) ?? 0));
      entry.terminalId = opened.id; entry.ownsTerminal = true;
      if (entry.disposed || !this.enabled) { this.closeId(opened.id); return; }
      entry.status = 'running'; this.save(); this.changed();
      if (entry.host) await this.ensureSurface(entry);
      return entry;
    } catch (error) {
      if (!entry.disposed) { entry.status = 'stopped'; entry.error = message(error); this.changed(); }
      return entry.disposed ? undefined : entry;
    }
  }
  attach(entry: TerminalResource, host: HTMLElement, size = 13, family = 'system') {
    if (entry.disposed || !this.enabled) return;
    entry.host = host;
    void this.ensureSurface(entry).then(() => {
      if (!entry.disposed && entry.host === host) { entry.surface?.attach(host); entry.surface?.configure(size, family); }
    });
  }
  detach(entry: TerminalResource, host: HTMLElement) {
    if (entry.host !== host) return;
    entry.host = undefined; entry.surface?.detach();
  }
  private ensureSurface(entry: TerminalResource): Promise<void> {
    if (entry.surface || entry.status === 'connecting' || entry.disposed) return Promise.resolve();
    return entry.surfacePromise ??= this.surface(entry, text => {
      entry.sending = entry.sending.then(() => {
        if (this.enabled && !entry.disposed && entry.status === 'running' && entry.host) return this.api.input(entry.terminalId, text);
      }).catch(e => { if (!entry.disposed) { entry.error = message(e); this.changed(); } });
    }, (cols, rows) => {
      if (!this.enabled || entry.disposed || !entry.host || entry.status !== 'running' || !terminalResizePayload(cols, rows)) return;
      void this.api.resize(entry.terminalId, Math.max(10, Math.min(500, cols)), Math.max(2, Math.min(200, rows))).catch(e => { if (!entry.disposed) { entry.error = message(e); this.changed(); } });
    }).then(surface => {
      if (entry.disposed || !this.enabled) { surface.dispose(); return; }
      entry.surface = surface;
      if (entry.host) surface.attach(entry.host);
      if (entry.status === 'running') void this.poll(entry, 150);
    }).catch(e => { if (!entry.disposed) { entry.error = message(e); this.changed(); } });
  }
  private async poll(entry: TerminalResource, backoff: number) {
    if (!this.enabled || entry.disposed) return;
    let delay = 150;
    let nextBackoff = 150;
    try {
      const r = await this.api.poll(entry.terminalId, entry.cursor, entry.controller.signal);
      if (entry.disposed || !this.enabled) return;
      const bytes = decodeTerminalData(r.data);
      if (!bytes || !Number.isSafeInteger(r.cursor) || r.cursor < entry.cursor) throw new Error('Invalid terminal output; cursor retained');
      if (r.truncated) entry.surface?.write('\r\n[older output truncated]\r\n');
      entry.surface?.write(bytes); entry.cursor = r.cursor; entry.error = '';
      entry.status = r.closed ? 'stopped' : 'running'; this.changed();
      if (r.closed && bytes.length === 0) return;
    } catch (e) {
      if (entry.disposed || !this.enabled) return;
      entry.error = message(e); this.changed(); delay = backoff; nextBackoff = nextTerminalBackoff(backoff);
    }
    entry.timer = setTimeout(() => { void this.poll(entry, nextBackoff); }, delay);
  }
  private closeId(id: string) {
    if (!id || this.closing.has(id)) return;
    this.closing.add(id);
    void this.api.close(id).catch(e => { this.error = `Terminal close failed (${id.slice(0, 8)}): ${message(e)}`; this.changed(); });
  }
  close(entry: TerminalResource) {
    if (entry.disposed) return;
    entry.disposed = true; entry.controller.abort(); clearTimeout(entry.timer);
    entry.surface?.dispose(); entry.surface = undefined; entry.host = undefined;
    this.entries.delete(key(entry.workspaceId, entry.tabId));
    if (entry.terminalId && entry.ownsTerminal) this.closeId(entry.terminalId);
    this.save(); this.changed();
  }
  /** Call only for an explicit workspace removal, never for a partial session listing. */
  removeWorkspace(workspaceId: string) { this.workspaceEpochs.set(workspaceId, (this.workspaceEpochs.get(workspaceId) ?? 0) + 1); this.removedWorkspaces.add(workspaceId); this.selection.delete(workspaceId); for (const entry of this.tabs(workspaceId)) this.close(entry); }
}
