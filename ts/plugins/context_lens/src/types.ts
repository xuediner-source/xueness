export type Row = Record<string, unknown>;
export type Category = 'system' | 'tools' | 'user' | 'injected' | 'assistant' | 'reasoning' | 'tool';
export interface ContextItem {
  id: string; category: Category; label: string; tokens: number; characters: number;
  text: string; truncated: boolean;
}
export interface RequestRecord {
  step: number; at: string; model: string; items: Omit<ContextItem, 'text'>[];
  composition: Record<Category, number>; estimatedTokens: number;
}
export interface UsageRecord {
  step: number; at: string; model: string; input: number | null; output: number | null;
  cached: number | null; reasoning: number | null;
}
export interface ToolRecord {
  id: string; name: string; owner: string | null; subject: string; ok: boolean | null;
  seconds: number | null; executionMs: number | null; exitCode: number | null; error: string;
}
export interface FileRecord { path: string; reads: number; writes: number; searches: number; added: number; removed: number; }
export interface LensStatistics {
  steps: number; humanInputs: number; answers: number; injections: number; compactions: number; masked: number;
  timing: { samples: number; waitingMs: number; thinkingMs: number; generatingMs: number; otherMs: number;
    toolElapsedMs: number; toolSamples: number; speedTokens: number; speedMs: number;
    spans: { step: number; waitingMs: number; thinkingMs: number; generatingMs: number; otherMs: number }[]; };
}
export interface ContextLensView {
  schema: 'xueness.context-lens.v1'; id: string; title: string; status: string;
  current: { items: ContextItem[]; composition: Record<Category, number>; estimatedTokens: number; contextWindow: number | null; inputBudget: number | null; hostEstimatedTokens: number | null; };
  requests: UsageRecord[]; captures: RequestRecord[];
  totals: { input: number; output: number; cached: number; reported: number; unknown: number; };
  tools: ToolRecord[]; files: FileRecord[];
  events: { kind: string; at: string; detail: string }[];
  family: { id: string; title: string; status: string; relation: string }[];
  statistics: LensStatistics;
  toolCounts: { name: string; count: number }[];
  limits: { capturedRequests: number; requestLimit: number; clippedItems: number; toolCount: number; };
}

export interface FileOpRecord {
  seq: number
  /** The op's file; for a pathless search the searched PATTERN (`pattern: true`). */
  path: string
  kind: 'read' | 'write' | 'search'
  tool: string
  time?: number
  err: boolean
  added: number
  removed: number
  /** The searched pattern, with the include filter when one narrowed the call. */
  detail?: string
  /** Meta-attributed search op only: matched lines the result reported for this file. */
  hits?: number
  /** Read ops only: the exact 1-based window the result meta reported, else the `limit`-argument estimate (`est: true`). */
  read?: { start: number; count: number } | { count: number; est: true }
  /** Nested Code-Mode op only: the run_code result node the op ran under (the locate target). */
  parent?: number
  /** Nested Code-Mode op only: the run_code program's model-authored description. */
  program?: string
  /** The searched-pattern marker: `path` is a pattern, not a file — display must not relativize it. */
  pattern?: true
  /** Client-joined archive stamp (see the type note); absent on the wire. */
  gone?: number
}
