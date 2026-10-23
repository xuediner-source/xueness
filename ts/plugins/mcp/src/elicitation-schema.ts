/**
 * Flat elicitation schemas (Python `elicitation.py` normalize / validate).
 * Nested values, password-like names, and over-limit fields are declined.
 */
import { isDict, isPyFloatValue, isPyIntValue, isPyNumeric, numericValue, pyCasefold } from "@xueness/contracts";
import { pyUrlSplit } from "@xueness/providers";

const MAX_MESSAGE = 2000, MAX_PROPERTIES = 16, MAX_ENUM = 32, MAX_STRING = 4000, MAX_TITLE = 120, MAX_DESCRIPTION = 400, MAX_ENUM_VALUE = 200;
const FORMATS = new Set(["email", "uri", "date", "date-time"]);
const PASSWORD = new Set(["password", "secret", "token", "credential", "api-key", "apikey", "api_key", "passwd", "passphrase"]);
const NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
type Row = Record<string, unknown>;
type Pair = [Row | null, string | null];
const fail = (code: string): Pair => [null, code];

function passwordToken(value: string): boolean {
  const folded = pyCasefold(value);
  const token = folded.replace(/ /g, "").replace(/-/g, "").replace(/_/g, "");
  const stripped = new Set([...PASSWORD].map((item) => item.replace(/-/g, "").replace(/_/g, "")));
  return PASSWORD.has(folded) || stripped.has(token) || folded.includes("password") || folded.includes("passwd") || folded.includes("passphrase");
}

function finiteNumber(value: unknown): number | null {
  if (!isPyNumeric(value) || typeof value === "bigint") return null;
  const number = numericValue(value);
  return number !== null && Number.isFinite(number) ? number : null;
}

function sharedText(spec: Row, allowed: ReadonlySet<string>): Pair {
  if (Object.keys(spec).some((key) => !allowed.has(key))) return fail("invalid_schema");
  const extra: Row = {};
  for (const [key, limit] of [["title", MAX_TITLE], ["description", MAX_DESCRIPTION]] as const) {
    if (!(key in spec)) continue;
    const text = spec[key];
    if (typeof text !== "string" || !text.trim() || text.length > limit) return fail(typeof text === "string" && text.length > limit ? "over_limit" : "invalid_schema");
    extra[key] = text;
  }
  return [extra, null];
}

function lengthBounds(spec: Row): Pair {
  const bounds: Row = {};
  for (const key of ["minLength", "maxLength"] as const) {
    if (!(key in spec)) continue;
    const value = spec[key];
    if (typeof value === "boolean" || !isPyIntValue(value) || Number(value) < 0 || Number(value) > MAX_STRING) {
      return fail(isPyIntValue(value) && typeof value !== "boolean" && Number(value) > MAX_STRING ? "over_limit" : "invalid_schema");
    }
    bounds[key] = Number(value);
  }
  if (Number(bounds.minLength ?? 0) > Number(bounds.maxLength ?? MAX_STRING)) return fail("invalid_schema");
  return [bounds, null];
}

function normalizeString(spec: Row): Pair {
  const [extra, code] = sharedText(spec, new Set(["type", "title", "description", "format", "minLength", "maxLength"]));
  if (code || !extra) return fail(code ?? "invalid_schema");
  const field: Row = { type: "string", ...extra };
  if ("format" in spec) {
    const fmt = spec.format;
    if (typeof fmt !== "string") return fail("invalid_schema");
    if (passwordToken(fmt) || pyCasefold(fmt).includes("password")) return fail("password_format");
    if (!FORMATS.has(fmt)) return fail("invalid_schema");
    field.format = fmt;
  }
  const [bounds, boundCode] = lengthBounds(spec);
  if (boundCode || !bounds) return fail(boundCode ?? "invalid_schema");
  return [{ ...field, ...bounds }, null];
}

function normalizeEnum(spec: Row): Pair {
  const [extra, code] = sharedText(spec, new Set(["type", "title", "description", "enum", "enumNames"]));
  if (code || !extra) return fail(code ?? "invalid_schema");
  const values = spec.enum;
  if (!Array.isArray(values) || !values.length || values.length > MAX_ENUM) return fail(Array.isArray(values) ? "over_limit" : "invalid_schema");
  const clean: string[] = [];
  for (const item of values) {
    if (typeof item !== "string" || !item || item.length > MAX_ENUM_VALUE || clean.includes(item)) return fail(typeof item === "string" && item.length > MAX_ENUM_VALUE ? "over_limit" : "invalid_schema");
    if ([...item].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return fail("invalid_schema");
    clean.push(item);
  }
  const field: Row = { type: "string", enum: clean, ...extra };
  if (!("enumNames" in spec)) return [field, null];
  const names = spec.enumNames;
  if (!Array.isArray(names) || names.length !== clean.length) return fail("invalid_schema");
  const labels: string[] = [];
  for (const item of names) {
    if (typeof item !== "string" || !item.trim() || item.length > MAX_ENUM_VALUE) return fail(typeof item === "string" && item.length > MAX_ENUM_VALUE ? "over_limit" : "invalid_schema");
    labels.push(item);
  }
  return [{ ...field, enumNames: labels }, null];
}

function normalizeNumber(spec: Row, kind: string): Pair {
  const [extra, code] = sharedText(spec, new Set(["type", "title", "description", "minimum", "maximum"]));
  if (code || !extra) return fail(code ?? "invalid_schema");
  const bounds: Row = {};
  for (const key of ["minimum", "maximum"] as const) {
    if (!(key in spec)) continue;
    const number = finiteNumber(spec[key]);
    if (number === null || Math.abs(number) > 1e12) return fail(finiteNumber(spec[key]) !== null ? "over_limit" : "invalid_schema");
    bounds[key] = isPyFloatValue(spec[key]) ? number : spec[key];
  }
  if ("minimum" in bounds && "maximum" in bounds && Number(bounds.minimum) > Number(bounds.maximum)) return fail("invalid_schema");
  return [{ type: kind, ...extra, ...bounds }, null];
}

function normalizeField(spec: unknown): Pair {
  if (!isDict(spec)) return fail("invalid_schema");
  if (typeof spec.title === "string" && passwordToken(spec.title)) return fail("password_format");
  if (spec.type === "string" && "enum" in spec) return normalizeEnum(spec);
  if (spec.type === "string") return normalizeString(spec);
  if (spec.type === "number" || spec.type === "integer") return normalizeNumber(spec, spec.type);
  if (spec.type === "boolean") {
    const [extra, code] = sharedText(spec, new Set(["type", "title", "description"]));
    return code || !extra ? fail(code ?? "invalid_schema") : [{ type: "boolean", ...extra }, null];
  }
  return fail("invalid_schema");
}

/** Python `_normalize_schema`: `[schema, null]` or `[null, code]`. */
export function normalizeSchema(schema: unknown): [Row | null, string | null] {
  if (!isDict(schema)) return fail("invalid_schema");
  const allowed = new Set(["type", "properties", "required", "additionalProperties", "title", "description"]);
  if (Object.keys(schema).some((key) => !allowed.has(key))) return fail("invalid_schema");
  if (schema.type !== "object") return fail("invalid_schema");
  if ("additionalProperties" in schema && schema.additionalProperties !== false) return fail("invalid_schema");
  const properties = schema.properties;
  if (!isDict(properties) || Object.keys(properties).length > MAX_PROPERTIES) return fail(isDict(properties) ? "over_limit" : "invalid_schema");
  const normalized: Row = {};
  for (const [name, spec] of Object.entries(properties)) {
    if (!NAME.test(name)) return fail("invalid_schema");
    if (passwordToken(name)) return fail("password_format");
    const [field, code] = normalizeField(spec);
    if (code || !field) return fail(code ?? "invalid_schema");
    normalized[name] = field;
  }
  let required = schema.required === undefined ? [] : schema.required;
  if (required === null) required = [];
  if (!Array.isArray(required) || required.length > Object.keys(normalized).length) return fail("invalid_schema");
  const seen = new Set<string>();
  for (const item of required) {
    if (typeof item !== "string" || !(item in normalized) || seen.has(item)) return fail("invalid_schema");
    seen.add(item);
  }
  const pub: Row = { type: "object", properties: normalized, required: [...required] };
  for (const [key, limit] of [["title", MAX_TITLE], ["description", MAX_DESCRIPTION]] as const) {
    if (!(key in schema)) continue;
    const text = schema[key];
    if (typeof text !== "string" || !text.trim() || text.length > limit) return fail(typeof text === "string" && text.length > limit ? "over_limit" : "invalid_schema");
    pub[key] = text;
  }
  return [pub, null];
}

export function validateRequested(params: unknown): [Row | null, string | null, string | null] {
  if (!isDict(params)) return [null, null, "invalid_schema"];
  const message = params.message;
  if (typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE) return [null, null, typeof message === "string" && message.length > MAX_MESSAGE ? "over_limit" : "invalid_schema"];
  if ([...message].some((char) => { const code = char.charCodeAt(0); return code < 32 && char !== "\n" && char !== "\t" || code === 127; })) return [null, null, "invalid_schema"];
  const [schema, code] = normalizeSchema(params.requestedSchema);
  return code || !schema ? [null, null, code ?? "invalid_schema"] : [schema, message, null];
}

function formatOk(fmt: string, value: string): boolean {
  if (!value) return false;
  if (fmt === "email") {
    if (value.length > 254 || [...value].some((char) => /\s/u.test(char)) || value.split("@").length !== 2) return false;
    const at = value.indexOf("@");
    const local = value.slice(0, at), domain = value.slice(at + 1);
    return !!local && !!domain && domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
  }
  if (fmt === "uri") {
    if ([...value].some((char) => /\s/u.test(char))) return false;
    const parts = pyUrlSplit(value);
    return !!parts.scheme && /^[A-Za-z][A-Za-z0-9+.-]*$/.test(parts.scheme) && !!(parts.netloc || parts.path);
  }
  if (fmt === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year!, month! - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
  }
  if (fmt === "date-time") {
    const text = value.endsWith("Z") ? `${value.slice(0, -1)}+00:00` : value;
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value) && !Number.isNaN(Date.parse(text));
  }
  return false;
}

function checkValue(spec: Row, value: unknown): [unknown, string | null] {
  if ("enum" in spec) return typeof value === "string" && Array.isArray(spec.enum) && spec.enum.includes(value) ? [value, null] : [null, "enum"];
  if (spec.type === "string") {
    if (typeof value !== "string" || value.includes("\u0000")) return [null, "type"];
    const min = Number(spec.minLength ?? 0), max = Number(spec.maxLength ?? MAX_STRING);
    if (value.length < min || value.length > max) return [null, "length"];
    if (typeof spec.format === "string" && !formatOk(spec.format, value)) return [null, "format"];
    return [value, null];
  }
  if (spec.type === "number" || spec.type === "integer") {
    if (typeof value === "boolean" || !isPyNumeric(value) || typeof value === "bigint" || !Number.isFinite(numericValue(value) ?? Number.NaN)) return [null, "type"];
    if (spec.type === "integer" && !isPyIntValue(value)) return [null, "type"];
    const number = spec.type === "integer" || isPyIntValue(value) ? Number(value) : numericValue(value)!;
    if ("minimum" in spec && number < Number(spec.minimum)) return [null, "range"];
    if ("maximum" in spec && number > Number(spec.maximum)) return [null, "range"];
    return [isPyIntValue(value) ? Number(value) : number, null];
  }
  if (spec.type === "boolean") return typeof value === "boolean" ? [value, null] : [null, "type"];
  return [null, "type"];
}

/** Python `validate_content`: `[clean, null, null]` or `[null, code, field]`. */
export function validateContent(schema: unknown, content: unknown): [Row | null, string | null, string | null] {
  if (!isDict(schema) || !isDict(content)) return [null, "type", null];
  const properties = schema.properties;
  if (!isDict(properties)) return [null, "type", null];
  const required = Array.isArray(schema.required) ? schema.required : [];
  const clean: Row = {};
  for (const [name, spec] of Object.entries(properties)) {
    if (!(name in content)) { if (required.includes(name)) return [null, "required", name]; continue; }
    if (content[name] === null || !isDict(spec)) return [null, "type", name];
    const [checked, code] = checkValue(spec, content[name]);
    if (code) return [null, code, name];
    clean[name] = checked;
  }
  const extra = Object.keys(content).filter((key) => !(key in properties));
  if (extra.length) return [null, "unexpected", typeof extra[0] === "string" && extra[0].length <= 64 ? extra[0] : null];
  return [clean, null, null];
}
