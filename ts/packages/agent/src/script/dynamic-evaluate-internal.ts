import * as ts from "typescript";
import type { CompiledDynamicWorkflow, DynamicActor, DynamicScriptHost, DynamicEvaluationOptions, DynamicSite } from "./dynamic-types.ts";

const SAFE = Symbol("dynamic-safe-value");

export type Marker =
  | { [SAFE]: true; kind: "intrinsic"; name: string }
  | { [SAFE]: true; kind: "namespace"; name: string }
  | { [SAFE]: true; kind: "bound"; name: string; receiver: unknown }
  | { [SAFE]: true; kind: "arrow"; node: ts.ArrowFunction; env: Environment }
  | { [SAFE]: true; kind: "files" }
  | { [SAFE]: true; kind: "short" };

export interface Box { readonly value: unknown }
export interface Binding { value: unknown; constant: boolean }

export class Environment {
  readonly values = new Map<string, Binding>();
  readonly parent: Environment | null;
  constructor(parent: Environment | null = null) { this.parent = parent; }

  get(name: string): Binding | undefined { return this.values.get(name) ?? this.parent?.get(name); }
  define(name: string, value: unknown, constant: boolean): void {
    if (this.values.has(name)) throw new Error(`Identifier '${name}' has already been declared`);
    this.values.set(name, { value, constant });
  }
  assign(name: string, value: unknown): void {
    const binding = this.get(name);
    if (!binding) throw new Error(`Cannot assign to undeclared identifier '${name}'`);
    if (binding.constant) throw new Error(`Cannot assign to constant '${name}'`);
    binding.value = value;
  }
}

export interface EvaluationContext {
  readonly compiled: CompiledDynamicWorkflow;
  readonly host: DynamicScriptHost;
  readonly args: unknown;
  readonly signal?: AbortSignal;
  readonly maxOperations: number;
  readonly actors: WeakSet<object>;
  readonly sites: Map<string, DynamicSite>;
  readonly pending: Promise<unknown>[];
  operations: number;
}

export interface Completion { kind: "return" | "break" | "continue"; value?: unknown; node?: ts.Node }

export class DynamicEvaluationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "DynamicEvaluationError"; this.code = code; }
}

export function marker(value: object): Marker {
  return Object.assign(value, { [SAFE]: true }) as unknown as Marker;
}
export function isMarker(value: unknown): value is Marker {
  return value !== null && typeof value === "object" && (value as Partial<Marker>)[SAFE] === true;
}
export function intrinsic(name: string): Marker { return marker({ kind: "intrinsic", name }); }
export function namespace(name: string): Marker { return marker({ kind: "namespace", name }); }
export function box(value: unknown): Box { return { value }; }

export function createContext(compiled: CompiledDynamicWorkflow, host: DynamicScriptHost, options: DynamicEvaluationOptions = {}): EvaluationContext {
  const maxOperations = options.maxOperations ?? 100_000;
  if (!Number.isSafeInteger(maxOperations) || maxOperations < 1) throw new DynamicEvaluationError("DYNAMIC_BUDGET", "maxOperations must be a positive safe integer");
  return {
    compiled, host, args: options.args, signal: options.signal, maxOperations, actors: new WeakSet(),
    sites: new Map(compiled.sites.map((site) => [`${site.kind}:${site.start}`, site])), operations: 0, pending: [],
  };
}

export function trackTask<T>(ctx: EvaluationContext, task: Promise<T>): Promise<T> {
  ctx.pending.push(task);
  void task.catch(() => undefined);
  return task;
}

export function location(node: ts.Node, sourceFile: ts.SourceFile): string {
  const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${pos.line + 1}:${pos.character + 1}`;
}

export function fail(node: ts.Node | undefined, ctx: EvaluationContext, message: string, code = "DYNAMIC_EVALUATION"): never {
  const where = node ? `${location(node, ctx.compiled.sourceFile)}: ` : "";
  throw new DynamicEvaluationError(code, `${where}${message}`);
}

export async function step(ctx: EvaluationContext, node?: ts.Node): Promise<void> {
  if (ctx.signal?.aborted) fail(node, ctx, "dynamic evaluation cancelled", "DYNAMIC_CANCELLED");
  ctx.operations += 1;
  if (ctx.operations > ctx.maxOperations) fail(node, ctx, `operation budget exceeded (${ctx.maxOperations})`, "DYNAMIC_BUDGET");
  if ((ctx.operations & 127) === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (ctx.signal?.aborted) fail(node, ctx, "dynamic evaluation cancelled", "DYNAMIC_CANCELLED");
  }
}

export async function awaitValue(value: unknown, ctx: EvaluationContext, node: ts.Node): Promise<unknown> {
  if (ctx.signal?.aborted) fail(node, ctx, "dynamic evaluation cancelled", "DYNAMIC_CANCELLED");
  let result: unknown;
  if (ctx.signal) {
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new DynamicEvaluationError("DYNAMIC_CANCELLED", `${node ? `${location(node, ctx.compiled.sourceFile)}: ` : ""}dynamic evaluation cancelled`));
      ctx.signal!.addEventListener("abort", onAbort, { once: true });
      if (ctx.signal!.aborted) onAbort();
    });
    try { result = await Promise.race([Promise.resolve(value), cancelled]); }
    finally { if (onAbort) ctx.signal.removeEventListener("abort", onAbort); }
  } else result = await value;
  if (ctx.signal?.aborted) fail(node, ctx, "dynamic evaluation cancelled", "DYNAMIC_CANCELLED");
  return result;
}

export function siteFor(ctx: EvaluationContext, node: ts.CallExpression, kind?: DynamicSite["kind"]): string {
  const start = node.getStart(ctx.compiled.sourceFile);
  const site = kind ? ctx.sites.get(`${kind}:${start}`) : ctx.compiled.sites.find(site => site.start === start);
  if (!site || (kind && site.kind !== kind)) fail(node, ctx, `missing compiled ${kind ?? "call"} site`);
  return site.id;
}

export function actorValue(ctx: EvaluationContext, value: unknown, node: ts.Node): asserts value is DynamicActor {
  if (!value || typeof value !== "object" || !ctx.actors.has(value)) fail(node, ctx, "agent handle is invalid or was not created by this host");
}

export function primitive(value: unknown): boolean {
  return value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

export function toSafeString(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("circular array cannot be converted to a string");
    seen.add(value);
    const parts: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (!descriptor) parts.push("");
      else if (!("value" in descriptor)) throw new TypeError("array accessors cannot be converted to a string");
      else parts.push(descriptor.value == null ? "" : toSafeString(descriptor.value, seen));
    }
    seen.delete(value);
    return parts.join(",");
  }
  return "[object Object]";
}

export function toSafeNumber(value: unknown): number {
  if (value === null) return 0;
  if (value === undefined) return Number.NaN;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") return Number(value);
  throw new TypeError("value cannot be converted to a number safely");
}

export function safeKey(value: unknown): string | number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || value === null || value === undefined) return toSafeString(value);
  throw new TypeError("property keys must be strings or numbers");
}

export function forbiddenKey(key: string | number): boolean {
  return key === "constructor" || key === "prototype" || key === "__proto__";
}

export function truthy(value: unknown): boolean { return Boolean(value); }

export function sameValueZero(a: unknown, b: unknown): boolean {
  return a === b || (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b));
}
