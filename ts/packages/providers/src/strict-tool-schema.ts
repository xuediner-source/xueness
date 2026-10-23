type JsonSchema = Record<string, unknown>;

/** String formats accepted directly by Anthropic strict tool schemas. */
const STRICT_STRING_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

/** Constraints that remain visible to the model as description text. */
const FOLDED_KEYWORDS: Record<string, (value: unknown) => string> = {
  minimum: (value) => `minimum ${String(value)}`,
  maximum: (value) => `maximum ${String(value)}`,
  exclusiveMinimum: (value) => `greater than ${String(value)}`,
  exclusiveMaximum: (value) => `less than ${String(value)}`,
  multipleOf: (value) => `multiple of ${String(value)}`,
  minLength: (value) => `at least ${String(value)} characters`,
  maxLength: (value) => `at most ${String(value)} characters`,
  pattern: (value) => `must match /${String(value)}/`,
  minItems: (value) => `at least ${String(value)} items`,
  maxItems: (value) => `at most ${String(value)} items`,
  default: (value) => `default ${JSON.stringify(value)}`,
};

/** Anthropic strict schemas apply only to bare first-party Claude model IDs. */
export function isAnthropicFirstPartyModelId(modelId: string | undefined): boolean {
  return typeof modelId === "string" && modelId.startsWith("claude-");
}

/**
 * Converts a schema into the strict subset, or returns undefined when its shape
 * cannot be represented without changing its meaning.
 */
export function toStrictToolSchema(schema: JsonSchema): JsonSchema | undefined {
  const output = strictNode(schema);
  return output === INELIGIBLE ? undefined : output;
}

const INELIGIBLE = Symbol("ineligible");
type StrictNode = JsonSchema | typeof INELIGIBLE;

function strictNode(node: JsonSchema): StrictNode {
  if ("$ref" in node || "$defs" in node || "prefixItems" in node) return INELIGIBLE;

  const notes: string[] = [];
  const output: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    const fold = FOLDED_KEYWORDS[key];
    if (fold !== undefined) {
      notes.push(fold(value));
      continue;
    }
    if (key === "format" && typeof value === "string" && !STRICT_STRING_FORMATS.has(value)) {
      notes.push(`format ${value}`);
      continue;
    }
    output[key] = value;
  }

  if (isRecord(output.properties)) {
    const properties: Record<string, JsonSchema> = {};
    for (const [name, child] of Object.entries(output.properties)) {
      if (!isRecord(child)) return INELIGIBLE;
      const strictChild = strictNode(child);
      if (strictChild === INELIGIBLE) return INELIGIBLE;
      properties[name] = strictChild;
    }
    output.properties = properties;
  }
  if (isRecord(output.items)) {
    const items = strictNode(output.items);
    if (items === INELIGIBLE) return INELIGIBLE;
    output.items = items;
  }
  for (const combinator of ["anyOf", "allOf"] as const) {
    const branches = output[combinator];
    if (!Array.isArray(branches)) continue;
    const strictBranches: JsonSchema[] = [];
    for (const branch of branches) {
      if (!isRecord(branch)) return INELIGIBLE;
      const strictBranch = strictNode(branch);
      if (strictBranch === INELIGIBLE) return INELIGIBLE;
      strictBranches.push(strictBranch);
    }
    output[combinator] = strictBranches;
  }

  const types = Array.isArray(output.type) ? output.type : output.type === undefined ? [] : [output.type];
  if (types.includes("object")) {
    if (isRecord(output.additionalProperties)) return INELIGIBLE;
    if (output.additionalProperties !== false) output.additionalProperties = false;
    if (!isRecord(output.properties)) output.properties = {};
  }
  if (Object.keys(output).length === 0 && notes.length === 0) return INELIGIBLE;

  if (notes.length > 0) {
    const existing = typeof output.description === "string" ? output.description.trim() : "";
    const folded = notes.join("; ");
    output.description = existing.length > 0 ? `${existing} (${folded})` : folded;
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
