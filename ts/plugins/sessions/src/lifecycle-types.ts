import type { AgentProvider, AgentRunner, RunOptions } from "@xueness/agent";
import type { Session, SessionStore } from "@xueness/sessions";
import type { ApprovalBuckets, PublicSessionOptions } from "./public-session.ts";
import type { LiveApprovalPort } from "./live-approvals.ts";
export type Row = Record<string, unknown>;
export interface RuntimeSelection { providerId?: string | null; model?: string | null; reasoningEffort?: string | null; runtimeProfile?: string | null; }
export interface RunPolicy {
  mode: "plan" | "build";
  permissionMode: "build" | "edit" | "yolo" | "plan" | "guarded";
  disallowed: string[];
  browser?: boolean;
  selection: RuntimeSelection;
  request: Row;
}
export interface LifecycleOptions extends PublicSessionOptions {
  store: SessionStore;
  stateDir: string;
  allowReal: boolean;
  running: Set<string>;
  approvals: ApprovalBuckets;
  /** Approvals a running call waits for in process; answered without the run lease. */
  liveApprovals?: LiveApprovalPort;
  activeContext: Map<string, Row>;
  knownTools?: () => readonly string[];
  settings?: () => Row;
  resolveProvider(selection: RuntimeSelection, sid: string): AgentProvider;
  createRunner(session: Session, provider: AgentProvider, policy: RunPolicy): Pick<AgentRunner, "run" | "cancel">;
  /** Optional product plugins must supply their complete hooks before selection. */
  supports?: (session: Session, request: Row) => boolean;
  appendUserTurn?: (session: Session, text: string, request: Row, command?: { id: string; fingerprint: string }) => Promise<Session>;
  answerSession?: (session: Session, answer: string) => Promise<Session>;
  cancelTasks?: (sid: string) => Row[];
  tasks?: (sid: string) => Row[];
  runQueue?: (session: Session, policy: RunPolicy, run: (s: Session) => Promise<Session>) => Promise<Session>;
  /** Gate admission executes before any journal/model/tool mutation. */
  beforeRun?: (session: Session, request: Row) => Promise<[number, unknown] | null>;
  /** `_remote_connection(ctx, id, digest)`: throws a ValueError while the saved SSH target is disabled or changed. */
  checkRemote?: (remote: Row) => unknown;
  afterRun?: (session: Session) => Promise<void>;
}
export type LifecycleRunOptions = RunOptions;
