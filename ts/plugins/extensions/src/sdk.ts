/**
 * Data-manifest contract used by the marketplace (`xueness/plugin_sdk.py`).
 *
 * A manifest is data: `entrypoint` and `command` are refused, nothing is
 * imported, and `installAll` validates the whole batch before it writes.
 * Files land in `<state>/resources/plugins/<id>.json`, disabled unless the
 * document itself says `enabled: true`.
 */
import { createHash } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDict, pyJsonDumps, pyRepr, PyValueError } from "@xueness/contracts";
import { exists, isLink, jsonEntries, pyCodeCompare, readJsonObject, resourceKindDir, validResourceId } from "@xueness/sessions";
import { atomicWriteJson, isDirectory } from "./io.ts";

const API_VERSION = 1;
const CAPABILITIES = ["command", "network", "filesystem-write"];
const BUILTINS = new Set(["skills", "hooks", "subagents", "mcp", "subscriptions", "model_monitor", "workbuddy"]);
const VERSION = /^\d+\.\d+\.\d+$/;

export interface DataManifest {
  id: string;
  version: string;
  apiVersion: number;
  enabled: boolean;
  builtin: string;
  capabilities: string[];
}

export interface InstallResult {
  ok: boolean;
  written: string[];
  errors: unknown[];
}

const truthy = (value: unknown): boolean => {
  if (value === null || value === undefined || value === false || value === "") return false;
  if (typeof value === "number") return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isDict(value)) return Object.keys(value).length > 0;
  return true;
};

/** `marketplace.digest`: SHA-256 of canonical JSON (`sort_keys`, compact separators). */
export function digest(manifest: unknown): string {
  const text = pyJsonDumps(manifest, { sortKeys: true, separators: [",", ":"], ensureAscii: true });
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function pluginsDirectory(stateDir: string): string | null {
  try {
    return resourceKindDir(stateDir, "plugins");
  } catch {
    return null;
  }
}

/** `validate_manifest`. Never throws. `manifest` is null when the document is unusable. */
export function validateDataManifest(item: unknown): [DataManifest | null, string[]] {
  const errors: string[] = [];
  if (!isDict(item)) return [null, ["manifest must be a JSON object"]];
  for (const forbidden of ["entrypoint", "command"]) {
    if (truthy(item[forbidden])) errors.push("external plugin code requires a separate audit");
  }
  let id: string | null = typeof item.id === "string" ? item.id : null;
  if (!validResourceId(item.id)) {
    errors.push("invalid id");
    id = null;
  }
  if (typeof item.version !== "string" || !VERSION.test(item.version)) errors.push("version must be MAJOR.MINOR.PATCH");
  if (typeof item.apiVersion === "boolean" || typeof item.apiVersion !== "number" || !Number.isInteger(item.apiVersion)) errors.push("apiVersion must be an integer");
  else if (item.apiVersion !== API_VERSION) errors.push("incompatible apiVersion");
  if (typeof item.builtin !== "string" || !BUILTINS.has(item.builtin)) errors.push("builtin must name a known capability");
  const caps: string[] = [];
  if (item.capabilities !== undefined) {
    if (!Array.isArray(item.capabilities)) errors.push("capabilities must be an array");
    else {
      for (const cap of item.capabilities) {
        if (!CAPABILITIES.includes(cap as string)) {
          errors.push(`unknown capability: ${pyRepr(cap)}`);
          break;
        }
        if (!caps.includes(cap as string)) caps.push(cap as string);
      }
    }
  }
  if (errors.length || id === null || typeof item.version !== "string" || typeof item.builtin !== "string" || typeof item.apiVersion !== "number") return [null, errors];
  return [{ id, version: item.version, apiVersion: item.apiVersion, enabled: item.enabled === true, builtin: item.builtin, capabilities: caps }, []];
}

/** Valid manifests under `<state>/resources/plugins`, id ascending. Broken files are skipped. */
export function loadManifests(stateDir: string): DataManifest[] {
  const directory = pluginsDirectory(stateDir);
  if (directory === null || !isDirectory(directory)) return [];
  const manifests: DataManifest[] = [];
  for (const name of jsonEntries(directory)) {
    const path = join(directory, name);
    if (isLink(path)) continue;
    const item = readJsonObject(path);
    if (item === null || !Object.hasOwn(item, "id")) continue;
    const [manifest] = validateDataManifest(item);
    if (manifest) manifests.push(manifest);
  }
  return manifests.sort((left, right) => pyCodeCompare(left.id, right.id));
}

function recordOf(id: string, item: Record<string, unknown>): Record<string, unknown> {
  const record: Record<string, unknown> = { id };
  for (const [key, value] of Object.entries(item)) {
    if (key === "id" || key === "createdAt" || key === "updatedAt") continue;
    record[key] = value;
  }
  return record;
}

/** `install_all`: validate every document, then write; restore previous bytes if a write fails. */
export function installAll(stateDir: string, items: unknown): InstallResult {
  if (!Array.isArray(items)) return { ok: false, written: [], errors: ["items must be an array"] };
  const directory = pluginsDirectory(stateDir);
  if (directory === null) return { ok: false, written: [], errors: ["plugins directory must not be a symlink"] };
  const planned: [string, Record<string, unknown>][] = [];
  const errors: unknown[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const [manifest, errs] = validateDataManifest(item);
    if (!manifest || !isDict(item)) {
      errors.push({ id: isDict(item) ? (item.id ?? null) : null, errors: errs });
      continue;
    }
    if (seen.has(manifest.id)) {
      errors.push({ id: manifest.id, errors: ["duplicate plugin id"] });
      continue;
    }
    seen.add(manifest.id);
    planned.push([manifest.id, item]);
  }
  if (errors.length) return { ok: false, written: [], errors };
  const snapshots = new Map<string, Buffer | null>();
  const written: string[] = [];
  try {
    for (const [id, item] of planned) {
      const path = join(directory, `${id}.json`);
      if (isLink(path)) throw new PyValueError(`plugin id must not be a symlink: ${id}`);
      snapshots.set(id, exists(path) ? readFileSync(path) : null);
      atomicWriteJson(path, recordOf(id, item));
      written.push(id);
    }
  } catch (error) {
    for (const id of [...written].reverse()) {
      const path = join(directory, `${id}.json`);
      const snapshot = snapshots.get(id) ?? null;
      try {
        if (snapshot === null) {
          if (exists(path)) unlinkSync(path);
        } else writeFileSync(path, snapshot);
      } catch {
        /* Python swallows a rollback OSError. */
      }
    }
    return { ok: false, written: [], errors: [error instanceof Error ? error.message : String(error)] };
  }
  return { ok: true, written, errors: [] };
}
