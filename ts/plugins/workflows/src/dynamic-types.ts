/** Workflow records wrap the pure script execution contracts. */
import type { JsonSchema } from '@xueness/contracts';
import type { DynamicActor } from '@xueness/agent';
export type { DynamicDiagnostic, DynamicSite, CompiledDynamicWorkflow, DynamicActor, DynamicScriptHost, DynamicEvaluationOptions } from '@xueness/agent';

export type DynamicRunStatus = 'draft' | 'queued' | 'running' | 'paused' | 'awaiting_user' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface DynamicActorRecord extends DynamicActor { sessionId?: string; asks: number }
export interface DynamicNode {
  id: string; siteId: string; ordinal: number; kind: 'ask' | 'read' | 'hole' | 'report';
  inputHash: string; status: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'awaiting_user';
  actorId?: string; actorSeq?: number; result?: unknown; error?: string; question?: string;
}
export interface DynamicEvent { seq: number; type: string; at: string; nodeId?: string; actorId?: string; message?: string; phase?: string }
export interface DynamicWorkflowRun {
  id: string; parentSessionId: string; root: string; name: string; source: string; sourceHash: string;
  status: DynamicRunStatus; maxConcurrency: number; writable: boolean; createdAt: string; updatedAt: string;
  actors: Record<string, DynamicActorRecord>; nodes: Record<string, DynamicNode>; events: DynamicEvent[];
  reports: unknown[]; result?: unknown; error?: string; phase?: string; allowReal: boolean;
  approvedDigest?: string; importedFrom?: string; workspaceFingerprint?: string | null;
}

export interface DynamicAskRequest {
  run: DynamicWorkflowRun; actor: DynamicActorRecord; node: DynamicNode; instructions: string;
  schema?: JsonSchema; signal: AbortSignal; rememberSession(sessionId: string): void;
}
export interface DynamicAskResult { status: 'completed' | 'awaiting_user' | 'paused'; value?: unknown; question?: string }
export interface DynamicWorkflowDriver {
  ask(request: DynamicAskRequest): Promise<DynamicAskResult>;
  read(run: DynamicWorkflowRun, operation: 'files.read' | 'files.glob', args: unknown[], signal: AbortSignal): Promise<unknown>;
}
