/** Native dynamic-script contracts. Product execution stays behind these ports. */
import type ts from 'typescript';
import type { JsonSchema } from '@xueness/contracts';

export interface DynamicDiagnostic { code: string; message: string; line: number; column: number }
export interface DynamicSite { id: string; kind: 'actor' | 'ask' | 'read' | 'report' | 'hole' | 'phase'; start: number; line: number; column: number; name?: string }
export interface CompiledDynamicWorkflow {
  source: string;
  sourceFile: ts.SourceFile;
  diagnostics: DynamicDiagnostic[];
  sites: DynamicSite[];
  /** Type schemas for ask<T>, keyed by the CallExpression start coordinate. */
  schemas: Map<number, JsonSchema>;
}
export interface DynamicActor { id: string; name?: string; persona: { system?: string; model?: string } }
export interface DynamicScriptHost {
  createActor(siteId: string, name?: string, persona?: string | { system?: string; model?: string }): DynamicActor;
  ask(siteId: string, actor: DynamicActor, instructions: string, schema?: JsonSchema): Promise<unknown>;
  read(siteId: string, operation: 'files.read' | 'files.glob', args: unknown[]): Promise<unknown>;
  report(siteId: string, item: unknown): void;
  log(message: string): void;
  phase(name: string): void;
  hole(siteId: string, name: string, prompt?: string): Promise<unknown>;
}
export interface DynamicEvaluationOptions { signal?: AbortSignal; maxOperations?: number; args?: unknown; usage?: DynamicUsageBox }
/** Filled in by the evaluator so harnesses can report real operation counts. */
export interface DynamicUsageBox { operations: number }

