/**
 * Per-session screen/input grant ledger for OS Computer Use (F12.03).
 *
 * Grants are explicit, scoped and time-bounded; `check` is pure so the tools
 * can refuse before touching the adapter. A host that wants durable grants
 * passes a `persist` callback and feeds the saved state back in `restore`.
 */

export type OsCuaScope = "screen" | "input";

export interface GrantRecord {
  sessionId: string;
  scope: OsCuaScope;
  grantedAt: number;
  expiresAt: number;
}

export interface LedgerState {
  grants: GrantRecord[];
}

export interface PermissionLedgerOptions {
  /** Called after every mutation with the serializable ledger state. */
  persist?: (state: LedgerState) => void;
  now?: () => number;
}

export const DEFAULT_GRANT_TTL_MS = 10 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;

export class PermissionLedger {
  private readonly grants = new Map<string, GrantRecord>();
  private readonly persist?: (state: LedgerState) => void;
  private readonly now: () => number;

  constructor(options: PermissionLedgerOptions = {}) {
    this.persist = options.persist;
    this.now = options.now ?? Date.now;
  }

  private emit(): void {
    this.persist?.({ grants: [...this.grants.values()] });
  }

  /** Grant `scope` to `sessionId` for `ttlMs` (clamped to the 24h ceiling). */
  grant(sessionId: string, scope: OsCuaScope, ttlMs: number = DEFAULT_GRANT_TTL_MS, now?: number): GrantRecord {
    const at = now ?? this.now();
    const ttl = Math.min(Math.max(Math.trunc(ttlMs), 1), MAX_TTL_MS);
    const record: GrantRecord = { sessionId, scope, grantedAt: at, expiresAt: at + ttl };
    this.grants.set(`${sessionId}\u0000${scope}`, record);
    this.emit();
    return record;
  }

  /** Revoke one scope, or every scope of the session when `scope` is omitted. */
  revoke(sessionId: string, scope?: OsCuaScope): void {
    if (scope) this.grants.delete(`${sessionId}\u0000${scope}`);
    else for (const key of [...this.grants.keys()]) if (key.startsWith(`${sessionId}\u0000`)) this.grants.delete(key);
    this.emit();
  }

  /** True while an unexpired grant covers `scope` for `sessionId`. */
  check(sessionId: string, scope: OsCuaScope, now?: number): boolean {
    const record = this.grants.get(`${sessionId}\u0000${scope}`);
    if (!record) return false;
    if ((now ?? this.now()) >= record.expiresAt) {
      this.grants.delete(`${sessionId}\u0000${scope}`);
      this.emit();
      return false;
    }
    return true;
  }

  /** Load a previously persisted state, replacing in-memory grants. */
  restore(state: LedgerState, now?: number): void {
    this.grants.clear();
    for (const record of state.grants ?? []) {
      if ((now ?? this.now()) < record.expiresAt) this.grants.set(`${record.sessionId}\u0000${record.scope}`, record);
    }
    this.emit();
  }

  state(): LedgerState {
    return { grants: [...this.grants.values()] };
  }
}
