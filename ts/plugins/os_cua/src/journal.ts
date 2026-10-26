/**
 * Evidence journal for OS Computer Use (F12.03): every interaction attempt —
 * capture, listing, input — is recorded with a monotonic sequence number and
 * timestamp so a run can prove what the adapter was asked to do and when.
 */

export interface JournalEntry {
  seq: number;
  at: string;
  sessionId: string;
  action: string;
  target?: string;
  detail?: Record<string, unknown>;
}

export interface EvidenceJournalOptions {
  maxEntries?: number;
  now?: () => number;
}

export const DEFAULT_MAX_ENTRIES = 200;

export class EvidenceJournal {
  private readonly entries_log: JournalEntry[] = [];
  private nextSeq = 1;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: EvidenceJournalOptions = {}) {
    this.maxEntries = Math.max(1, Math.trunc(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
    this.now = options.now ?? Date.now;
  }

  /** Record one interaction; the oldest entry is dropped at capacity. */
  record(entry: { sessionId: string; action: string; target?: string; detail?: Record<string, unknown> }): { seq: number; at: string } {
    const stamped = { seq: this.nextSeq++, at: new Date(this.now()).toISOString(), ...entry } as JournalEntry;
    this.entries_log.push(stamped);
    if (this.entries_log.length > this.maxEntries) this.entries_log.splice(0, this.entries_log.length - this.maxEntries);
    return { seq: stamped.seq, at: stamped.at };
  }

  /** All entries, or one session's, oldest first. */
  entries(sessionId?: string): JournalEntry[] {
    const all = [...this.entries_log];
    return sessionId === undefined ? all : all.filter((entry) => entry.sessionId === sessionId);
  }

  get size(): number {
    return this.entries_log.length;
  }
}
