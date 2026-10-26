import * as ts from "typescript";
import type { CompiledDynamicWorkflow, DynamicDiagnostic, DynamicSite } from "./dynamic-types.ts";
import { synthesizeDynamicSchemas } from "./dynamic-schema.ts";

const FORBIDDEN_GLOBALS = new Set(["process", "require", "fetch", "Date", "global", "globalThis", "console", "Function", "eval"]);
const FORBIDDEN_PROPERTIES = new Set(["constructor", "prototype", "__proto__"]);
const ARRAY_METHODS = new Set(["map", "filter", "join", "includes", "slice", "concat"]);
const STRING_METHODS = new Set(["trim", "slice", "includes", "toLowerCase", "toUpperCase", "split"]);
const MATH_METHODS = new Set(["min", "max", "round", "floor", "ceil", "abs"]);

type SiteKind = DynamicSite["kind"];

function propertyName(node: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) return node.argumentExpression.text;
  return undefined;
}

function callPath(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (!ts.isPropertyAccessExpression(node)) return undefined;
  const root = callPath(node.expression);
  return root ? `${root}.${node.name.text}` : undefined;
}

function textLiteral(node: ts.Expression | undefined): string | undefined {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;
  return undefined;
}

export function compileDynamicWorkflow(source: string): CompiledDynamicWorkflow {
  const validLength = source.length >= 1 && source.length <= 32_000;
  const sourceFile = ts.createSourceFile("dynamic-workflow.ts", validLength ? source : "", ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics: DynamicDiagnostic[] = [];
  const sites: DynamicSite[] = [];
  const schemas = new Map<number, import("@xueness/contracts").JsonSchema>();
  const parseDiagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  const at = (node: ts.Node): { line: number; column: number } => {
    const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return { line: pos.line + 1, column: pos.character + 1 };
  };
  const report = (node: ts.Node, code: string, message: string): void => {
    diagnostics.push({ code, message, ...at(node) });
  };

  if (!validLength) {
    diagnostics.push({ code: "DYN_SOURCE_LENGTH", message: "Source must contain 1 to 32000 characters.", line: 1, column: 1 });
    return { source, sourceFile, diagnostics, sites, schemas };
  }
  if (parseDiagnostics.length) {
    for (const item of parseDiagnostics) {
      const pos = sourceFile.getLineAndCharacterOfPosition(item.start ?? 0);
      diagnostics.push({
        code: `TS${item.code}`,
        message: ts.flattenDiagnosticMessageText(item.messageText, "\n"),
        line: pos.line + 1,
        column: pos.character + 1,
      });
    }
    return { source, sourceFile, diagnostics, sites, schemas };
  }

  const ordinal: Record<SiteKind, number> = { actor: 0, ask: 0, read: 0, report: 0, hole: 0, phase: 0 };
  const actorNames = new Set<string>();
  const recordSite = (call: ts.CallExpression, kind: SiteKind, name?: string): void => {
    ordinal[kind] += 1;
    const pos = at(call);
    sites.push({ id: `${kind}#${ordinal[kind]}`, kind, start: call.getStart(sourceFile), ...pos, ...(name === undefined ? {} : { name }) });
    if (kind === "actor" && name !== undefined) {
      if (actorNames.has(name)) report(call, "DYN_DUPLICATE_ACTOR_NAME", `Actor name '${name}' is already used.`);
      actorNames.add(name);
    }
  };

  const checkStatement = (node: ts.Statement, topLevel = false): void => {
    if (ts.isVariableStatement(node)) {
      if (node.modifiers?.length) report(node, "DYN_UNSUPPORTED_SYNTAX", "export and declare modifiers are not supported.");
      if ((node.declarationList.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) === 0) {
        report(node, "DYN_UNSUPPORTED_SYNTAX", "Only const and let declarations are supported.");
      }
      for (const declaration of node.declarationList.declarations) {
        checkBindingPattern(declaration.name);
        if (declaration.type) checkTypeSyntax(declaration.type);
        if (declaration.initializer) checkExpression(declaration.initializer);
        else if ((node.declarationList.flags & ts.NodeFlags.Const) !== 0) report(declaration, "DYN_UNSUPPORTED_SYNTAX", "const declarations need an initializer.");
      }
      return;
    }
    if (ts.isExpressionStatement(node)) { checkExpression(node.expression); return; }
    if (ts.isReturnStatement(node)) { if (node.expression) checkExpression(node.expression); return; }
    if (ts.isIfStatement(node)) {
      checkExpression(node.expression); checkStatement(node.thenStatement);
      if (node.elseStatement) checkStatement(node.elseStatement);
      return;
    }
    if (ts.isForStatement(node)) { checkFor(node); return; }
    if (ts.isForOfStatement(node)) {
      if (node.awaitModifier) report(node.awaitModifier, "DYN_UNSUPPORTED_SYNTAX", "for await is not supported.");
      checkForBinding(node.initializer); checkExpression(node.expression); checkStatement(node.statement); return;
    }
    if (ts.isWhileStatement(node)) { checkExpression(node.expression); checkStatement(node.statement); return; }
    if (ts.isDoStatement(node)) { checkStatement(node.statement); checkExpression(node.expression); return; }
    if (ts.isSwitchStatement(node)) {
      checkExpression(node.expression);
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause)) checkExpression(clause.expression);
        for (const clauseStatement of clause.statements) checkStatement(clauseStatement);
      }
      return;
    }
    if (ts.isBlock(node)) { for (const statement of node.statements) checkStatement(statement); return; }
    if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
      if (node.label) report(node, "DYN_UNSUPPORTED_SYNTAX", "Labeled break and continue are not supported.");
      return;
    }
    if (ts.isEmptyStatement(node)) return;
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
      if (!topLevel) report(node, "DYN_UNSUPPORTED_SYNTAX", "Type declarations are only supported at the top level.");
      if (node.modifiers?.length) report(node, "DYN_UNSUPPORTED_SYNTAX", "export and declare modifiers are not supported.");
      if (node.typeParameters?.length) report(node, "DYN_UNSUPPORTED_SYNTAX", "Generic type declarations are not supported.");
      return;
    }
    report(node, "DYN_UNSUPPORTED_SYNTAX", `Statement '${ts.SyntaxKind[node.kind]}' is not supported.`);
  };

  const checkForBinding = (node: ts.ForInitializer): void => {
    if (ts.isVariableDeclarationList(node)) {
      if ((node.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let)) === 0) {
        report(node, "DYN_UNSUPPORTED_SYNTAX", "Only const and let loop declarations are supported.");
      }
      if (node.declarations.length !== 1) {
        report(node, "DYN_UNSUPPORTED_SYNTAX", "Loop declarations need exactly one binding.");
      }
      for (const declaration of node.declarations) {
        checkBindingPattern(declaration.name);
        if (declaration.type) checkTypeSyntax(declaration.type);
        if (declaration.initializer) checkExpression(declaration.initializer);
      }
    } else checkExpression(node);
  };

  /** Binding patterns for declarations, for..of targets and arrow parameters. */
  const checkBindingPattern = (node: ts.BindingName): void => {
    if (ts.isIdentifier(node)) return;
    if (!ts.isArrayBindingPattern(node) && !ts.isObjectBindingPattern(node)) {
      report(node, "DYN_UNSUPPORTED_SYNTAX", "Only identifiers and destructuring patterns can be bound.");
      return;
    }
    for (const element of node.elements) {
      if (!ts.isBindingElement(element)) { report(element, "DYN_UNSUPPORTED_SYNTAX", "Omitted bindings are not supported."); continue; }
      if (element.propertyName && !ts.isIdentifier(element.propertyName) && !ts.isStringLiteralLike(element.propertyName) && !ts.isNumericLiteral(element.propertyName)) {
        report(element.propertyName, "DYN_UNSUPPORTED_SYNTAX", "Pattern property names must be literal keys.");
      }
      checkBindingPattern(element.name);
      if (element.initializer) checkExpression(element.initializer);
    }
  };

  const checkFor = (node: ts.ForStatement): void => {
    const init = node.initializer;
    const condition = node.condition;
    if (init) checkForBinding(init);
    if (condition) checkExpression(condition);
    if (node.incrementor) checkExpression(node.incrementor);
    checkStatement(node.statement);
  };

  const checkTypeSyntax = (node: ts.TypeNode): void => {
    const visit = (current: ts.Node): void => {
      if (current.kind === ts.SyntaxKind.AnyKeyword || current.kind === ts.SyntaxKind.UnknownKeyword ||
          ts.isFunctionTypeNode(current) || ts.isConstructorTypeNode(current)) {
        report(current, "DYN_UNSUPPORTED_TYPE", "any, unknown, and function types are not supported.");
      } else if (ts.isTypeReferenceNode(current) && ["Date", "Function"].includes(current.typeName.getText(sourceFile))) {
        report(current, "DYN_UNSUPPORTED_TYPE", `${current.typeName.getText(sourceFile)} types are not supported.`);
      }
      ts.forEachChild(current, visit);
    };
    visit(node);
  };

  const checkCall = (node: ts.CallExpression): boolean => {
    const path = callPath(node.expression);
    if (path === "agent") {
      if (node.arguments.length > 2) report(node, "DYN_UNSUPPORTED_CALL", "agent accepts at most name and persona arguments.");
      recordSite(node, "actor", textLiteral(node.arguments[0]));
      return false;
    }
    if (path === "ask") {
      if (node.arguments.length !== 2) report(node, "DYN_UNSUPPORTED_CALL", "ask accepts an actor and one instructions argument.");
      recordSite(node, "ask");
      return false;
    }
    if (path?.endsWith(".ask") || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "ask")) {
      if (node.arguments.length !== 1) report(node, "DYN_UNSUPPORTED_CALL", "ask accepts one instructions argument.");
      recordSite(node, "ask");
      return false;
    }
    if (path === "files.read" || path === "files.glob") { recordSite(node, "read"); return false; }
    if (path === "report") { recordSite(node, "report"); return false; }
    if (path === "hole") { recordSite(node, "hole", textLiteral(node.arguments[0])); return false; }
    if (path === "phase") { recordSite(node, "phase", textLiteral(node.arguments[0])); return false; }
    if (path === "log") return false;

    const member = propertyName(node.expression);
    const approvedMethod = member !== undefined && (ARRAY_METHODS.has(member) || STRING_METHODS.has(member));
    if (approvedMethod) return member === "map" || member === "filter";
    if (path === "JSON.parse" || path === "JSON.stringify" || path === "Promise.all") return false;
    if (path && path.startsWith("Math.") && MATH_METHODS.has(path.slice("Math.".length))) return false;
    if (path === "String" || path === "Number" || path === "Boolean") return false;
    report(node, "DYN_UNSUPPORTED_CALL", `Call '${path ?? node.expression.getText(sourceFile)}' is not supported.`);
    return false;
  };

  const checkExpression = (node: ts.Expression, arrowAllowed = false): void => {
    if (ts.isIdentifier(node)) {
      if (FORBIDDEN_GLOBALS.has(node.text)) report(node, "DYN_FORBIDDEN_GLOBAL", `Ambient global '${node.text}' is not available.`);
      return;
    }
    if (ts.isCallExpression(node)) {
      const arrowAllowed = checkCall(node);
      checkExpression(node.expression);
      for (const argument of node.arguments) checkExpression(argument, arrowAllowed);
      return;
    }
    if (ts.isArrowFunction(node)) {
      if (!arrowAllowed) report(node, "DYN_UNSUPPORTED_SYNTAX", "Arrow functions are supported only as map/filter callbacks.");
      for (const parameter of node.parameters) {
        checkBindingPattern(parameter.name);
        if (parameter.type) checkTypeSyntax(parameter.type);
        if (parameter.dotDotDotToken) report(parameter, "DYN_UNSUPPORTED_SYNTAX", "Rest parameters are not supported.");
      }
      if (node.type) checkTypeSyntax(node.type);
      if (ts.isBlock(node.body)) checkStatement(node.body); else checkExpression(node.body);
      return;
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (FORBIDDEN_PROPERTIES.has(node.name.text)) report(node.name, "DYN_FORBIDDEN_PROPERTY", `Property '${node.name.text}' is forbidden.`);
      checkExpression(node.expression); return;
    }
    if (ts.isElementAccessExpression(node)) {
      const property = propertyName(node);
      if (property && FORBIDDEN_PROPERTIES.has(property)) report(node, "DYN_FORBIDDEN_PROPERTY", `Property '${property}' is forbidden.`);
      checkExpression(node.expression); if (node.argumentExpression) checkExpression(node.argumentExpression); return;
    }
    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.CommaToken) {
        checkExpression(node.left); checkExpression(node.right); return;
      }
      if (!isSupportedBinaryOperator(node.operatorToken.kind)) report(node.operatorToken, "DYN_UNSUPPORTED_SYNTAX", "This binary operator is not supported.");
      checkExpression(node.left); checkExpression(node.right); return;
    }
    if (ts.isPrefixUnaryExpression(node)) {
      if (![ts.SyntaxKind.ExclamationToken, ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken,
           ts.SyntaxKind.TildeToken, ts.SyntaxKind.TypeOfKeyword, ts.SyntaxKind.VoidKeyword].includes(node.operator)) {
        report(node, "DYN_UNSUPPORTED_SYNTAX", "This unary operator is not supported.");
      }
      checkExpression(node.operand); return;
    }
    if (ts.isPostfixUnaryExpression(node)) {
      if (node.operator !== ts.SyntaxKind.PlusPlusToken && node.operator !== ts.SyntaxKind.MinusMinusToken) report(node, "DYN_UNSUPPORTED_SYNTAX", "Only ++ and -- updates are supported.");
      checkExpression(node.operand); return;
    }
    if (ts.isConditionalExpression(node)) { checkExpression(node.condition); checkExpression(node.whenTrue); checkExpression(node.whenFalse); return; }
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) {
      checkTypeSyntax(node.type);
      checkExpression(node.expression); return;
    }
    if (ts.isTypeOfExpression(node) || ts.isVoidExpression(node)) { checkExpression(node.expression); return; }
    if (ts.isSpreadElement(node)) { checkExpression(node.expression); return; }
    if (ts.isCommaListExpression(node)) { for (const element of node.elements) checkExpression(element); return; }
    if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) || ts.isNonNullExpression(node)) {
      checkExpression(node.expression); return;
    }
    if (ts.isArrayLiteralExpression(node)) { for (const element of node.elements) checkExpression(element); return; }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) {
          if (ts.isComputedPropertyName(property.name)) report(property.name, "DYN_UNSUPPORTED_SYNTAX", "Computed object keys are not supported.");
          else if ((ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) && FORBIDDEN_PROPERTIES.has(property.name.text)) {
            report(property.name, "DYN_FORBIDDEN_PROPERTY", "Prototype-related object keys are forbidden.");
          }
          checkExpression(property.initializer);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          if (FORBIDDEN_PROPERTIES.has(property.name.text)) report(property.name, "DYN_FORBIDDEN_PROPERTY", `Property '${property.name.text}' is forbidden.`);
          checkExpression(property.name);
        } else if (ts.isSpreadAssignment(property)) {
          checkExpression(property.expression);
        } else report(property, "DYN_UNSUPPORTED_SYNTAX", "Object methods and accessors are not supported.");
      }
      return;
    }
    if (ts.isTemplateExpression(node)) { for (const span of node.templateSpans) checkExpression(span.expression); return; }
    if (ts.isTaggedTemplateExpression(node)) { report(node, "DYN_UNSUPPORTED_SYNTAX", "Tagged templates are not supported."); return; }
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) ||
        node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return;
    report(node, "DYN_UNSUPPORTED_SYNTAX", `Expression '${ts.SyntaxKind[node.kind]}' is not supported.`);
  };

  for (const statement of sourceFile.statements) checkStatement(statement, true);
  const schemasResult = synthesizeDynamicSchemas(sourceFile, diagnostics);
  for (const [start, schema] of schemasResult) schemas.set(start, schema);
  return { source, sourceFile, diagnostics, sites, schemas };
}

function isSupportedBinaryOperator(kind: ts.SyntaxKind): boolean {
  return [
    ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken,
    ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken,
    ts.SyntaxKind.AsteriskAsteriskEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken,
    ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken,
    ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken,
    ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken, ts.SyntaxKind.AsteriskAsteriskToken,
    ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
    ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
    ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken,
    ts.SyntaxKind.InKeyword, ts.SyntaxKind.CommaToken,
  ].includes(kind);
}
