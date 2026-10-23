/**
 * Named saved-workflow templates (Python
 * `bundled_plugins/workflows/saved_library.py`).
 *
 * A template is one JSON file under `<state>/workflows/saved` holding a plan
 * that `validatePlan` accepted at save time, plus bounded metadata. A template
 * is data, never code: instantiating one goes through the same
 * `WorkflowStore.create`/`launch` validation, Gate checks and approvals as a
 * hand-written plan. The directory, the `.locks/saved-<name>.lock` files and
 * the record shape match the Python module, so either backend reads files the
 * other one wrote.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isDict, numericValue, pyCasefold, pyEncodeUtf8, pyGetItem, pyJsonDumps, pyLen, pyStrip, pyTruthy, PyAttributeError, PyTypeError, PyValueError, pyTypeName } from "@xueness/contracts";
import { isPyKeyError, isPyOSError, isPyValueError, protectPrivateDirectory, PyOSError } from "@xueness/sessions";
import { resolvePath, stamp, validatePlan, type Row } from "./plan.ts";
import { ensurePrivateDirectory, isSymlink, lockPath, readJson, writeJsonAtomic } from "./state-file.ts";
import { isMissing, WorkflowStore } from "./store.ts";

/**
 * Template names are file names, so the charset is deliberately narrow: no
 * separators, whitespace or leading dots, and never a Windows reserved device
 * base name. A name therefore always maps to one file directly inside the
 * library directory and cannot traverse anywhere else. A JS `$` without the
 * `m` flag matches only at the very end of the subject, so it is Python's `\Z`
 * here (Python's own `$` would also match before a trailing newline).
 */
export const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MAX_DESCRIPTION = 500;
const RESERVED_BASES: ReadonlySet<string> = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);
const NAME_MESSAGE = "saved workflow name must be 1..64 characters of letters, digits, dot, dash or underscore, starting with a letter or digit";

/** `PermissionError`, an `OSError`: a workspace boundary, not a malformed value. */
class PermissionError extends PyOSError {
  override name = "PermissionError";
}

/** `len(value)` for sized JSON values; anything else is Python's `TypeError`. */
function pyLenOf(value: unknown): number {
  if (typeof value === "string") return pyLen(value);
  if (Array.isArray(value)) return value.length;
  if (isDict(value)) return Object.keys(value).length;
  throw new PyTypeError(`object of type '${pyTypeName(value)}' has no len()`);
}

/** Return the canonical template name, or raise `ValueError`. */
export function validateName(value: unknown): string {
  if (typeof value !== "string" || !NAME.test(value) || RESERVED_BASES.has(pyCasefold(value.split(".", 1)[0] ?? ""))) {
    throw new PyValueError(NAME_MESSAGE);
  }
  return value;
}

/** Root-independent digest binding an approval to the exact template plan. */
export function templatePlanDigest(plan: Row): string {
  const body = pyJsonDumps(plan, { sortKeys: true, ensureAscii: false, separators: [",", ":"] });
  return createHash("sha256").update(pyEncodeUtf8(body)).digest("hex");
}

/** The plan of one existing durable run, only inside the given workspace. */
export function sourcePlan(stateDir: string, workflowId: unknown, workspace: string): Row {
  const root = resolvePath(workspace);
  const record = new WorkflowStore(stateDir).load(workflowId);
  if (record.root !== root) throw new PermissionError("workflow belongs to another workspace");
  return { plan: pyGetItem(record, "plan"), source: { kind: "run", workflow_id: pyGetItem(record, "id") } };
}

/** The most recently updated run plan inside the given workspace. */
export function latestRunPlan(stateDir: string, workspace: string): Row {
  const root = resolvePath(workspace);
  const store = new WorkflowStore(stateDir);
  for (const item of store.list()) { // already sorted by updated_at, newest first
    let record: Row;
    try { record = store.load(item.id); } catch (error) {
      if (isPyOSError(error) || isPyValueError(error) || isPyKeyError(error)) continue;
      throw error;
    }
    if (record.root === root) return { plan: pyGetItem(record, "plan"), source: { kind: "run", workflow_id: pyGetItem(record, "id") } };
  }
  throw new PyValueError("no workflow runs exist in this workspace yet");
}

/** Per-template JSON storage under `<state>/workflows/saved`. */
export class SavedWorkflowLibrary {
  readonly state: string;
  readonly directory: string;

  constructor(state: string) {
    if (isSymlink(state)) throw new PyValueError("saved workflow state directory cannot be a symlink");
    this.state = resolvePath(state);
    this.directory = join(this.state, "workflows", "saved");
    // The parent directories are checked before mkdir: a junction or symlinked
    // component would redirect the whole library.
    if (isSymlink(join(this.state, "workflows")) || isSymlink(this.directory)) {
      throw new PyValueError("saved workflow library cannot be a symlink");
    }
    ensurePrivateDirectory(this.directory, "saved workflow library cannot be a symlink");
    // `_protect_private_directory`: 0700, or a protected owner-only DACL on Windows.
    protectPrivateDirectory(this.directory);
  }

  /** `_ensure_safe_directories`: no component may have become a link since construction. */
  #safe(): void {
    if (isSymlink(this.state) || isSymlink(join(this.state, "workflows")) || isSymlink(this.directory)) {
      throw new PyValueError("saved workflow library cannot be a symlink");
    }
  }

  path(name: unknown): string {
    this.#safe();
    const path = join(this.directory, validateName(name) + ".json");
    if (isSymlink(path)) throw new PyValueError("saved workflow file cannot be a symlink");
    return path;
  }

  /** `_lock`: coordinate one template's reads and replacements across processes. */
  #withLock<T>(name: unknown, body: () => T): T {
    this.#safe();
    // Python validates the name before `exclusive_lock` creates `.locks`.
    const lockName = `saved-${validateName(name)}.lock`;
    const directory = join(this.directory, ".locks");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (isSymlink(directory)) throw new PyValueError("invalid lock directory");
    const file = join(directory, lockName);
    if (isSymlink(file)) throw new PyValueError("invalid session lock");
    const held = lockPath(file);
    try { return body(); } finally { held.release(); }
  }

  /**
   * Validate a plan against `root` and persist it as one named template.
   * Saving never reuses an existing name silently: replacing a template
   * requires the explicit `overwrite` decision, because the previous content is
   * destroyed in the same atomic replace.
   */
  save(plan: Row, name: unknown, root: string, options: { description?: unknown; overwrite?: unknown; source?: Row } = {}): Row {
    const chosen = validateName(name);
    const clean = validatePlan(plan, root);
    const overwrite = options.overwrite === undefined ? false : options.overwrite;
    if (typeof overwrite !== "boolean") throw new PyValueError("overwrite must be a boolean");
    const given = options.description === undefined ? null : options.description;
    const description = given === null ? "" : given;
    if (typeof description !== "string" || pyLen(description) > MAX_DESCRIPTION) {
      throw new PyValueError(`description must be a string up to ${MAX_DESCRIPTION} characters`);
    }
    const record: Row = {
      name: chosen, description: pyStrip(description), plan: clean,
      plan_digest: templatePlanDigest(clean), node_count: (clean.nodes as unknown[]).length,
      concurrency: clean.concurrency, saved_at: stamp(), updated_at: stamp(),
    };
    if (isDict(options.source)) record.source = options.source;
    this.#withLock(chosen, () => {
      const path = this.path(chosen);
      if (existsSync(path) && !overwrite) {
        throw new PyValueError(`saved workflow '${chosen}' already exists; pass overwrite to replace it`);
      }
      writeJsonAtomic(this.directory, ".saved-", path, record);
    });
    return this.view(record);
  }

  load(name: unknown): Row {
    const chosen = validateName(name);
    const record = this.#withLock(chosen, () => {
      try { return readJson(this.path(chosen)); } catch (error) {
        if (isMissing(error)) throw new PyValueError(`unknown saved workflow: ${chosen}`);
        throw error;
      }
    });
    if (!isDict(record) || !isDict(record.plan)) throw new PyValueError(`saved workflow record is damaged: ${chosen}`);
    return record;
  }

  list(): Row[] {
    this.#safe();
    const rows: Row[] = [];
    let entries: string[];
    try { entries = readdirSync(this.directory); } catch { return rows; }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      let name: string;
      try { name = validateName(entry.slice(0, -5)); } catch { continue; }
      try {
        const record = this.#withLock(name, () => readJson(this.path(name)));
        rows.push(this.view(record as Row));
      } catch (error) {
        // Python catches exactly `(OSError, ValueError, KeyError, TypeError)`:
        // a valid-JSON file that is not an object raises AttributeError there.
        if (isPyOSError(error) || isPyValueError(error) || isPyKeyError(error) || error instanceof PyTypeError) continue;
        throw error;
      }
    }
    // Python sorts on the raw `updated_at`, so a record without one is a TypeError.
    const rank = (row: Row): number => {
      const value = numericValue(row.updated_at);
      if (value === null) throw new PyTypeError(`'<' not supported between instances of '${pyTypeName(row.updated_at)}' and 'float'`);
      return value;
    };
    return rows.sort((left, right) => rank(right) - rank(left));
  }

  /** Listing projection: name, description, node count and times only. */
  view(record: Row): Row {
    // Python calls `record.get(...)` first, so a non-dict record is an AttributeError.
    if (!isDict(record)) throw new PyAttributeError(`'${pyTypeName(record)}' object has no attribute 'get'`);
    const raw = Object.hasOwn(record, "plan") ? record.plan : null;
    const plan = pyTruthy(raw) ? raw : {}; // `record.get('plan') or {}`
    if (!isDict(plan)) throw new PyAttributeError(`'${pyTypeName(plan)}' object has no attribute 'get'`);
    const nodes = Object.hasOwn(plan, "nodes") ? plan.nodes : [];
    return {
      name: pyGetItem(record, "name"),
      description: Object.hasOwn(record, "description") ? record.description : "",
      node_count: pyLenOf(nodes),
      concurrency: Object.hasOwn(record, "concurrency") ? record.concurrency : null,
      plan_name: Object.hasOwn(plan, "name") ? plan.name : null,
      plan_digest: Object.hasOwn(record, "plan_digest") ? record.plan_digest : null,
      saved_at: Object.hasOwn(record, "saved_at") ? record.saved_at : null,
      updated_at: Object.hasOwn(record, "updated_at") ? record.updated_at : null,
    };
  }
}
