/** Durable project-memory dream records and the host ports they depend on. */
export type MemoryDreamStatus = "draft" | "running" | "ready" | "applied" | "failed" | "cancelled";
export type MemoryDreamRow = Record<string, unknown>;

export interface MemoryDreamMessage {
  messageId: string;
  role: "user" | "assistant";
  content: string;
  contentHash: string;
}

export interface MemoryDreamSource {
  sessionId: string;
  messages: MemoryDreamMessage[];
  digest: string;
}

export interface MemoryDreamCandidate {
  content: string;
  summary: string;
  sourceSessionIds: string[];
}

export interface MemoryDreamRecord {
  schemaVersion: 1;
  id: string;
  parentSessionId: string;
  root: string;
  name: string;
  status: MemoryDreamStatus;
  sourceSessionIds: string[];
  sources: MemoryDreamSource[];
  baseKeyContent: string;
  baseKeyDigest: string;
  inputDigest: string;
  startDigest: string;
  candidate?: MemoryDreamCandidate;
  usage?: unknown;
  applyDigest?: string;
  appliedKeyDigest?: string;
  provenance?: Record<string, unknown>;
  error?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  settledAt?: string;
  appliedAt?: string;
}

export type MemoryDreamView = Omit<MemoryDreamRecord, "applyDigest"> & { active: boolean; applyDigest: string | null };

export interface MemoryDreamKey {
  content: string;
  digest: string;
}

export interface MemoryDreamOptions {
  stateDir: string;
  enabled(id: string): boolean;
  allowRealHost: boolean;
  owner(sessionId: string): Promise<MemoryDreamRow>;
  listSessions(root: string): Promise<MemoryDreamRow[]>;
  readKey(root: string): Promise<MemoryDreamKey>;
  writeKey(root: string, input: { content: string; digest: string; confirmed: true }): Promise<MemoryDreamKey>;
  synthesize(ownerSessionId: string, prompt: string, signal: AbortSignal): Promise<{ value: unknown; usage: unknown }>;
}

export interface MemoryDreamProposeOptions {
  sourceSessionIds?: string[];
  name?: string;
}

export interface MemoryDreamApproval {
  digest: string;
  confirmed: boolean;
  allowReal: boolean;
}

export interface MemoryDreamApplyApproval {
  digest: string;
  confirmed: boolean;
}
