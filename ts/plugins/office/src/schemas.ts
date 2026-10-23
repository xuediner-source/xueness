/** The model-visible parameter schemas, exactly as the Python BuiltinTools publish them. */
import type { JsonSchema } from "@xueness/contracts";

const PARAGRAPHS = { type: "array", items: { type: "object", properties: { text: { type: "string" }, style: { type: "string" }, bold: { type: "boolean" }, italic: { type: "boolean" } }, required: ["text"], additionalProperties: false } };
const TABLES = { type: "array", items: { type: "object", properties: { rows: { type: "array", items: { type: "array", items: { type: "string" } } } }, required: ["rows"], additionalProperties: false } };
const SLIDES = { type: "array", items: { type: "object", properties: { title: { type: "string" }, paragraphs: { type: "array", items: { type: "string" } }, bullets: { type: "array", items: { type: "string" } } }, additionalProperties: false } };
const SHEETS = { type: "array", items: { type: "object", properties: { name: { type: "string" }, rows: { type: "array", items: { type: "array", items: { type: ["string", "number", "boolean", "null"] } } } }, required: ["name", "rows"], additionalProperties: false } };
const DOCUMENT = { type: "object", properties: { title: { type: "string" }, paragraphs: PARAGRAPHS, tables: TABLES, slides: SLIDES, sheets: SHEETS }, additionalProperties: false };
const FORMAT = { type: "string", enum: ["docx", "pptx", "xlsx", "pdf"] };
const tool = (properties: Record<string, unknown>, required: string[]): JsonSchema => ({ type: "object", properties, required, additionalProperties: false }) as JsonSchema;

export const MODEL_SCHEMAS = {
  office_read: tool({ path: { type: "string", description: "Workspace-relative Office file path" } }, ["path"]),
  office_create: tool({ path: { type: "string" }, format: FORMAT, document: DOCUMENT }, ["path", "format", "document"]),
  office_replace: tool({ path: { type: "string" }, format: FORMAT, expected_sha256: { type: "string", description: "sha256 returned by office_read for this exact path in the current session" }, document: DOCUMENT }, ["path", "format", "expected_sha256", "document"]),
} as const;
