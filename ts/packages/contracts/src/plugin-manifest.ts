/**
 * Plugin manifest, apiVersion 2: pure data describing one trusted bundled plugin.
 *
 * Version 2 keeps every field of the version 1 manifests in
 * `xueness/bundled_plugins/<id>/manifest.json`, with the same rules as
 * `plugin_contract.py` and `tools/check_plugin_architecture.py`, and adds:
 *   - `capabilities` as structured powers (see plugin-capabilities.ts);
 *   - `tools` as declarations with the Gate kind, `mutating` and
 *     `concurrencySafe`, so permissions are decided without loading code;
 *   - `inject` with required and optional services;
 *   - `config`: a JSON schema and defaults for the plugin's settings.
 *
 * A manifest never names code: `entrypoint` and `command` are refused, as in
 * `plugin_sdk.py`. Unknown fields are refused too, so a typo cannot silently
 * drop a declaration. Validation is a pure function and never throws.
 */
import { schemaShapeIssues, validateSchema, type JsonSchema, type SchemaIssue } from "./json-schema.ts";
import { capabilityIssues, normalizeCapabilities, type Capabilities, type CapabilityDeclaration } from "./plugin-capabilities.ts";

export const MANIFEST_API_VERSION = 2;
export const PLUGIN_ID = /^[a-z][a-z0-9_]*$/;
export const SERVICE_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
export const ROUTE_SEGMENT = /^(?:\*|[a-z][a-z0-9_-]*)$/;
export const ACTION_NAME = /^[a-z][a-z0-9_]*$/;
export const DATA_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
/** A tool name, or a family such as `mcp__*` (a prefix and one trailing `*`). */
export const TOOL_NAME = /^[a-z][a-z0-9_]*\*?$/;
export const GATE_KIND = /^[a-z][a-z0-9_]*$/;
const VERSION = /^\d+\.\d+\.\d+$/;
export const TOOL_EVENT_NAMES = ["before_tool_execution", "after_tool_execution", "after_tool_authorization", "before_tool_effect"] as const;
export const TOOL_EVENT_PRIORITY_BOUNDS = [-1000, 1000] as const;
/** Service names the kernel and the plugin host use themselves. */
export const RESERVED_SERVICE_PREFIXES = ["plugin.", "kernel."] as const;
const FORBIDDEN_FIELDS = ["entrypoint", "command"];

export interface ToolDeclaration {
  name: string;
  /** Python Gate kind the call is checked under (`read`, `write`, `exec`, `mcp`, ...). */
  gate: string;
  /** Changes workspace files: checkpointed and refused in read-only modes. */
  mutating: boolean;
  /** A pure read that may run concurrently with other safe calls. */
  concurrencySafe: boolean;
}

export interface FeatureDeclaration {
  id: string;
  name: string;
  nameEn: string;
}

export interface PluginManifest {
  apiVersion: 2;
  id: string;
  name: string;
  description: string;
  version: string;
  defaultEnabled: boolean;
  dependencies: string[];
  provides: string[];
  inject: { required: string[]; optional: string[] };
  capabilities: Capabilities;
  httpFamilies: string[];
  tools: ToolDeclaration[];
  config: { schema: JsonSchema; default: Record<string, unknown> } | null;
  toolEvents: { events: string[]; priority: number } | null;
  commands: string[];
  panels: string[];
  resources: string[];
  modules: string[];
  frontendModules: string[];
  desktopModules: string[];
  backendAssets: string[];
  dataFiles: string[];
  pluginsActions: string[];
  installPackage: string | null;
  features: FeatureDeclaration[];
}

export interface ManifestResult {
  manifest: PluginManifest | null;
  issues: SchemaIssue[];
}

type Doc = Record<string, unknown>;
type Check = (value: unknown, path: string, issues: SchemaIssue[], doc: Doc) => void;

function isObject(value: unknown): value is Doc {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text: Check = (value, path, issues) => {
  if (typeof value !== "string" || !value.trim()) issues.push({ path, message: "must be a non-empty string" });
};

function strings(valid?: (item: string, doc: Doc) => string | null): Check {
  return (value, path, issues, doc) => {
    if (!Array.isArray(value)) return void issues.push({ path, message: "must be an array of strings" });
    const seen = new Set<string>();
    value.forEach((item, index) => {
      const at = `${path}/${index}`;
      if (typeof item !== "string" || !item) return void issues.push({ path: at, message: "must be a non-empty string" });
      if (seen.has(item)) return void issues.push({ path: at, message: `duplicates ${JSON.stringify(item)}` });
      seen.add(item);
      const problem = valid?.(item, doc);
      if (problem) issues.push({ path: at, message: problem });
    });
  };
}

const matching = (pattern: RegExp, what: string) => (item: string): string | null => (pattern.test(item) ? null : `is not a valid ${what}`);

function routePattern(item: string): string | null {
  const segments = item.split("/");
  return segments[0] === "*" || segments.some((segment) => !ROUTE_SEGMENT.test(segment)) ? "is not a valid route pattern" : null;
}

function relativePath(item: string, prefix = ""): string | null {
  const parts = item.split("/");
  return item.startsWith("/") || /^[A-Za-z]:/.test(item) || parts.includes("..") || !item.startsWith(prefix) ? "is not a safe relative path" : null;
}

function dependency(item: string, doc: Doc): string | null {
  if (!PLUGIN_ID.test(item)) return "is not a valid plugin id";
  return item === doc.id ? "must not depend on the plugin itself" : null;
}

function serviceName(item: string): string | null {
  if (!SERVICE_NAME.test(item)) return "is not a valid service name";
  return RESERVED_SERVICE_PREFIXES.some((prefix) => item.startsWith(prefix)) ? "is reserved for the kernel" : null;
}

const injected = (item: string): string | null =>
  !SERVICE_NAME.test(item) ? "is not a valid service name" : item.startsWith("plugin.") ? "use dependencies to depend on a plugin" : null;

const inject: Check = (value, path, issues, doc) => {
  if (Array.isArray(value)) return strings(injected)(value, path, issues, doc);
  if (!isObject(value)) return void issues.push({ path, message: "must be an array of service names or { required, optional }" });
  for (const [key, list] of Object.entries(value)) {
    if (key === "required" || key === "optional") strings(injected)(list, `${path}/${key}`, issues, doc);
    else issues.push({ path: `${path}/${key}`, message: "is not a known field" });
  }
};

function exactKeys(value: unknown, path: string, keys: readonly string[], issues: SchemaIssue[]): value is Doc {
  if (!isObject(value)) {
    issues.push({ path, message: "must be an object" });
    return false;
  }
  for (const key of Object.keys(value)) if (!keys.includes(key)) issues.push({ path: `${path}/${key}`, message: "is not a known field" });
  return true;
}

const tools: Check = (value, path, issues) => {
  if (!Array.isArray(value)) return void issues.push({ path, message: "must be an array of tool declarations" });
  const names: string[] = [];
  value.forEach((tool, index) => {
    const at = `${path}/${index}`;
    if (!exactKeys(tool, at, ["name", "gate", "mutating", "concurrencySafe"], issues)) return;
    const name = tool.name;
    if (typeof name !== "string" || !TOOL_NAME.test(name)) issues.push({ path: `${at}/name`, message: "is not a valid tool name" });
    else if (names.some((other) => other === name || overlaps(other, name))) issues.push({ path: `${at}/name`, message: `overlaps another tool of this plugin` });
    else names.push(name);
    if (typeof tool.gate !== "string" || !GATE_KIND.test(tool.gate)) issues.push({ path: `${at}/gate`, message: "is not a valid gate kind" });
    if (typeof tool.mutating !== "boolean") issues.push({ path: `${at}/mutating`, message: "must be a boolean" });
    if (tool.concurrencySafe !== undefined && typeof tool.concurrencySafe !== "boolean") issues.push({ path: `${at}/concurrencySafe`, message: "must be a boolean" });
    if (tool.concurrencySafe === true && tool.mutating === true) issues.push({ path: at, message: "a concurrency-safe tool must not be mutating" });
  });
};

/** Whether two tool names can name the same tool (`mcp__*` overlaps `mcp__x`). */
export function overlaps(left: string, right: string): boolean {
  const covers = (family: string, name: string): boolean => family.endsWith("*") && name.startsWith(family.slice(0, -1));
  return left === right || covers(left, right) || covers(right, left);
}

const config: Check = (value, path, issues) => {
  if (!exactKeys(value, path, ["schema", "default"], issues)) return;
  if (value.schema === undefined) return void issues.push({ path: `${path}/schema`, message: "is required" });
  const shape = schemaShapeIssues(value.schema, `${path}/schema`);
  issues.push(...shape);
  if (shape.length) return;
  if ((value.schema as JsonSchema).type !== "object") return void issues.push({ path: `${path}/schema/type`, message: "must be \"object\"" });
  // A plugin must work with its defaults alone, so the defaults (or {}) must be valid.
  const defaults = value.default ?? {};
  if (!isObject(defaults)) return void issues.push({ path: `${path}/default`, message: "must be an object" });
  for (const issue of validateSchema(value.schema as JsonSchema, defaults)) issues.push({ path: `${path}/default${issue.path}`, message: issue.message });
};

const toolEvents: Check = (value, path, issues) => {
  if (!exactKeys(value, path, ["events", "priority"], issues)) return;
  const events = value.events;
  if (!Array.isArray(events) || !events.length || new Set(events).size !== events.length
    || events.some((item) => !(TOOL_EVENT_NAMES as readonly unknown[]).includes(item))) {
    issues.push({ path: `${path}/events`, message: `must list unique names from ${TOOL_EVENT_NAMES.join(", ")}` });
  }
  const priority = value.priority;
  if (priority !== undefined && (!Number.isSafeInteger(priority) || (priority as number) < TOOL_EVENT_PRIORITY_BOUNDS[0] || (priority as number) > TOOL_EVENT_PRIORITY_BOUNDS[1])) {
    issues.push({ path: `${path}/priority`, message: `must be an integer within [${TOOL_EVENT_PRIORITY_BOUNDS.join(", ")}]` });
  }
};

const features: Check = (value, path, issues, doc) => {
  if (!Array.isArray(value)) return void issues.push({ path, message: "must be an array of features" });
  const seen = new Set<string>();
  value.forEach((feature, index) => {
    const at = `${path}/${index}`;
    if (!exactKeys(feature, at, ["id", "name", "nameEn"], issues)) return;
    for (const key of ["id", "name", "nameEn"]) text(feature[key], `${at}/${key}`, issues, doc);
    const id = feature.id;
    if (typeof id === "string" && (!id.startsWith(`${String(doc.id)}.`) || !ACTION_NAME.test(id.slice(String(doc.id).length + 1)) || seen.has(id))) {
      issues.push({ path: `${at}/id`, message: "must be a unique <plugin id>.<name>" });
    }
    if (typeof id === "string") seen.add(id);
  });
};

const FIELDS: Record<string, { required?: true; check: Check }> = {
  apiVersion: { required: true, check: (value, path, issues) => void (value !== MANIFEST_API_VERSION && issues.push({ path, message: `must be ${MANIFEST_API_VERSION}` })) },
  id: { required: true, check: (value, path, issues) => void ((typeof value !== "string" || !PLUGIN_ID.test(value)) && issues.push({ path, message: "is not a valid plugin id" })) },
  name: { required: true, check: text },
  description: { required: true, check: text },
  version: { required: true, check: (value, path, issues) => void ((typeof value !== "string" || !VERSION.test(value)) && issues.push({ path, message: "must be MAJOR.MINOR.PATCH" })) },
  defaultEnabled: { required: true, check: (value, path, issues) => void (typeof value !== "boolean" && issues.push({ path, message: "must be a boolean" })) },
  dependencies: { check: strings(dependency) },
  provides: { check: strings(serviceName) },
  inject: { check: inject },
  capabilities: { check: (value, path, issues) => void issues.push(...capabilityIssues(value, path)) },
  httpFamilies: { check: strings(routePattern) },
  tools: { check: tools },
  config: { check: config },
  toolEvents: { check: toolEvents },
  commands: { check: strings() },
  panels: { check: strings() },
  resources: { check: strings() },
  modules: { check: strings() },
  frontendModules: { check: strings() },
  desktopModules: { check: strings((item) => relativePath(item, "src/")) },
  backendAssets: { check: strings((item) => relativePath(item)) },
  dataFiles: { check: strings((item) => relativePath(item) ?? matching(DATA_PATH, "data path")(item)) },
  pluginsActions: { check: strings(matching(ACTION_NAME, "action name")) },
  installPackage: { check: text },
  features: { check: features },
};

/** Check one manifest document. Never throws; `manifest` is null when there are issues. */
export function validateManifest(document: unknown): ManifestResult {
  if (!isObject(document)) return { manifest: null, issues: [{ path: "", message: "manifest must be a JSON object" }] };
  const issues: SchemaIssue[] = [];
  for (const field of FORBIDDEN_FIELDS) {
    if (document[field]) issues.push({ path: `/${field}`, message: "external plugin code requires a separate audit" });
  }
  for (const [key, value] of Object.entries(document)) {
    const field = FIELDS[key];
    if (field) field.check(value, `/${key}`, issues, document);
    else if (!FORBIDDEN_FIELDS.includes(key)) issues.push({ path: `/${key}`, message: "is not a known field" });
  }
  for (const [key, field] of Object.entries(FIELDS)) {
    if (field.required && !Object.hasOwn(document, key)) issues.push({ path: `/${key}`, message: "is required" });
  }
  return issues.length ? { manifest: null, issues } : { manifest: normalize(document), issues };
}

function list(doc: Doc, key: string): string[] {
  return [...((doc[key] as string[] | undefined) ?? [])];
}

function injectLists(value: unknown): { required: string[]; optional: string[] } {
  if (Array.isArray(value)) return { required: [...(value as string[])], optional: [] };
  const lists = (value ?? {}) as { required?: string[]; optional?: string[] };
  return { required: [...(lists.required ?? [])], optional: [...(lists.optional ?? [])] };
}

function normalize(doc: Doc): PluginManifest {
  const configDoc = doc.config as { schema: JsonSchema; default?: Record<string, unknown> } | undefined;
  const events = doc.toolEvents as { events: string[]; priority?: number } | undefined;
  return {
    apiVersion: MANIFEST_API_VERSION,
    id: doc.id as string,
    name: doc.name as string,
    description: doc.description as string,
    version: doc.version as string,
    defaultEnabled: doc.defaultEnabled as boolean,
    dependencies: list(doc, "dependencies"),
    provides: list(doc, "provides"),
    inject: injectLists(doc.inject),
    capabilities: normalizeCapabilities(doc.capabilities as CapabilityDeclaration | undefined),
    httpFamilies: list(doc, "httpFamilies"),
    tools: ((doc.tools as ToolDeclaration[] | undefined) ?? []).map((tool) => ({
      name: tool.name, gate: tool.gate, mutating: tool.mutating, concurrencySafe: tool.concurrencySafe ?? false,
    })),
    config: configDoc ? { schema: configDoc.schema, default: { ...(configDoc.default ?? {}) } } : null,
    toolEvents: events ? { events: [...events.events], priority: events.priority ?? 0 } : null,
    commands: list(doc, "commands"),
    panels: list(doc, "panels"),
    resources: list(doc, "resources"),
    modules: list(doc, "modules"),
    frontendModules: list(doc, "frontendModules"),
    desktopModules: list(doc, "desktopModules"),
    backendAssets: list(doc, "backendAssets"),
    dataFiles: list(doc, "dataFiles"),
    pluginsActions: list(doc, "pluginsActions"),
    installPackage: (doc.installPackage as string | undefined) ?? null,
    features: ((doc.features as FeatureDeclaration[] | undefined) ?? []).map((feature) => ({ ...feature })),
  };
}
