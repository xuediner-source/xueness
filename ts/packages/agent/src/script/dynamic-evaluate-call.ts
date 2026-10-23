import * as ts from "typescript";
import type { JsonSchema } from "@xueness/contracts";
import { actorValue, awaitValue, box, fail, isMarker, siteFor, step, toSafeNumber, toSafeString, trackTask, type Box, type EvaluationContext, type Marker } from "./dynamic-evaluate-internal.ts";
import { invokeArrow } from "./dynamic-evaluate-statement.ts";
import { ordinary, sameValueZero, snapshotArray } from "./dynamic-evaluate-values.ts";

export async function invokeCallable(ctx: EvaluationContext, node: ts.CallExpression, callee: unknown, args: unknown[], env: import("./dynamic-evaluate-internal.ts").Environment): Promise<Box> {
  await step(ctx, node);
  if (!isMarker(callee)) return fail(node, ctx, "only approved workflow and value methods can be called");
  if (callee.kind === "arrow") return invokeArrow(ctx, callee, args, node);
  if (callee.kind !== "intrinsic" && callee.kind !== "bound") return fail(node, ctx, "this value is not callable");
  if (callee.kind === "intrinsic") return callIntrinsic(ctx, node, callee.name, args);
  return callBound(ctx, node, callee, args, env);
}

function callIntrinsic(ctx: EvaluationContext, node: ts.CallExpression, name: string, args: unknown[]): Box {
  switch (name) {
    case "agent": {
      if (args.length > 2) return fail(node, ctx, "agent() accepts a name and optional persona");
      const persona = agentPersona(args[1], node, ctx);
      const actor = ctx.host.createActor(siteFor(ctx, node, "actor"), args[0] === undefined ? undefined : expectString(args[0], node, ctx, "agent name"), persona);
      ctx.actors.add(actor);
      return box(actor);
    }
    case "ask": {
      if (args.length !== 2) return fail(node, ctx, "ask() accepts an actor and instructions");
      return ask(ctx, node, args[0], args[1]);
    }
    case "report": {
      if (args.length !== 1) return fail(node, ctx, "report() accepts one item");
      ctx.host.report(siteFor(ctx, node, "report"), args[0]);
      return box(undefined);
    }
    case "log": {
      if (args.length !== 1) return fail(node, ctx, "log() accepts one message");
      ctx.host.log(toSafeString(args[0]));
      return box(undefined);
    }
    case "phase": {
      if (args.length !== 1) return fail(node, ctx, "phase() accepts one name");
      ctx.host.phase(expectString(args[0], node, ctx, "phase name"));
      return box(undefined);
    }
    case "hole": {
      if (args.length < 1 || args.length > 2) return fail(node, ctx, "hole() accepts a name and optional prompt");
      const promise = trackTask(ctx, ctx.host.hole(siteFor(ctx, node, "hole"), expectString(args[0], node, ctx, "hole name"), args[1] === undefined ? undefined : expectString(args[1], node, ctx, "hole prompt")));
      suppressUnobservedRejection(promise);
      return box(promise);
    }
    case "String": return box(args.length === 0 ? "" : toSafeString(args[0]));
    case "Number": return box(args.length === 0 ? 0 : toSafeNumber(args[0]));
    case "Boolean": return box(Boolean(args[0]));
    default: return fail(node, ctx, `call to '${name}' is not allowed`);
  }
}

function ask(ctx: EvaluationContext, node: ts.CallExpression, actorValueRaw: unknown, instructions: unknown): Box {
  const actor = ordinary(actorValueRaw);
  actorValue(ctx, actor, node);
  const prompt = expectString(ordinary(instructions), node, ctx, "ask instructions");
  const schema = ctx.compiled.schemas.get(node.getStart(ctx.compiled.sourceFile)) as JsonSchema | undefined;
  const promise = trackTask(ctx, ctx.host.ask(siteFor(ctx, node, "ask"), actor, prompt, schema));
  suppressUnobservedRejection(promise);
  return box(promise);
}

async function callBound(ctx: EvaluationContext, node: ts.CallExpression, callee: Extract<Marker, { kind: "bound" }>, args: unknown[], env: import("./dynamic-evaluate-internal.ts").Environment): Promise<Box> {
  const name = callee.name;
  if (name === "actor.ask") {
    if (args.length !== 1) return fail(node, ctx, "actor.ask() accepts one instruction string");
    return ask(ctx, node, callee.receiver, args[0]);
  }
  if (name === "files.read" || name === "files.glob") {
    const op = name as "files.read" | "files.glob";
    const result = trackTask(ctx, ctx.host.read(siteFor(ctx, node, "read"), op, args));
    suppressUnobservedRejection(result);
    return box(result);
  }
  if (name === "Promise.all") {
    if (args.length !== 1 || !Array.isArray(args[0])) return fail(node, ctx, "Promise.all() accepts one array");
    const result = Promise.all(snapshotArray(args[0], ctx, node));
    suppressUnobservedRejection(result);
    return box(result);
  }
  if (name === "JSON.parse") {
    if (args.length !== 1 || typeof args[0] !== "string") return fail(node, ctx, "JSON.parse() accepts one string");
    return box(JSON.parse(args[0]));
  }
  if (name === "JSON.stringify") {
    if (args.length > 1) return fail(node, ctx, "JSON.stringify() accepts one data value");
    return box(JSON.stringify(jsonSafeValue(args[0], ctx, node, new WeakSet())));
  }
  if (name.startsWith("Math.")) return box(mathCall(name.slice(5), args, node, ctx));
  if (name.startsWith("array.")) return arrayCall(name.slice(6), callee.receiver, args, node, ctx, env);
  if (name.startsWith("string.")) return box(stringCall(name.slice(7), callee.receiver, args, node, ctx));
  return fail(node, ctx, `call to '${name}' is not allowed`);
}

async function arrayCall(name: string, receiver: unknown, args: unknown[], node: ts.CallExpression, ctx: EvaluationContext, env: import("./dynamic-evaluate-internal.ts").Environment): Promise<Box> {
  if (!Array.isArray(receiver)) return fail(node, ctx, "array method receiver is invalid");
  const values = snapshotArray(receiver, ctx, node);
  if (name === "map" || name === "filter") {
    if (args.length !== 1 || !isSafeCallback(args[0])) return fail(node, ctx, `${name}() accepts one workflow callback`);
    const callback = args[0];
    if (name === "map") {
      const output: unknown[] = [];
      for (let index = 0; index < values.length; index += 1) {
        if (isAsyncArrow(callback)) {
          const call = invokeCallable(ctx, node, callback, callbackValues(callback, values[index], index, values), env);
          output.push(call.then((wrapped) => wrapped.value));
        } else {
          output.push((await invokeCallable(ctx, node, callback, callbackValues(callback, values[index], index, values), env)).value);
        }
      }
      return box(output);
    }
    const output: unknown[] = [];
    for (let index = 0; index < values.length; index += 1) {
      const result = await invokeCallable(ctx, node, callback, callbackValues(callback, values[index], index, values), env);
      const truth = await awaitValue(result.value, ctx, node);
      if (truth) output.push(values[index]);
    }
    return box(output);
  }
  switch (name) {
    case "join": return box(values.map((value) => value === null || value === undefined ? "" : toSafeString(value)).join(args[0] === undefined ? "," : toSafeString(args[0])));
    case "includes": return box(values.some((value) => sameValueZero(value, args[0])));
    case "slice": return box(values.slice(toInteger(args[0]), args[1] === undefined ? undefined : toInteger(args[1])));
    case "concat": {
      const output = values.slice();
      for (const value of args) Array.isArray(value) ? output.push(...snapshotArray(value, ctx, node)) : output.push(value);
      return box(output);
    }
    default: return fail(node, ctx, `array method '${name}' is not allowed`);
  }
}

function stringCall(name: string, receiver: unknown, args: unknown[], node: ts.CallExpression, ctx: EvaluationContext): unknown {
  if (typeof receiver !== "string") return fail(node, ctx, "string method receiver is invalid");
  switch (name) {
    case "trim": return receiver.trim();
    case "slice": return receiver.slice(toInteger(args[0]), args[1] === undefined ? undefined : toInteger(args[1]));
    case "includes": return receiver.includes(toSafeString(args[0]), args[1] === undefined ? 0 : toInteger(args[1]));
    case "toLowerCase": return receiver.toLowerCase();
    case "toUpperCase": return receiver.toUpperCase();
    case "split":
      if (args[0] !== undefined && typeof args[0] !== "string") return fail(node, ctx, "split separator must be a string");
      return args[0] === undefined
        ? receiver.split(undefined as unknown as string)
        : receiver.split(args[0], args[1] === undefined ? undefined : Math.max(0, toInteger(args[1])));
    default: return fail(node, ctx, `string method '${name}' is not allowed`);
  }
}

function mathCall(name: string, args: unknown[], node: ts.CallExpression, ctx: EvaluationContext): number {
  const values = args.map((value) => toSafeNumber(value));
  switch (name) {
    case "min": return Math.min(...values);
    case "max": return Math.max(...values);
    case "round": return Math.round(values[0] ?? 0);
    case "floor": return Math.floor(values[0] ?? 0);
    case "ceil": return Math.ceil(values[0] ?? 0);
    case "abs": return Math.abs(values[0] ?? 0);
    default: return fail(node, ctx, `Math.${name}() is not allowed`);
  }
}

function expectString(value: unknown, node: ts.Node, ctx: EvaluationContext, label: string): string {
  if (typeof value !== "string") return fail(node, ctx, `${label} must be a string`);
  return value;
}

function isSafeCallback(value: unknown): value is Marker {
  if (!isMarker(value)) return false;
  if (value.kind === "arrow") return true;
  return (value.kind === "intrinsic" && ["String", "Number", "Boolean"].includes(value.name)) ||
    (value.kind === "bound" && value.name.startsWith("Math."));
}

function isAsyncArrow(value: Marker): value is Extract<Marker, { kind: "arrow" }> {
  return value.kind === "arrow" && (value.node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false);
}

function callbackValues(callback: Marker, value: unknown, index: number, array: unknown[]): unknown[] {
  return callback.kind === "bound" && callback.name.startsWith("Math.") ? [value] : [value, index, array];
}

function jsonSafeValue(value: unknown, ctx: EvaluationContext, node: ts.Node, active: WeakSet<object>): unknown {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (typeof value === "bigint") return fail(node, ctx, "JSON.stringify cannot serialize bigint values");
  if (typeof value !== "object" || isMarker(value) || ctx.actors.has(value)) return fail(node, ctx, "JSON.stringify requires data values");
  if (active.has(value)) return fail(node, ctx, "JSON.stringify cannot serialize circular data");
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const items = snapshotArray(value, ctx, node);
      const copy: unknown[] = [];
      for (const item of items) copy.push(jsonSafeValue(item, ctx, node, active) ?? null);
      Object.setPrototypeOf(copy, null);
      return copy;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) return fail(node, ctx, "JSON.stringify cannot serialize custom objects");
    const copy = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) {
      if (key === "constructor" || key === "prototype" || key === "__proto__") return fail(node, ctx, `JSON.stringify property '${key}' is blocked`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return fail(node, ctx, "JSON.stringify cannot serialize accessor properties");
      const item = jsonSafeValue(descriptor.value, ctx, node, active);
      if (item !== undefined) Object.defineProperty(copy, key, { value: item, enumerable: true, configurable: true, writable: true });
    }
    return copy;
  } finally { active.delete(value); }
}

function agentPersona(value: unknown, node: ts.Node, ctx: EvaluationContext): string | { system?: string; model?: string } | undefined {
  if (value === undefined || typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value) || isMarker(value)) return fail(node, ctx, "agent persona must be a string or object");
  const persona: { system?: string; model?: string } = {};
  for (const key of ["system", "model"] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && !("value" in descriptor)) return fail(node, ctx, `agent persona ${key} must be a data value`);
    const field = descriptor?.value;
    if (field !== undefined) {
      if (typeof field !== "string") return fail(node, ctx, `agent persona ${key} must be a string`);
      persona[key] = field;
    }
  }
  return persona;
}

function toInteger(value: unknown): number {
  if (value === undefined) return 0;
  const number = toSafeNumber(value);
  if (Number.isNaN(number) || number === 0) return 0;
  return Math.trunc(number);
}

function suppressUnobservedRejection(promise: Promise<unknown>): void { void promise.catch(() => undefined); }
