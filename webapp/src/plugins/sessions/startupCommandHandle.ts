/**
 * Startup stand-in for SessionCommandClient. The real client is fetched when the
 * workbench creates this handle, so the command module stays out of the static
 * startup graph. Calls made before it arrives keep the effectiveness captured
 * at the call, and cancel or dispose during that gap never falls through to REST.
 */
import type { SessionCommandClient } from './commandClient';
import { CommandReceiptLedger, type PendingCommandReference } from './commandLedger';
import { requestGet, requestPost } from './sessionHttp';

type CommandModule = typeof import('./commandClient');
let commandModuleLoading: Promise<CommandModule> | undefined;

/** Command admission loads on use. The receipt helpers stay in the startup graph. */
function loadCommandModule(): Promise<CommandModule> {
  return commandModuleLoading ??= import('./commandClient').catch(error => {
    commandModuleLoading = undefined;
    throw error;
  });
}

class StartupCommandHandle {
  private instance: SessionCommandClient | undefined;
  private opening: Promise<SessionCommandClient> | undefined;
  private disposed = false;
  private epoch = 0;

  constructor(private readonly effective: () => boolean, private readonly receiptScope?: string) {
    void this.open().catch(() => undefined);
  }

  private disposedError(): Error {
    return Object.assign(new Error('Command client disposed'), { requestNotSent: true });
  }

  private cancelledError(): Error {
    return Object.assign(new Error('Command cancelled before admission'), { requestNotSent: true });
  }

  private open(): Promise<SessionCommandClient> {
    if (this.instance) return Promise.resolve(this.instance);
    return this.opening ??= loadCommandModule().then(({ SessionCommandClient: CommandClient }) => {
      if (!this.instance) {
        this.instance = new CommandClient({
          isEffective: () => this.effective(), receiptScope: this.receiptScope,
          post: (path, body, signal, beforeSend) => requestPost(path, body, signal, () => this.effective() && (!beforeSend || beforeSend())),
          get: (path, signal) => requestGet(path, signal),
        });
        if (this.disposed) this.instance.dispose();
      }
      return this.instance;
    }).catch(error => {
      this.opening = undefined;
      throw error;
    });
  }

  isEffective(): boolean {
    return this.instance ? this.instance.isEffective() : !this.disposed && this.effective();
  }

  /** Nothing can be in flight before the real client exists. */
  isInFlight(sessionId: string | null, commandId: string): boolean {
    return this.instance?.isInFlight(sessionId, commandId) ?? false;
  }

  pendingCommands(): PendingCommandReference[] {
    if (this.instance) return this.instance.pendingCommands();
    try { return this.receiptScope ? new CommandReceiptLedger(this.receiptScope).pending() : []; } catch { return []; }
  }
  recoveryStorageWarning(): string | null { return this.instance?.recoveryStorageWarning() ?? null; }

  recoveryStorageError(): string | null {
    if (this.instance) return this.instance.recoveryStorageError();
    try { if (this.receiptScope) new CommandReceiptLedger(this.receiptScope).pending(); return null; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  }

  cancelPending(): void {
    this.epoch += 1;
    this.instance?.cancelPending();
  }

  dispose(): void {
    this.disposed = true;
    this.epoch += 1;
    this.instance?.dispose();
  }

  private forward<T>(run: (client: SessionCommandClient) => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(this.disposedError());
    const wasEffective = this.isEffective();
    if (this.instance) return run(this.instance);
    const epoch = this.epoch;
    return this.open().then(client => {
      if (this.disposed) return Promise.reject(this.disposedError());
      if (epoch !== this.epoch || (wasEffective && !client.isEffective())) return Promise.reject(this.cancelledError());
      return run(client);
    });
  }

  query(...args: Parameters<SessionCommandClient['query']>) {
    return this.forward(client => client.query(...args));
  }

  queryCreate(...args: Parameters<SessionCommandClient['queryCreate']>) {
    return this.forward(client => client.queryCreate(...args));
  }

  submitCreate(...args: Parameters<SessionCommandClient['submitCreate']>) {
    return this.forward(client => client.submitCreate(...args));
  }

  submit(...args: Parameters<SessionCommandClient['submit']>) {
    return this.forward(client => client.submit(...args));
  }

  submitEdit(...args: Parameters<SessionCommandClient['submitEdit']>) {
    return this.forward(client => client.submitEdit(...args));
  }

  confirmQueueWithdrawalAsync(...args: Parameters<SessionCommandClient['confirmQueueWithdrawalAsync']>): Promise<boolean> {
    return this.forward(client => client.confirmQueueWithdrawalAsync(...args));
  }

  confirmQueueWithdrawal(...args: Parameters<SessionCommandClient['confirmQueueWithdrawal']>): boolean {
    return this.instance?.confirmQueueWithdrawal(...args) ?? false;
  }

  submitQueue(...args: Parameters<SessionCommandClient['submitQueue']>) {
    return this.forward(client => client.submitQueue(...args));
  }

  submitApproval(...args: Parameters<SessionCommandClient['submitApproval']>) {
    return this.forward(client => client.submitApproval(...args));
  }
}

/** The sessions plugin owns command policy; this adapter reuses the API boundary. */
export function createSessionCommandClient(isEffective: () => boolean, receiptScope: string | undefined = typeof window === 'undefined' ? undefined : JSON.stringify(['local', window.location?.origin ?? 'same-origin'])): SessionCommandClient {
  // Private client fields stay in the lazy module. Callers use the public command API.
  return new StartupCommandHandle(isEffective, receiptScope) as unknown as SessionCommandClient;
}
