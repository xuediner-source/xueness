export type PendingApproval = {
  tool_call_id: string;
  /** Canonical approval capability for newer journal events. Older snapshots omit it. */
  kind?: string;
  name: string;
  subject: string;
  preview: string;
  /** Live one-shot approval, bound to this exact call and subject on the host. */
  granted?: boolean;
  /**
   * The call waits in the running turn (ZCode in-process approval): answering
   * continues that turn, so the client must not start another run.
   */
  waiting?: boolean;
  /** Asked by an alwaysAsk / ask rule or remote exec: approve once only, no "allow for this session". */
  oneShot?: boolean;
  projectRules?: string[];
};
