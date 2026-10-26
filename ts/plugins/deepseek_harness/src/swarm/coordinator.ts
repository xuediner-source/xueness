/** H07.01: multi-worktree swarm coordinator skeleton.
 *
 * Registers N parallel worktree agent slots and hands them out exclusively:
 * a slot is owned by exactly one agent while busy, and acquisition blocks
 * (via an explicit wait queue drained on release) once all N slots are busy.
 * Pure in-memory bookkeeping, no timers — deterministic for unit tests.
 */

export type SlotStatus = "idle" | "busy" | "retired";

export interface WorktreeSlot {
  readonly id: string;
  readonly worktreePath: string;
  status: SlotStatus;
  agentId: string | null;
  claimedAt: number | null;
}

export interface SlotLease {
  readonly slot: WorktreeSlot;
  release(): void;
}

export interface CoordinatorOptions {
  /** Logical clock tick advanced on every mutation; injected for determinism. */
  now?: () => number;
}

/** Thrown when acquiring a slot with a deadline (see {@link SwarmCoordinator.waitForSlot}). */
export class SlotAcquisitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlotAcquisitionError";
  }
}

type Waiter = (error: Error | null) => void;

export class SwarmCoordinator {
  private readonly slots = new Map<string, WorktreeSlot>();
  private readonly waiters: Waiter[] = [];
  private tick = 0;

  constructor(paths: readonly string[] = [], options: CoordinatorOptions = {}) {
    const { now } = { now: defaultClock, ...options };
    this.now = now;
    for (const path of paths) this.registerSlot(path);
  }

  private readonly now: () => number;

  /** Registers a new idle slot for `worktreePath`; ids are sequential and stable. */
  registerSlot(worktreePath: string): WorktreeSlot {
    if (worktreePath.length === 0) throw new Error("worktreePath must be non-empty");
    const id = `wt-${this.slots.size + 1}`;
    const slot: WorktreeSlot = { id, worktreePath, status: "idle", agentId: null, claimedAt: null };
    this.slots.set(id, slot);
    this.tick++;
    return slot;
  }

  registerSlots(worktreePaths: readonly string[]): WorktreeSlot[] {
    return worktreePaths.map((p) => this.registerSlot(p));
  }

  listSlots(): WorktreeSlot[] {
    return [...this.slots.values()];
  }

  /** Capacity N = registered, non-retired slots. */
  get parallelism(): number {
    return this.listSlots().filter((s) => s.status !== "retired").length;
  }

  /** Mutations performed so far; a deterministic stand-in for wall-clock ordering. */
  get mutationCount(): number {
    return this.tick;
  }

  /** Acquires an idle slot for `agentId`, or null when all N are busy. */
  acquire(agentId: string): SlotLease | null {
    if (agentId.length === 0) throw new Error("agentId must be non-empty");
    const slot = this.findIdleSlot();
    if (!slot) return null;
    this.claim(slot, agentId);
    return this.leaseFor(slot);
  }

  /** Acquires synchronously or throws {@link SlotAcquisitionError} when saturated. */
  acquireStrict(agentId: string): SlotLease {
    const lease = this.acquire(agentId);
    if (!lease) throw new SlotAcquisitionError(`all ${this.parallelism} slots busy`);
    return lease;
  }

  /**
   * Queues `agentId` for a slot. Drained FIFO on release; the callback receives
   * the lease or an error when the wait is aborted.
   */
  waitForSlot(agentId: string, onAcquired: (error: Error | null, lease?: SlotLease) => void): void {
    const lease = this.acquire(agentId);
    if (lease) {
      onAcquired(null, lease);
      return;
    }
    this.waiters.push((error) => {
      if (error) {
        onAcquired(error);
        return;
      }
      const granted = this.acquire(agentId);
      if (!granted) {
        onAcquired(new SlotAcquisitionError("slot vanished from under waiter"));
        return;
      }
      onAcquired(null, granted);
    });
  }

  /** Rejects all queued waiters without granting slots. */
  abortWaiters(reason = "swarm shutting down"): number {
    const queued = this.waiters.length;
    for (const fail of this.waiters.splice(0)) fail(new SlotAcquisitionError(reason));
    return queued;
  }

  /** Releases a busy slot by id, regardless of which lease object is used. */
  release(slotId: string): void {
    const slot = this.slots.get(slotId);
    if (!slot) throw new Error(`unknown slot: ${slotId}`);
    if (slot.status === "idle") throw new Error(`slot ${slotId} is not busy`);
    if (slot.status === "retired") throw new Error(`slot ${slotId} is retired`);
    slot.status = "idle";
    slot.agentId = null;
    slot.claimedAt = null;
    this.tick++;
    const next = this.waiters.shift();
    if (next) next(null);
  }

  /** Retires an idle slot so it no longer counts toward parallelism. */
  retireSlot(slotId: string): void {
    const slot = this.slots.get(slotId);
    if (!slot) throw new Error(`unknown slot: ${slotId}`);
    if (slot.status === "busy") throw new Error(`cannot retire busy slot ${slotId}`);
    slot.status = "retired";
    this.tick++;
  }

  snapshot(): Record<string, { path: string; status: SlotStatus; agentId: string | null }> {
    const out: Record<string, { path: string; status: SlotStatus; agentId: string | null }> = {};
    for (const slot of this.slots.values()) {
      out[slot.id] = { path: slot.worktreePath, status: slot.status, agentId: slot.agentId };
    }
    return out;
  }

  private findIdleSlot(): WorktreeSlot | undefined {
    return this.listSlots().find((s) => s.status === "idle");
  }

  private claim(slot: WorktreeSlot, agentId: string): void {
    slot.status = "busy";
    slot.agentId = agentId;
    slot.claimedAt = this.now();
    this.tick++;
  }

  private leaseFor(slot: WorktreeSlot): SlotLease {
    const coordinator = this;
    let released = false;
    return {
      slot,
      release(): void {
        if (released) return;
        released = true;
        coordinator.release(slot.id);
      },
    };
  }
}

function defaultClock(): number {
  return 0;
}
