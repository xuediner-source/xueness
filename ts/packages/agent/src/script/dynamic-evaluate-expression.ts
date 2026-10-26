import * as ts from "typescript";
import { invokeCallable } from "./dynamic-evaluate-call.ts";
import { Environment, awaitValue as guardedAwaitValue, box, fail, intrinsic, isMarker, marker, namespace, step, toSafeString, type Box, type EvaluationContext } from "./dynamic-evaluate-internal.ts";
import { getProperty, ordinary, setProperty, shortCircuit, isOptionalChain, snapshotArray } from "./dynamic-evaluate-values.ts";

interface Reference { read(): unknown; write(value: unknown): void }

function globalValue(name: string, ctx: EvaluationContext, node: ts.Node): unknown {
  switch (name) {
    case "args": return ctx.args;
    case "undefined": return undefined;
    case "agent": case "ask": case "report": case "log": case "phase": case "hole": case "String": case "Number": case "Boolean":
      return intrinsic(name);
    case "files": return marker({ kind: "files" });
    case "JSON": case "Math": case "Promise": return namespace(name);
    default: return fail(node, ctx, `unknown identifier '${name}'`);
  }
}

export async function evalExpression(node: ts.Expression, env: Environment, ctx: EvaluationContext): Promise<Box> {
  await step(ctx, node);
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) {
    return evalExpression(node.expression, env, ctx);
  }
  if (ts.isIdentifier(node)) {
    const binding = env.get(node.text);
    return box(binding ? binding.value : globalValue(node.text, ctx, node));
  }
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return box(node.text);
  if (ts.isNumericLiteral(node)) return box(Number(node.text.replaceAll("_", "")));
  if (node.kind === ts.SyntaxKind.TrueKeyword) return box(true);
  if (node.kind === ts.SyntaxKind.FalseKeyword) return box(false);
  if (node.kind === ts.SyntaxKind.NullKeyword) return box(null);
  if (ts.isArrayLiteralExpression(node)) {
    const values: unknown[] = [];
    for (const item of node.elements) {
      if (ts.isOmittedExpression(item)) values.push(undefined);
      else if (ts.isSpreadElement(item)) values.push(...iterableValues(ordinary((await evalExpression(item.expression, env, ctx)).value), item, ctx));
      else values.push(ordinary((await evalExpression(item, env, ctx)).value));
    }
    return box(values);
  }
  if (ts.isObjectLiteralExpression(node)) {
    const result = Object.create(null) as Record<string, unknown>;
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property)) {
        const key = propertyName(property.name, env, ctx);
        const value = ordinary((await evalExpression(property.initializer, env, ctx)).value);
        defineObjectProperty(result, key, value, ctx, property);
      } else if (ts.isShorthandPropertyAssignment(property)) {
        const value = ordinary((await evalExpression(property.name, env, ctx)).value);
        defineObjectProperty(result, property.name.text, value, ctx, property);
      } else if (ts.isSpreadAssignment(property)) {
        const source = ordinary((await evalExpression(property.expression, env, ctx)).value);
        if (!source || typeof source !== "object" || isMarker(source)) fail(property, ctx, "object spread requires a data object");
        for (const key of Object.keys(source)) {
          if (key === "constructor" || key === "prototype" || key === "__proto__") fail(property, ctx, `property '${key}' is blocked`);
          const descriptor = Object.getOwnPropertyDescriptor(source, key);
          if (descriptor && "value" in descriptor) defineObjectProperty(result, key, descriptor.value, ctx, property);
          else fail(property, ctx, "object spread cannot copy accessor properties");
        }
      } else fail(property, ctx, "object methods and accessors are not supported");
    }
    return box(result);
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      value += safeTemplateString(ordinary((await evalExpression(span.expression, env, ctx)).value), node, ctx);
      value += span.literal.text;
    }
    return box(value);
  }
  if (ts.isPropertyAccessExpression(node)) {
    const target = (await evalExpression(node.expression, env, ctx)).value;
    if (shortCircuit(target)) return box(target);
    const optional = node.questionDotToken !== undefined || isOptionalChain(node);
    return box(getProperty(target, node.name.text, optional, ctx, node));
  }
  if (ts.isElementAccessExpression(node)) {
    const target = (await evalExpression(node.expression, env, ctx)).value;
    if (shortCircuit(target)) return box(target);
    const key = node.argumentExpression ? (await evalExpression(node.argumentExpression, env, ctx)).value : undefined;
    return box(getProperty(target, key, node.questionDotToken !== undefined || isOptionalChain(node), ctx, node));
  }
  if (ts.isCallExpression(node)) {
    const callee = (await evalExpression(node.expression, env, ctx)).value;
    if (shortCircuit(callee)) return box(callee);
    if ((callee === undefined || callee === null) && (node.questionDotToken !== undefined || isOptionalChain(node)) && isOptionalChain(node)) return box(undefined);
    const args: unknown[] = [];
    for (const arg of node.arguments) {
      if (ts.isSpreadElement(arg)) args.push(...iterableValues(ordinary((await evalExpression(arg.expression, env, ctx)).value), arg, ctx));
      else args.push(ordinary((await evalExpression(arg, env, ctx)).value));
    }
    return invokeCallable(ctx, node, callee, args, env);
  }
  if (ts.isAwaitExpression(node)) {
    const value = ordinary((await evalExpression(node.expression, env, ctx)).value);
    return box(await waitForValue(value, ctx, node));
  }
  if (ts.isArrowFunction(node)) return box(marker({ kind: "arrow", node, env }));
  if (ts.isConditionalExpression(node)) {
    const condition = ordinary((await evalExpression(node.condition, env, ctx)).value);
    return truthy(condition) ? evalExpression(node.whenTrue, env, ctx) : evalExpression(node.whenFalse, env, ctx);
  }
  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    if (isAssignment(kind)) return box(await assignExpression(node, env, ctx));
    const leftRaw = (await evalExpression(node.left, env, ctx)).value;
    const left = ordinary(leftRaw);
    if (kind === ts.SyntaxKind.AmpersandAmpersandToken && !truthy(left)) return box(left);
    if (kind === ts.SyntaxKind.BarBarToken && truthy(left)) return box(left);
    if (kind === ts.SyntaxKind.QuestionQuestionToken && left !== null && left !== undefined) return box(left);
    const right = ordinary((await evalExpression(node.right, env, ctx)).value);
    return box(applyBinary(kind, left, right, node, ctx));
  }
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    if (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) {
      const ref = await reference(node.operand, env, ctx);
      const old = toNumber(ref.read(), node, ctx);
      const next = old + (node.operator === ts.SyntaxKind.PlusPlusToken ? 1 : -1);
      ref.write(next);
      return box(ts.isPostfixUnaryExpression(node) ? old : next);
    }
    if (ts.isPostfixUnaryExpression(node)) return fail(node, ctx, "postfix operator is not supported");
    const value = ordinary((await evalExpression(node.operand, env, ctx)).value);
    switch (node.operator) {
      case ts.SyntaxKind.ExclamationToken: return box(!truthy(value));
      case ts.SyntaxKind.PlusToken: return box(toNumber(value, node, ctx));
      case ts.SyntaxKind.MinusToken: return box(-toNumber(value, node, ctx));
      case ts.SyntaxKind.TildeToken: return box(~toNumber(value, node, ctx));
      default: return fail(node, ctx, "unsupported unary operator");
    }
  }
  if (ts.isTypeOfExpression(node)) return box(typeofValue(ordinary((await evalExpression(node.expression, env, ctx)).value)));
  if (ts.isVoidExpression(node)) { await evalExpression(node.expression, env, ctx); return box(undefined); }
  if (ts.isCommaListExpression(node)) {
    let value: unknown;
    for (const item of node.elements) value = ordinary((await evalExpression(item, env, ctx)).value);
    return box(value);
  }
  return fail(node, ctx, `unsupported expression ${ts.SyntaxKind[node.kind] ?? node.kind}`);
}

function propertyName(name: ts.PropertyName, env: Environment, ctx: EvaluationContext): string {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const source = name.expression;
    if (ts.isStringLiteralLike(source) || ts.isNumericLiteral(source)) return source.text;
  }
  return fail(name, ctx, "object keys must be literal strings or numbers");
}

function defineObjectProperty(target: Record<string, unknown>, key: string, value: unknown, ctx: EvaluationContext, node: ts.Node): void {
  if (key === "constructor" || key === "prototype" || key === "__proto__") fail(node, ctx, `property '${key}' is blocked`);
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function safeTemplateString(value: unknown, node: ts.Node, ctx: EvaluationContext): string {
  try { return toSafeString(value); } catch { return fail(node, ctx, "template value cannot be converted to a string safely"); }
}

function iterableValues(value: unknown, node: ts.Node, ctx: EvaluationContext): unknown[] {
  if (Array.isArray(value)) return snapshotArray(value, ctx, node);
  if (typeof value === "string") return Array.from(value);
  return fail(node, ctx, "spread and for-of require an array or string");
}

function isAssignment(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.EqualsToken || kind === ts.SyntaxKind.PlusEqualsToken || kind === ts.SyntaxKind.MinusEqualsToken ||
    kind === ts.SyntaxKind.AsteriskEqualsToken || kind === ts.SyntaxKind.SlashEqualsToken || kind === ts.SyntaxKind.PercentEqualsToken ||
    kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken || kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarBarEqualsToken || kind === ts.SyntaxKind.QuestionQuestionEqualsToken;
}

async function assignExpression(node: ts.BinaryExpression, env: Environment, ctx: EvaluationContext): Promise<unknown> {
  const ref = await reference(node.left, env, ctx);
  const kind = node.operatorToken.kind;
  if (kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken && !truthy(ref.read())) return ordinary(ref.read());
  if (kind === ts.SyntaxKind.BarBarEqualsToken && truthy(ref.read())) return ordinary(ref.read());
  if (kind === ts.SyntaxKind.QuestionQuestionEqualsToken && ref.read() !== null && ref.read() !== undefined) return ordinary(ref.read());
  const right = ordinary((await evalExpression(node.right, env, ctx)).value);
  // Logical assignments either short-circuited above or assign the right side unchanged.
  const value = kind === ts.SyntaxKind.EqualsToken || isLogicalAssignment(kind)
    ? right
    : applyBinary(compoundBase(kind), ordinary(ref.read()), right, node, ctx);
  ref.write(value);
  return value;
}

function isLogicalAssignment(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
    kind === ts.SyntaxKind.BarBarEqualsToken || kind === ts.SyntaxKind.QuestionQuestionEqualsToken;
}

function compoundBase(kind: ts.SyntaxKind): ts.SyntaxKind {
  switch (kind) {
    case ts.SyntaxKind.PlusEqualsToken: return ts.SyntaxKind.PlusToken;
    case ts.SyntaxKind.MinusEqualsToken: return ts.SyntaxKind.MinusToken;
    case ts.SyntaxKind.AsteriskEqualsToken: return ts.SyntaxKind.AsteriskToken;
    case ts.SyntaxKind.SlashEqualsToken: return ts.SyntaxKind.SlashToken;
    case ts.SyntaxKind.PercentEqualsToken: return ts.SyntaxKind.PercentToken;
    case ts.SyntaxKind.AsteriskAsteriskEqualsToken: return ts.SyntaxKind.AsteriskAsteriskToken;
    default: return kind;
  }
}

async function reference(node: ts.Expression, env: Environment, ctx: EvaluationContext): Promise<Reference> {
  if (ts.isIdentifier(node)) {
    const binding = env.get(node.text);
    if (!binding) fail(node, ctx, `cannot assign to undeclared identifier '${node.text}'`, "DYNAMIC_ASSIGNMENT");
    if (binding.constant) fail(node, ctx, `cannot assign to constant '${node.text}'`, "DYNAMIC_ASSIGNMENT");
    return { read: () => binding.value, write: (value) => { binding.value = value; } };
  }
  if (ts.isPropertyAccessExpression(node)) {
    const target = ordinary((await evalExpression(node.expression, env, ctx)).value);
    return { read: () => getProperty(target, node.name.text, false, ctx, node), write: (value) => setProperty(target, node.name.text, value, ctx, node) };
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    const target = ordinary((await evalExpression(node.expression, env, ctx)).value);
    const key = ordinary((await evalExpression(node.argumentExpression, env, ctx)).value);
    return { read: () => getProperty(target, key, false, ctx, node), write: (value) => setProperty(target, key, value, ctx, node) };
  }
  return fail(node, ctx, "assignment target must be a variable, property, or array element");
}

function applyBinary(kind: ts.SyntaxKind, left: unknown, right: unknown, node: ts.Node, ctx: EvaluationContext): unknown {
  switch (kind) {
    case ts.SyntaxKind.AmpersandAmpersandToken: return truthy(left) ? right : left;
    case ts.SyntaxKind.BarBarToken: return truthy(left) ? left : right;
    case ts.SyntaxKind.QuestionQuestionToken: return left === null || left === undefined ? right : left;
    case ts.SyntaxKind.CommaToken: return right;
    case ts.SyntaxKind.EqualsEqualsEqualsToken: return left === right;
    case ts.SyntaxKind.ExclamationEqualsEqualsToken: return left !== right;
    case ts.SyntaxKind.EqualsEqualsToken: return looseEqual(left, right);
    case ts.SyntaxKind.ExclamationEqualsToken: return !looseEqual(left, right);
    case ts.SyntaxKind.PlusToken:
      if (typeof left === "string" || typeof right === "string") return safePrimitiveString(left, node, ctx) + safePrimitiveString(right, node, ctx);
      return toNumber(left, node, ctx) + toNumber(right, node, ctx);
    case ts.SyntaxKind.MinusToken: return toNumber(left, node, ctx) - toNumber(right, node, ctx);
    case ts.SyntaxKind.AsteriskToken: return toNumber(left, node, ctx) * toNumber(right, node, ctx);
    case ts.SyntaxKind.SlashToken: return toNumber(left, node, ctx) / toNumber(right, node, ctx);
    case ts.SyntaxKind.PercentToken: return toNumber(left, node, ctx) % toNumber(right, node, ctx);
    case ts.SyntaxKind.AsteriskAsteriskToken: return toNumber(left, node, ctx) ** toNumber(right, node, ctx);
    case ts.SyntaxKind.LessThanToken: return compare(left, right, node, ctx) < 0;
    case ts.SyntaxKind.LessThanEqualsToken: return compare(left, right, node, ctx) <= 0;
    case ts.SyntaxKind.GreaterThanToken: return compare(left, right, node, ctx) > 0;
    case ts.SyntaxKind.GreaterThanEqualsToken: return compare(left, right, node, ctx) >= 0;
    case ts.SyntaxKind.InKeyword:
      if (right === null || typeof right !== "object" || isMarker(right)) fail(node, ctx, "right side of 'in' must be a data object");
      return Object.hasOwn(right, safePrimitiveString(left, node, ctx));
    default: return fail(node, ctx, `unsupported binary operator ${ts.SyntaxKind[kind]}`);
  }
}

function safePrimitiveString(value: unknown, node: ts.Node, ctx: EvaluationContext): string {
  if (value === null || value === undefined || ["string", "number", "boolean"].includes(typeof value)) return String(value);
  return fail(node, ctx, "operator cannot convert an object to a primitive safely");
}

function toNumber(value: unknown, node: ts.Node, ctx: EvaluationContext): number {
  if (value === null) return 0;
  if (value === undefined) return Number.NaN;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") return Number(value);
  return fail(node, ctx, "operator cannot convert an object to a number safely");
}

function compare(left: unknown, right: unknown, node: ts.Node, ctx: EvaluationContext): number {
  if (typeof left === "string" && typeof right === "string") return left < right ? -1 : left > right ? 1 : 0;
  return toNumber(left, node, ctx) < toNumber(right, node, ctx) ? -1 : toNumber(left, node, ctx) > toNumber(right, node, ctx) ? 1 : 0;
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (typeof a === "boolean") return looseEqual(Number(a), b);
  if (typeof b === "boolean") return looseEqual(a, Number(b));
  if (typeof a === "number" && typeof b === "string") return a === Number(b);
  if (typeof a === "string" && typeof b === "number") return Number(a) === b;
  return false;
}

function truthy(value: unknown): boolean { return Boolean(ordinary(value)); }
function typeofValue(value: unknown): string {
  if (value === null) return "object";
  if (isMarker(value) && (value.kind === "intrinsic" || value.kind === "bound" || value.kind === "arrow")) return "function";
  return typeof value;
}

async function waitForValue(value: unknown, ctx: EvaluationContext, node: ts.Node): Promise<unknown> {
  return ordinary(await guardedAwaitValue(value, ctx, node));
}
