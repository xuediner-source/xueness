import * as ts from "typescript";
import { Environment, awaitValue, box, fail, step, trackTask, type Box, type Completion, type EvaluationContext, type Marker } from "./dynamic-evaluate-internal.ts";
import { evalExpression } from "./dynamic-evaluate-expression.ts";
import { ordinary, snapshotArray, truthy } from "./dynamic-evaluate-values.ts";

export async function evaluateProgram(ctx: EvaluationContext): Promise<unknown> {
  if (ctx.compiled.diagnostics.length > 0) {
    const first = ctx.compiled.diagnostics[0]!;
    throw new Error(`workflow is not runnable: ${first.code}: ${first.message} (${first.line}:${first.column})`);
  }
  const completion = await executeStatements(ctx.compiled.sourceFile.statements, new Environment(), ctx);
  return completion?.kind === "return" ? awaitValue(completion.value, ctx, completion.node ?? ctx.compiled.sourceFile) : undefined;
}

export async function invokeArrow(ctx: EvaluationContext, arrow: Extract<Marker, { kind: "arrow" }>, args: unknown[], callNode: ts.Node): Promise<Box> {
  const isAsync = arrow.node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
  if (isAsync) {
    const result = trackTask(ctx, executeArrow(arrow, args, ctx, callNode).then(async (value) => ordinary(await awaitRaw(value.value, ctx, callNode))));
    void result.catch(() => undefined);
    return box(result);
  }
  return box((await executeArrow(arrow, args, ctx, callNode)).value);
}

async function executeArrow(arrow: Extract<Marker, { kind: "arrow" }>, args: unknown[], ctx: EvaluationContext, callNode: ts.Node): Promise<Box> {
  const env = new Environment(arrow.env);
  for (let index = 0; index < arrow.node.parameters.length; index += 1) {
    const parameter = arrow.node.parameters[index]!;
    if (!ts.isIdentifier(parameter.name) || parameter.dotDotDotToken) fail(parameter, ctx, "arrow parameters must be simple names");
    let value = args[index];
    if (value === undefined && parameter.initializer) value = ordinary((await evalExpression(parameter.initializer, env, ctx)).value);
    env.define(parameter.name.text, value, false);
  }
  if (ts.isBlock(arrow.node.body)) {
    const completion = await executeStatement(arrow.node.body, env, ctx);
    return box(completion?.kind === "return" ? completion.value : undefined);
  }
  return evalExpression(arrow.node.body, env, ctx);
}

async function executeStatements(statements: ts.NodeArray<ts.Statement>, env: Environment, ctx: EvaluationContext): Promise<Completion | null> {
  for (const statement of statements) {
    const completion = await executeStatement(statement, env, ctx);
    if (completion) return completion;
  }
  return null;
}

async function executeStatement(statement: ts.Statement, env: Environment, ctx: EvaluationContext): Promise<Completion | null> {
  await step(ctx, statement);
  if (ts.isEmptyStatement(statement) || ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) return null;
  if (ts.isBlock(statement)) return executeStatements(statement.statements, new Environment(env), ctx);
  if (ts.isVariableStatement(statement)) {
    const constant = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) fail(declaration, ctx, "only simple variable names are supported");
      const value = declaration.initializer ? ordinary((await evalExpression(declaration.initializer, env, ctx)).value) : undefined;
      env.define(declaration.name.text, value, constant);
    }
    return null;
  }
  if (ts.isExpressionStatement(statement)) { await evalExpression(statement.expression, env, ctx); return null; }
  if (ts.isIfStatement(statement)) {
    const condition = ordinary((await evalExpression(statement.expression, env, ctx)).value);
    if (truthy(condition)) return executeStatement(statement.thenStatement, env, ctx);
    return statement.elseStatement ? executeStatement(statement.elseStatement, env, ctx) : null;
  }
  if (ts.isReturnStatement(statement)) {
    const value = statement.expression ? ordinary((await evalExpression(statement.expression, env, ctx)).value) : undefined;
    return { kind: "return", value, node: statement };
  }
  if (ts.isBreakStatement(statement)) return { kind: "break" };
  if (ts.isContinueStatement(statement)) return { kind: "continue" };
  if (ts.isForStatement(statement)) return executeFor(statement, env, ctx);
  if (ts.isForOfStatement(statement)) return executeForOf(statement, env, ctx);
  if (ts.isWhileStatement(statement)) return executeWhile(statement, env, ctx);
  return fail(statement, ctx, `unsupported statement ${ts.SyntaxKind[statement.kind] ?? statement.kind}`);
}

async function executeFor(node: ts.ForStatement, outer: Environment, ctx: EvaluationContext): Promise<Completion | null> {
  const env = new Environment(outer);
  if (node.initializer) {
    if (ts.isVariableDeclarationList(node.initializer)) {
      const constant = (node.initializer.flags & ts.NodeFlags.Const) !== 0;
      for (const declaration of node.initializer.declarations) {
        if (!ts.isIdentifier(declaration.name)) fail(declaration, ctx, "for initializer must use a simple name");
        const value = declaration.initializer ? ordinary((await evalExpression(declaration.initializer, env, ctx)).value) : undefined;
        env.define(declaration.name.text, value, constant);
      }
    } else await evalExpression(node.initializer, env, ctx);
  }
  while (node.condition === undefined || truthy(ordinary((await evalExpression(node.condition, env, ctx)).value))) {
    await step(ctx, node);
    const completion = await executeStatement(node.statement, env, ctx);
    if (completion?.kind === "return") return completion;
    if (completion?.kind === "break") return null;
    if (node.incrementor) await evalExpression(node.incrementor, env, ctx);
  }
  return null;
}

async function executeForOf(node: ts.ForOfStatement, outer: Environment, ctx: EvaluationContext): Promise<Completion | null> {
  if (node.awaitModifier) return fail(node, ctx, "for-await is not supported");
  const iterable = ordinary((await evalExpression(node.expression, outer, ctx)).value);
  const values = Array.isArray(iterable) ? snapshotArray(iterable, ctx, node) : typeof iterable === "string" ? Array.from(iterable) : null;
  if (!values) return fail(node.expression, ctx, "for-of requires an array or string");
  const declaration = ts.isVariableDeclarationList(node.initializer) ? node.initializer.declarations[0] : undefined;
  if (ts.isVariableDeclarationList(node.initializer) && (node.initializer.declarations.length !== 1 || !declaration || !ts.isIdentifier(declaration.name))) {
    return fail(node.initializer, ctx, "for-of initializer must declare one simple name");
  }
  if (!ts.isVariableDeclarationList(node.initializer) && !ts.isIdentifier(node.initializer)) return fail(node.initializer, ctx, "for-of target must be a simple name");
  const constant = ts.isVariableDeclarationList(node.initializer) && (node.initializer.flags & ts.NodeFlags.Const) !== 0;
  const reused = ts.isIdentifier(node.initializer) ? outer.get(node.initializer.text) : undefined;
  if (ts.isIdentifier(node.initializer) && !reused) return fail(node.initializer, ctx, `unknown for-of variable '${node.initializer.text}'`);
  for (const value of values) {
    await step(ctx, node);
    const env = new Environment(outer);
    if (declaration && ts.isIdentifier(declaration.name)) env.define(declaration.name.text, value, constant);
    else if (ts.isIdentifier(node.initializer)) {
      if (reused!.constant) return fail(node.initializer, ctx, `cannot assign to constant '${node.initializer.text}'`);
      reused!.value = value;
    }
    const completion = await executeStatement(node.statement, env, ctx);
    if (completion?.kind === "return") return completion;
    if (completion?.kind === "break") break;
  }
  return null;
}

async function executeWhile(node: ts.WhileStatement, env: Environment, ctx: EvaluationContext): Promise<Completion | null> {
  while (truthy(ordinary((await evalExpression(node.expression, env, ctx)).value))) {
    await step(ctx, node);
    const completion = await executeStatement(node.statement, env, ctx);
    if (completion?.kind === "return") return completion;
    if (completion?.kind === "break") return null;
  }
  return null;
}

async function awaitRaw(value: unknown, ctx: EvaluationContext, node: ts.Node): Promise<unknown> {
  return awaitValue(value, ctx, node);
}
