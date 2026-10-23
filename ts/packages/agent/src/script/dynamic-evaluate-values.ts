import * as ts from "typescript";
import { DynamicEvaluationError, type EvaluationContext, type Marker, fail, forbiddenKey, isMarker, marker, namespace, safeKey, sameValueZero, toSafeString } from "./dynamic-evaluate-internal.ts";

export const SHORT_CIRCUIT = marker({ kind: "short" });
const ARRAY_METHODS = new Set(["map", "filter", "join", "includes", "slice", "concat"]);
const STRING_METHODS = new Set(["trim", "slice", "includes", "toLowerCase", "toUpperCase", "split"]);
const MATH_METHODS = new Set(["min", "max", "round", "floor", "ceil", "abs"]);

export function ordinary(value: unknown): unknown {
  return isMarker(value) && value.kind === "short" ? undefined : value;
}

export function snapshotArray(value: unknown, ctx: EvaluationContext, node: ts.Node): unknown[] {
  if (!Array.isArray(value)) return fail(node, ctx, "expected an array value");
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor) output.push(undefined);
    else if (!("value" in descriptor)) return fail(node, ctx, "array accessors are not available to scripts");
    else output.push(descriptor.value);
  }
  return output;
}

function numericIndex(key: string | number): number | null {
  if (typeof key === "number" && Number.isInteger(key) && key >= 0) return key;
  if (typeof key === "string" && /^(0|[1-9]\d*)$/.test(key)) return Number(key);
  return null;
}

function ownData(receiver: object, key: string | number, ctx: EvaluationContext, node: ts.Node): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(receiver, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) throw new DynamicEvaluationError("DYNAMIC_PROPERTY", `${node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1}: accessor properties are not available to scripts`);
  return descriptor.value;
}

export function getProperty(receiverValue: unknown, keyValue: unknown, optional: boolean, ctx: EvaluationContext, node: ts.Node): unknown {
  if (isMarker(receiverValue) && receiverValue.kind === "short") return SHORT_CIRCUIT;
  const receiver = ordinary(receiverValue);
  if (receiver === null || receiver === undefined) {
    if (optional || (node.flags & ts.NodeFlags.OptionalChain) !== 0) return SHORT_CIRCUIT;
    throw new DynamicEvaluationError("DYNAMIC_PROPERTY", `cannot read a property from ${receiver}`);
  }
  const key = safeKey(ordinary(keyValue));
  if (forbiddenKey(key)) throw new DynamicEvaluationError("DYNAMIC_PROPERTY", `property '${String(key)}' is blocked`);

  if (isMarker(receiver)) {
    if (receiver.kind === "namespace") {
      const allowed = receiver.name === "JSON" ? new Set(["parse", "stringify"])
        : receiver.name === "Promise" ? new Set(["all"])
        : receiver.name === "Math" ? MATH_METHODS : new Set<string>();
      if (typeof key === "string" && allowed.has(key)) return marker({ kind: "bound", name: `${receiver.name}.${key}`, receiver: undefined });
      return undefined;
    }
    if (receiver.kind === "files" && (key === "read" || key === "glob")) return marker({ kind: "bound", name: `files.${key}`, receiver: undefined });
    throw new DynamicEvaluationError("DYNAMIC_PROPERTY", "properties on this value are not exposed");
  }

  if (typeof receiver === "object" && ctx.actors.has(receiver)) {
    if (key === "ask") return marker({ kind: "bound", name: "actor.ask", receiver });
    throw new DynamicEvaluationError("DYNAMIC_PROPERTY", "agent handles expose only ask()");
  }

  if (Array.isArray(receiver)) {
    if (key === "length") return receiver.length;
    const index = numericIndex(key);
    if (index !== null) return ownData(receiver, index, ctx, node);
    if (typeof key === "string" && ARRAY_METHODS.has(key)) return marker({ kind: "bound", name: `array.${key}`, receiver });
    return ownData(receiver, key, ctx, node);
  }
  if (typeof receiver === "string") {
    if (key === "length") return receiver.length;
    const index = numericIndex(key);
    if (index !== null) return receiver[index];
    if (typeof key === "string" && STRING_METHODS.has(key)) return marker({ kind: "bound", name: `string.${key}`, receiver });
    return undefined;
  }
  if (typeof receiver === "object") return ownData(receiver, key, ctx, node);
  return undefined;
}

export function setProperty(receiverValue: unknown, keyValue: unknown, value: unknown, ctx: EvaluationContext, node: ts.Node): void {
  const receiver = ordinary(receiverValue);
  if (receiver === null || typeof receiver !== "object" || isMarker(receiver)) throw new DynamicEvaluationError("DYNAMIC_ASSIGNMENT", "property assignment needs a script data object or array");
  if (ctx.actors.has(receiver)) throw new DynamicEvaluationError("DYNAMIC_ASSIGNMENT", "agent handles are opaque and cannot be changed");
  const key = safeKey(ordinary(keyValue));
  if (forbiddenKey(key)) throw new DynamicEvaluationError("DYNAMIC_PROPERTY", `property '${String(key)}' is blocked`);
  const proto = Object.getPrototypeOf(receiver);
  if (proto !== null && proto !== Object.prototype && proto !== Array.prototype) throw new DynamicEvaluationError("DYNAMIC_ASSIGNMENT", "only plain objects and arrays can be changed");
  const before = Object.getOwnPropertyDescriptor(receiver, key);
  if (before && (!before.writable || !("value" in before))) throw new DynamicEvaluationError("DYNAMIC_ASSIGNMENT", `property '${String(key)}' is not writable data`);
  Object.defineProperty(receiver, key, { value: ordinary(value), writable: true, enumerable: before?.enumerable ?? true, configurable: true });
}

export function shortCircuit(value: unknown): boolean { return isMarker(value) && value.kind === "short"; }
export function truthy(value: unknown): boolean { return Boolean(ordinary(value)); }
export { sameValueZero };

export function isOptionalChain(node: ts.Node): boolean {
  return (node.flags & ts.NodeFlags.OptionalChain) !== 0 ||
    ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isCallExpression(node)) && node.questionDotToken !== undefined);
}

export function jsonNamespace(): Marker { return namespace("JSON"); }
export function mathNamespace(): Marker { return namespace("Math"); }
export function promiseNamespace(): Marker { return namespace("Promise"); }
