import * as ts from "typescript";
import type { JsonSchema } from "@xueness/contracts";
import type { DynamicDiagnostic } from "./dynamic-types.ts";

type TypeDeclaration = ts.InterfaceDeclaration | ts.TypeAliasDeclaration;
type ExtensibleSchema = Omit<JsonSchema, "additionalProperties"> & { anyOf?: JsonSchema[]; additionalProperties?: boolean | JsonSchema };

function asSchema(schema: ExtensibleSchema): JsonSchema {
  return schema as unknown as JsonSchema;
}

function namedType(type: ts.TypeNode): string | undefined {
  return ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) ? type.typeName.text : undefined;
}

export function synthesizeDynamicSchemas(
  sourceFile: ts.SourceFile,
  diagnostics: DynamicDiagnostic[],
): Map<number, JsonSchema> {
  const declarations = new Map<string, TypeDeclaration>();
  const resolving = new Set<string>();
  const cache = new Map<string, JsonSchema>();
  const schemas = new Map<number, JsonSchema>();

  const report = (node: ts.Node, message: string): void => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    diagnostics.push({ code: "DYN_UNSUPPORTED_TYPE", message, line: line + 1, column: character + 1 });
  };

  for (const statement of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      if (declarations.has(statement.name.text)) report(statement.name, `Duplicate type declaration '${statement.name.text}'.`);
      else declarations.set(statement.name.text, statement);
    }
  }

  const resolveName = (name: string, at: ts.Node): JsonSchema | undefined => {
    if (resolving.has(name)) {
      report(at, `Circular type '${name}' is not supported.`);
      return undefined;
    }
    const cached = cache.get(name);
    if (cached) return cached;
    const declaration = declarations.get(name);
    if (!declaration) {
      report(at, `Unknown type '${name}'.`);
      return undefined;
    }
    if (declaration.typeParameters?.length) {
      report(declaration, `Generic declaration '${name}' is not supported.`);
      return undefined;
    }
    const diagnosticCount = diagnostics.length;
    resolving.add(name);
    const schema = ts.isInterfaceDeclaration(declaration)
      ? interfaceSchema(declaration)
      : visitType(declaration.type);
    resolving.delete(name);
    if (schema && diagnostics.length === diagnosticCount) cache.set(name, schema);
    return diagnostics.length === diagnosticCount ? schema : undefined;
  };

  const objectSchema = (members: readonly ts.TypeElement[], at: ts.Node, bases: JsonSchema[] = []): JsonSchema | undefined => {
    const properties: Record<string, JsonSchema> = {};
    const required = new Set<string>();
    for (const base of bases) {
      if (base.type !== "object" || !base.properties) {
        report(at, "Interface extends must name an object interface or alias.");
        continue;
      }
      Object.assign(properties, base.properties);
      for (const name of base.required ?? []) required.add(name);
    }
    for (const member of members) {
      if (!ts.isPropertySignature(member) || !member.type || !member.name ||
          (!ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name) && !ts.isNumericLiteral(member.name))) {
        report(member, "Only named, typed properties are supported in object types.");
        continue;
      }
      const name = member.name.text;
      const propertySchema = visitType(member.type);
      if (!propertySchema) continue;
      properties[name] = propertySchema;
      if (!member.questionToken) required.add(name);
      else required.delete(name);
    }
    return { type: "object", properties, required: [...required], additionalProperties: false };
  };

  const literalValue = (type: ts.TypeNode): { kind: "string" | "number" | "boolean" | "null"; value: unknown } | undefined => {
    if (!ts.isLiteralTypeNode(type)) return undefined;
    const literal = type.literal;
    if (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal)) return { kind: "string", value: literal.text };
    if (ts.isNumericLiteral(literal)) return { kind: "number", value: Number(literal.text.replaceAll("_", "")) };
    if (literal.kind === ts.SyntaxKind.TrueKeyword) return { kind: "boolean", value: true };
    if (literal.kind === ts.SyntaxKind.FalseKeyword) return { kind: "boolean", value: false };
    if (literal.kind === ts.SyntaxKind.NullKeyword) return { kind: "null", value: null };
    if (ts.isPrefixUnaryExpression(literal) && (literal.operator === ts.SyntaxKind.MinusToken || literal.operator === ts.SyntaxKind.PlusToken) && ts.isNumericLiteral(literal.operand)) {
      const value = Number(literal.operand.text.replaceAll("_", "")) * (literal.operator === ts.SyntaxKind.MinusToken ? -1 : 1);
      return { kind: "number", value };
    }
    return undefined;
  };

  const visitType = (type: ts.TypeNode): JsonSchema | undefined => {
    switch (type.kind) {
      case ts.SyntaxKind.StringKeyword: return { type: "string" };
      case ts.SyntaxKind.NumberKeyword: return { type: "number" };
      case ts.SyntaxKind.BooleanKeyword: return { type: "boolean" };
      case ts.SyntaxKind.NullKeyword: return { type: "null" };
      case ts.SyntaxKind.AnyKeyword:
      case ts.SyntaxKind.UnknownKeyword:
      case ts.SyntaxKind.NeverKeyword:
        report(type, `${ts.SyntaxKind[type.kind].replace("Keyword", "")} types are not supported.`);
        return undefined;
      default: break;
    }

    if (ts.isLiteralTypeNode(type)) {
      const literal = literalValue(type);
      if (!literal) {
        report(type, "Only string, number, boolean, and null literal types are supported.");
        return undefined;
      }
      return { type: literal.kind, const: literal.value };
    }
    if (ts.isUnionTypeNode(type)) {
      const members = type.types;
      const literalMembers = members.map(literalValue);
      if (literalMembers.every((item) => item !== undefined)) {
        const values = literalMembers.map((item) => item!.value);
        const kinds = [...new Set(literalMembers.map((item) => item!.kind))];
        if (kinds.length === 1) return { type: kinds[0], enum: [...new Set(values)] };
      }
      const branches = members.map(visitType);
      if (branches.some((item) => !item)) return undefined;
      return asSchema({ anyOf: branches as JsonSchema[] });
    }
    if (ts.isArrayTypeNode(type)) {
      const item = visitType(type.elementType);
      return item ? { type: "array", items: item } : undefined;
    }
    if (ts.isTypeLiteralNode(type)) return objectSchema(type.members, type);
    if (ts.isFunctionTypeNode(type) || ts.isConstructorTypeNode(type)) {
      report(type, "Function types are not supported.");
      return undefined;
    }
    if (ts.isTypeReferenceNode(type)) {
      const name = namedType(type);
      if (!name) {
        report(type, "Qualified type names are not supported.");
        return undefined;
      }
      if (name === "Date" || name === "Function") {
        report(type, `Type '${name}' is not supported.`);
        return undefined;
      }
      if (name === "Array") {
        if (type.typeArguments?.length !== 1) {
          report(type, "Array<T> requires exactly one type argument.");
          return undefined;
        }
        const item = visitType(type.typeArguments[0]!);
        return item ? { type: "array", items: item } : undefined;
      }
      if (name === "Record") {
        if (type.typeArguments?.length !== 2 || type.typeArguments[0]?.kind !== ts.SyntaxKind.StringKeyword) {
          report(type, "Only Record<string, T> is supported.");
          return undefined;
        }
        const value = visitType(type.typeArguments[1]!);
        return value ? asSchema({ type: "object", additionalProperties: value }) : undefined;
      }
      if (type.typeArguments?.length) {
        report(type, `Type arguments on '${name}' are not supported.`);
        return undefined;
      }
      return resolveName(name, type);
    }
    report(type, `Type syntax '${ts.SyntaxKind[type.kind]}' is not supported.`);
    return undefined;
  };

  // Bind mutual references to the resolver without relying on TypeScript program checking.
  const interfaceSchema = (declaration: ts.InterfaceDeclaration): JsonSchema | undefined => {
    const bases: JsonSchema[] = [];
    for (const heritage of declaration.heritageClauses ?? []) {
      if (heritage.token !== ts.SyntaxKind.ExtendsKeyword) {
        report(heritage, "Only interface extends clauses are supported.");
        continue;
      }
      for (const type of heritage.types) {
        if (!ts.isIdentifier(type.expression) || type.typeArguments?.length) {
          report(type, "Interface extends must name a non-generic type.");
          continue;
        }
        const base = resolveName(type.expression.text, type);
        if (base) bases.push(base);
      }
    }
    return objectSchema(declaration.members, declaration, bases);
  };

  const findAskTypes = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isAskCall(node)) {
      if (node.typeArguments?.length === 1) {
        const diagnosticCount = diagnostics.length;
        const schema = visitType(node.typeArguments[0]!);
        if (schema && diagnostics.length === diagnosticCount) schemas.set(node.getStart(sourceFile), schema);
      } else if ((node.typeArguments?.length ?? 0) > 1) {
        report(node, "ask<T> accepts one schema type argument.");
      }
    }
    ts.forEachChild(node, findAskTypes);
  };

  for (const declaration of declarations.values()) resolveName(declaration.name.text, declaration);
  findAskTypes(sourceFile);
  return schemas;
}

function isAskCall(node: ts.CallExpression): boolean {
  const expression = node.expression;
  if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== "ask") return false;
  return !expression.questionDotToken || expression.questionDotToken.kind === ts.SyntaxKind.QuestionDotToken;
}
