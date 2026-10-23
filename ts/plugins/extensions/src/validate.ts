/**
 * Inline manifest audit (`validate_update.dispatch` / `validate_inline`).
 *
 * Path checks stay on the CLI: the only HTTP body is exactly `{document}`.
 * Nothing here reads the state directory or imports a document.
 */
import { isDict, JsonFloat, pyIter, pyStr } from "@xueness/contracts";
import { pyCodeCompare } from "@xueness/sessions";
import { digest, validateDataManifest, type DataManifest } from "./sdk.ts";

const EXECUTABLE = new Set(["entrypoint", "command", "commands", "module", "modules", "import", "imports", "script", "scripts", "exec", "eval", "run", "shell", "bin", "binary", "hook", "hooks", "install", "postinstall", "uninstall", "url", "downloadUrl", "download", "homepage", "repository"]);
const MANIFEST_FIELDS = new Set(["id", "version", "apiVersion", "enabled", "builtin", "capabilities", "dependencies", "name", "description", "sha256"]);
const ENTRY_FIELDS = new Set(["id", "name", "description", "sha256", "manifest"]);
const MARKETPLACE_FIELDS = new Set(["apiVersion", "items"]);
const BUILD_ONLY = ["features", "frontendModules", "panels", "defaultEnabled"];
const INLINE_TARGET = "<request body>";
const MAX_ITEMS = 100;

export type Issue = { code: string; message: string; id?: string };
type Row = Record<string, unknown>;
export type ExtensionsReply = [number, unknown];

const sortedKeys = (value: Row): string[] => Object.keys(value).sort(pyCodeCompare);
const falsy = (value: unknown): boolean => value === null || value === undefined || value === false || value === "" || value === 0 || (value instanceof JsonFloat && value.value === 0) || (Array.isArray(value) && value.length === 0) || (isDict(value) && Object.keys(value).length === 0);

export function issue(code: string, message: string, itemId?: unknown): Issue {
  const row: Issue = { code, message };
  if (!falsy(itemId)) row.id = pyStr(itemId).slice(0, 120);
  return row;
}

/** Python `== 1` (`True` and `1.0` count). SDK validation uses a real int instead. */
function looseOne(value: unknown): boolean {
  if (value === true || value === 1) return true;
  return value instanceof JsonFloat && value.value === 1;
}

function dependenciesOf(item: Row): unknown[] {
  return falsy(item.dependencies) ? [] : pyIter(item.dependencies);
}

/** One data manifest. Returns errors, warnings, and the normalized manifest (or null). */
export function validateManifestDocument(item: unknown, resolvable: ReadonlySet<unknown> = new Set()): [Issue[], Issue[], DataManifest | null] {
  const warnings: Issue[] = [];
  if (!isDict(item)) return [[issue("invalid_shape", "manifest must be a JSON object")], warnings, null];
  const buildOnly = BUILD_ONLY.filter((key) => Object.hasOwn(item, key));
  if (buildOnly.length) {
    return [[issue("build_manifest", `a trusted build manifest (${buildOnly.join(", ")}) is audited by the plugin architecture gate, not as a data package`)], warnings, null];
  }
  const errors: Issue[] = [];
  for (const key of sortedKeys(item)) {
    if (EXECUTABLE.has(key)) errors.push(issue("executable_field", `manifest must not declare executable content: ${key}`, item.id));
  }
  const unknown = sortedKeys(item).filter((key) => !MANIFEST_FIELDS.has(key));
  if (unknown.length) errors.push(issue("unknown_field", `unexpected manifest fields: ${unknown.join(", ")}`, item.id));
  if (errors.length) return [errors, warnings, null];
  const [manifest, shapeErrors] = validateDataManifest(item);
  for (const text of shapeErrors) errors.push(issue("invalid_manifest", text, item.id));
  if (!manifest) return [errors, warnings, null];
  if (item.sha256 !== undefined && item.sha256 !== null) {
    const own: Row = {};
    for (const [key, value] of Object.entries(item)) if (key !== "sha256") own[key] = value;
    if (pyStr(item.sha256).toLowerCase() !== digest(own)) errors.push(issue("digest_mismatch", "declared sha256 does not match the manifest", manifest.id));
  }
  for (const dependency of dependenciesOf(item)) {
    if (dependency === manifest.id) errors.push(issue("self_dependency", "manifest depends on itself", manifest.id));
    else if (!resolvable.has(dependency)) errors.push(issue("unknown_dependency", `dependency is not present in the validated set: ${pyStr(dependency)}`, manifest.id));
  }
  if (Object.hasOwn(item, "capabilities") && falsy(item.capabilities)) {
    warnings.push(issue("no_capabilities", "manifest requests no powers; the adapter it names stays disabled", manifest.id));
  }
  return [errors, warnings, manifest];
}

export function validateMarketplace(document: unknown): [Issue[], Issue[], Row[]] {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const items: Row[] = [];
  if (!isDict(document)) return [[issue("invalid_shape", "marketplace must be a JSON object")], warnings, items];
  const unknown = sortedKeys(document).filter((key) => !MARKETPLACE_FIELDS.has(key));
  if (unknown.length) errors.push(issue("unknown_field", `unexpected marketplace fields: ${unknown.join(", ")}`));
  if (Object.hasOwn(document, "apiVersion") && !looseOne(document.apiVersion)) errors.push(issue("incompatible_api_version", "marketplace apiVersion must be 1"));
  const rows = document.items;
  if (!Array.isArray(rows) || rows.length === 0) {
    errors.push(issue("invalid_items", "marketplace items must be a non-empty array"));
    return [errors, warnings, items];
  }
  if (rows.length > MAX_ITEMS) {
    errors.push(issue("too_many_items", `marketplace lists more than ${MAX_ITEMS} items`));
    return [errors, warnings, items];
  }
  const ids = new Set<unknown>(rows.filter(isDict).map((row) => row.id));
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isDict(row)) {
      errors.push(issue("invalid_shape", "marketplace item must be a JSON object"));
      continue;
    }
    const entryErrors = sortedKeys(row).filter((key) => !ENTRY_FIELDS.has(key)).map((key) => issue("unknown_field", `unexpected marketplace item field: ${key}`, row.id));
    const [manifestErrors, manifestWarnings, manifest] = validateManifestDocument(row.manifest, ids);
    entryErrors.push(...manifestErrors);
    if (!manifest && entryErrors.length === 0) entryErrors.push(issue("invalid_manifest", "marketplace item is missing a manifest", row.id));
    if (manifest) {
      if (row.id !== manifest.id) entryErrors.push(issue("id_mismatch", "item id does not match its manifest id", row.id));
      if (seen.has(manifest.id)) entryErrors.push(issue("duplicate_id", "marketplace lists the same plugin twice", manifest.id));
      seen.add(manifest.id);
      if (row.sha256 !== undefined && row.sha256 !== null && pyStr(row.sha256).toLowerCase() !== digest(row.manifest)) {
        entryErrors.push(issue("digest_mismatch", "item sha256 does not match its manifest", manifest.id));
      }
      for (const [label, limit] of [["name", 120], ["description", 500]] as const) {
        if (pyStr(row[label] ?? "").length > limit) manifestWarnings.push(issue("truncated_field", `${label} is longer than ${limit} characters and will be truncated when installed`, manifest.id));
      }
    }
    items.push({ id: manifest ? manifest.id : (row.id ?? null), version: manifest ? manifest.version : null, ok: entryErrors.length === 0, errors: entryErrors, warnings: manifestWarnings });
    errors.push(...entryErrors);
    warnings.push(...manifestWarnings);
  }
  return [errors, warnings, items];
}

function report(kind: string, errors: Issue[], warnings: Issue[], items: Row[]): Row {
  return { path: INLINE_TARGET, kind, ok: errors.length === 0, errors, warnings, items };
}

/** Audit a document the caller already holds. `path` is always `<request body>`. */
export function validateInline(document: unknown): Row {
  if (isDict(document) && Object.hasOwn(document, "items")) {
    const [errors, warnings, items] = validateMarketplace(document);
    return report("marketplace", errors, warnings, items);
  }
  const [errors, warnings, manifest] = validateManifestDocument(document);
  const items = [{ id: manifest ? manifest.id : null, version: manifest ? manifest.version : null, ok: errors.length === 0, errors, warnings }];
  return report("manifest", errors, warnings, items);
}

/** `POST /api/plugins/marketplace/validate`. Any other method or path is not ours (`null`). */
export function dispatchValidate(method: string, parts: readonly string[], data: unknown): ExtensionsReply | null {
  if (parts[0] !== "api" || parts[1] !== "plugins" || parts[2] !== "marketplace" || parts[3] !== "validate" || method !== "POST") return null;
  if (!isDict(data) || Object.keys(data).length !== 1 || !Object.hasOwn(data, "document")) return [400, { error: "expected an inline document" }];
  return [200, validateInline(data.document)];
}
