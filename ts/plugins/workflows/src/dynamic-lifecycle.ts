/**
 * Cold-resume lifecycle for dynamic runs (C-WFL-05): one explicit status
 * graph and the deterministic recovery decision a host takes after finding a
 * run on disk. The runner lease is an OS `flock`, so a crashed owner's lease
 * dies with its process — a restart either finds a live owner (and must not
 * touch the run) or re-acquires the lease and recovers, never two writers.
 */
export type DynamicColdResume =
  | 'resume_owner'        // a live owner holds the runner lease; use that host
  | 'recover_interrupted' // no live owner: acquire the lease and mark interrupted
  | 'await_answer'        // blocked on a pending question; resolve, then start
  | 'start_queued'        // settled draft/pause; an explicit start re-queues it
  | 'settled';            // terminal; reuse results or amend into a new draft

/**
 * The decision for a run found at rest. `hasLiveOwner` is the runner lease
 * probe: only `running`/`queued` runs can have one, and an owner makes any
 * other host a reader, never a writer.
 */
export function coldResumeDecision(status: string, hasLiveOwner: boolean): DynamicColdResume {
  switch (status) {
    case 'running':
    case 'queued':
      return hasLiveOwner ? 'resume_owner' : 'recover_interrupted';
    case 'awaiting_user':
      return 'await_answer';
    case 'paused':
    case 'interrupted':
    case 'draft':
      return 'start_queued';
    default:
      return 'settled';
  }
}
