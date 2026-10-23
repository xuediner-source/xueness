/**
 * Input validation as the model sees it, after ZCode v3.15.1 (aac4755, Apache-2.0)
 * `core/src/tool/input-validation-model-content.ts` (formatToolInputValidationError)
 * and the semantic coercions of `contracts/src/tools/bash.ts`.
 */
import { validateSchema, type JsonSchema } from "@xueness/contracts";

type Row = Record<string, unknown>;
const TRUE_BOOLEAN_STRINGS = new Set(["true", "1", "yes", "y", "on"]);
const FALSE_BOOLEAN_STRINGS = new Set(["false", "0", "no", "n", "off"]);

/** ZCode `semanticNumber`: a numeric string becomes a number. */
export function semanticNumber(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : value;
}

/** ZCode `semanticBoolean`: 1/0 and yes/no style strings become booleans. */
export function semanticBoolean(value: unknown): unknown {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : value;
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (TRUE_BOOLEAN_STRINGS.has(normalized)) return true;
  if (FALSE_BOOLEAN_STRINGS.has(normalized)) return false;
  return value;
}

function typeName(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isNaN(value) ? "nan" : "number";
  return typeof value;
}

/** JSON Pointer → ZCode path text: `todos[0].content`. */
function pathText(pointer: string): string {
  const parts = pointer.split("/").slice(1).map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  return parts.reduce((text, part, index) => /^\d+$/.test(part) ? `${text}[${part}]` : index === 0 ? part : `${text}.${part}`, "");
}

function valueAt(root: unknown, pointer: string): unknown {
  let value = root;
  for (const part of pointer.split("/").slice(1)) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Row)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return value;
}

/**
 * The ZCode model text for an invalid input, or null when it is valid. Missing,
 * unexpected and wrongly typed parameters get ZCode's sentences; any other issue
 * is listed as JSON, as ZCode does for zod issues it has no sentence for.
 */
export function inputValidationError(toolName: string, schema: JsonSchema, input: unknown): string | null {
  const issues = validateSchema(schema, input);
  if (!issues.length) return null;
  const missing: string[] = [];
  const unexpected: string[] = [];
  const wrong: string[] = [];
  const other: { path: string; message: string }[] = [];
  for (const issue of issues) {
    if (issue.message === "is required") missing.push(pathText(issue.path));
    else if (issue.message === "is not allowed") unexpected.push(pathText(issue.path));
    else if (/^must be [a-z]+( or [a-z]+)*$/.test(issue.message)) {
      const expected = issue.message.slice("must be ".length).split(" or ")[0];
      wrong.push(`The parameter \`${pathText(issue.path)}\` type is expected as \`${expected}\` but provided as \`${typeName(valueAt(input, issue.path))}\``);
    } else other.push({ path: pathText(issue.path), message: issue.message });
  }
  const lines = [
    ...missing.map((name) => `The required parameter \`${name}\` is missing`),
    ...unexpected.map((name) => `An unexpected parameter \`${name}\` was provided`),
    ...wrong,
  ];
  const body = lines.length
    ? `${toolName} failed due to the following ${lines.length > 1 ? "issues" : "issue"}:\n${lines.join("\n")}`
    : JSON.stringify(other, null, 2);
  return `<tool_use_error>InputValidationError: ${body}</tool_use_error>`;
}
