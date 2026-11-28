/** Native dynamic-script contracts. Product execution stays behind these ports. */
import type ts from 'typescript';
import type { JsonSchema } from '@xueness/contracts';

export interface DynamicActorPersona {
  system?: string;
  role?: string;
  model?: string;
}
export interface DynamicTrajectoryEntry {
  index: number;
  type: 'user' | 'assistant' | 'tool_call' | 'tool_result';
  role?: string;
  tool?: string;
  status?: 'ok' | 'error';
  text: string;
}
export interface DynamicTrajectoryFilter {
  last?: number;
  tools?: string[];
  types?: Array<'user' | 'assistant' | 'tool_call' | 'tool_result'>;
  status?: 'ok' | 'error';
}
export interface DynamicDiagnostic { code: string; message: string; line: number; column: number }
export interface DynamicSite {
  id: string;
  kind: 'actor' | 'ask' | 'read' | 'report' | 'hole' | 'phase' | 'trajectory';
  start: number;
  line: number;
  column: number;
  name?: string;
}
export interface CompiledDynamicWorkflow {
  source: string;
  sourceFile: ts.SourceFile;
  diagnostics: DynamicDiagnostic[];
  sites: DynamicSite[];
  /** Type schemas for ask<T> and callable actor<T>, keyed by the CallExpression start coordinate. */
  schemas: Map<number, JsonSchema>;
}
export interface DynamicActor { id: string; name?: string; persona: DynamicActorPersona }
export interface DynamicScriptHost {
  createActor(siteId: string, name?: string, persona?: string | DynamicActorPersona): DynamicActor;
  ask(siteId: string, actor: DynamicActor, instructions: string, schema?: JsonSchema): Promise<unknown>;
  read(siteId: string, operation: 'files.read' | 'files.glob', args: unknown[]): Promise<unknown>;
  report(siteId: string, item: unknown): void;
  log(message: string): void;
  phase(name: string): void;
  hole(siteId: string, name: string, prompt?: string): Promise<unknown>;
  trajectory?(siteId: string, filter?: DynamicTrajectoryFilter): Promise<unknown>;
}
export interface DynamicEvaluationOptions { signal?: AbortSignal; maxOperations?: number; args?: unknown; usage?: DynamicUsageBox }
/** Filled in by the evaluator so harnesses can report real operation counts. */
export interface DynamicUsageBox { operations: number }

