/**
 * A small JSON Schema (2020-12) subset for tool inputs and HTTP bodies.
 *
 * Supported: type, properties, required, additionalProperties, anyOf,
 * items, enum, const, minimum, maximum, minLength, maxLength, minItems,
 * maxItems, pattern. Annotations such as title, description and default are
 * kept for model-facing tool definitions and ignored by validation.
 * `schemaShapeIssues` refuses any other keyword, so a schema never looks
 * stricter than what is actually enforced.
 */

export type JsonSchemaType = "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";

export interface JsonSchema {
  type?: JsonSchemaType | readonly JsonSchemaType[];
  title?: string;
  description?: string;
  default?: unknown;
  properties?: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  additionalProperties?: boolean | JsonSchema;
  anyOf?: readonly JsonSchema[];
  items?: JsonSchema;
  enum?: readonly unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
}

export interface SchemaIssue {
  /** JSON Pointer to the offending value ("" is the root). */
  path: string;
  message: string;
}

function typeOf(value: unknown): JsonSchemaType | "undefined" {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "object") return typeof value as JsonSchemaType;
  return "undefined";
}

function matchesType(value: unknown, expected: JsonSchemaType): boolean {
  const actual = typeOf(value);
  return actual === expected || (expected === "number" && actual === "integer");
}

function pointer(base: string, key: string | number): string {
  return `${base}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function checkScalar(schema: JsonSchema, value: unknown, path: string, issues: SchemaIssue[]): void {
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) issues.push({ path, message: `must be >= ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) issues.push({ path, message: `must be <= ${schema.maximum}` });
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) issues.push({ path, message: `must have at least ${schema.minLength} characters` });
    if (schema.maxLength !== undefined && length > schema.maxLength) issues.push({ path, message: `must have at most ${schema.maxLength} characters` });
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) issues.push({ path, message: `must match ${schema.pattern}` });
  }
}

function checkObject(schema: JsonSchema, value: Record<string, unknown>, path: string, issues: SchemaIssue[]): void {
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(value, key)) issues.push({ path: pointer(path, key), message: "is required" });
  }
  const properties = schema.properties ?? {};
  for (const [key, item] of Object.entries(value)) {
    const child = Object.hasOwn(properties, key) ? properties[key] : undefined;
    if (child) visit(child, item, pointer(path, key), issues);
    else if (schema.additionalProperties === false) issues.push({ path: pointer(path, key), message: "is not allowed" });
    else if (typeof schema.additionalProperties === "object") visit(schema.additionalProperties, item, pointer(path, key), issues);
  }
}

function visit(schema: JsonSchema, value: unknown, path: string, issues: SchemaIssue[]): void {
  if (schema.anyOf && !schema.anyOf.some((branch) => validateSchema(branch, value).length === 0)) {
    issues.push({ path, message: "must match one of the allowed schemas" });
    return;
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type as JsonSchemaType];
    if (!types.some((type) => matchesType(value, type))) {
      issues.push({ path, message: `must be ${types.join(" or ")}` });
      return;
    }
  }
  if (schema.const !== undefined && !sameJson(schema.const, value)) issues.push({ path, message: "must equal the constant" });
  if (schema.enum !== undefined && !schema.enum.some((option) => sameJson(option, value))) {
    issues.push({ path, message: `must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}` });
  }
  checkScalar(schema, value, path, issues);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) issues.push({ path, message: `must have at least ${schema.minItems} items` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push({ path, message: `must have at most ${schema.maxItems} items` });
    if (schema.items) value.forEach((item, index) => visit(schema.items as JsonSchema, item, pointer(path, index), issues));
  } else if (typeOf(value) === "object") {
    checkObject(schema, value as Record<string, unknown>, path, issues);
  }
}

/** Validate `value`; an empty list means it conforms. */
export function validateSchema(schema: JsonSchema, value: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  visit(schema, value, "", issues);
  return issues;
}

/** One readable line per issue, suitable for a tool error returned to a model. */
export function formatSchemaIssues(issues: readonly SchemaIssue[]): string {
  return issues.map((issue) => `${issue.path || "(input)"} ${issue.message}`).join("; ");
}

const TYPES: readonly string[] = ["string", "number", "integer", "boolean", "object", "array", "null"];
const COUNTS = ["minLength", "maxLength", "minItems", "maxItems"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkKeyword(key: string, value: unknown, at: string, issues: SchemaIssue[]): void {
  const fail = (message: string): void => void issues.push({ path: at, message });
  switch (key) {
    case "type": {
      const list = Array.isArray(value) ? value : [value];
      if (!list.length || list.some((item) => typeof item !== "string" || !TYPES.includes(item)) || new Set(list).size !== list.length) fail("must name JSON types");
      return;
    }
    case "title": case "description": if (typeof value !== "string") fail("must be a string"); return;
    case "default": case "const": return;
    case "properties":
      if (!isRecord(value)) return fail("must be an object");
      for (const [name, child] of Object.entries(value)) issues.push(...schemaShapeIssues(child, pointer(at, name)));
      return;
    case "required":
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string") || new Set(value).size !== value.length) fail("must be unique strings");
      return;
    case "additionalProperties":
      if (typeof value !== "boolean") issues.push(...schemaShapeIssues(value, at));
      return;
    case "anyOf":
      if (!Array.isArray(value) || !value.length) return fail("must be a non-empty array of schemas");
      value.forEach((child, index) => issues.push(...schemaShapeIssues(child, pointer(at, index))));
      return;
    case "items": issues.push(...schemaShapeIssues(value, at)); return;
    case "enum": if (!Array.isArray(value) || !value.length) fail("must be a non-empty array"); return;
    case "minimum": case "maximum": if (typeof value !== "number" || !Number.isFinite(value)) fail("must be a number"); return;
    case "pattern":
      try {
        if (typeof value !== "string") throw new TypeError("not a string");
        new RegExp(value, "u");
      } catch {
        fail("must be a valid regular expression");
      }
      return;
    default:
      if ((COUNTS as readonly string[]).includes(key)) {
        if (!Number.isSafeInteger(value) || (value as number) < 0) fail("must be a non-negative integer");
      } else fail("is not a supported schema keyword");
  }
}

/** Problems with a schema itself; empty when every keyword is one `validateSchema` enforces. */
export function schemaShapeIssues(schema: unknown, path = ""): SchemaIssue[] {
  if (!isRecord(schema)) return [{ path, message: "must be a schema object" }];
  const issues: SchemaIssue[] = [];
  for (const [key, value] of Object.entries(schema)) checkKeyword(key, value, pointer(path, key), issues);
  return issues;
}
