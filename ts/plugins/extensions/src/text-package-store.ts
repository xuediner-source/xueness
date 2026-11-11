/**
 * A store for imported packages that are nothing but text: an id, a few
 * display fields and the text contributions the host may later activate.
 *
 * Package types whose format has no store of its own (a rule pack is just
 * loose files) keep their imported copy here, one private JSON document per
 * package at `<state>/package-imports/<type>/<id>.json`. The store holds
 * data only; activating a package is a separate step (`activation.ts`).
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isDict } from "@xueness/contracts";
import { atomicWriteJson, isLink, protectPrivateDirectory, readJsonObject, validResourceId } from "@xueness/sessions";
import type { PackageContribution } from "./activation.ts";

export interface TextPackage { id: string; version: string; name: string; description: string; fileName: string; importedAt: string; contributions: PackageContribution[] }
export interface TextPackageStore { list(): TextPackage[]; get(id: string): TextPackage | null; put(pkg: TextPackage): void; remove(id: string): boolean }

const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const TYPE = /^[a-z][a-z0-9-]{0,31}$/;
const text = (value: unknown, max: number): string => typeof value === "string" ? value.slice(0, max) : "";

function parse(value: unknown): TextPackage | null {
  if (!isDict(value) || !validResourceId(value.id) || !Array.isArray(value.contributions)) return null;
  const contributions: PackageContribution[] = [];
  for (const item of value.contributions) {
    if (!isDict(item) || (item.kind !== "skills" && item.kind !== "commands") || typeof item.id !== "string" || typeof item.body !== "string") return null;
    contributions.push({ kind: item.kind, id: item.id, name: text(item.name, 200) || item.id, description: text(item.description, 400), body: item.body });
  }
  return { id: value.id, version: text(value.version, 40), name: text(value.name, 120) || value.id, description: text(value.description, 400),
    fileName: text(value.fileName, 300), importedAt: text(value.importedAt, 40), contributions };
}

export function textPackageStore(stateDir: string, type: string): TextPackageStore {
  if (!TYPE.test(type)) throw new Error("invalid package type");
  const base = join(stateDir, "package-imports"), directory = join(base, type);
  const safe = (): boolean => ![stateDir, base, directory].some(isLink);
  const file = (id: string): string | null => validResourceId(id) && !id.endsWith("\n") && safe() ? join(directory, id + ".json") : null;
  const read = (path: string): TextPackage | null => {
    try { if (isLink(path) || !lstatSync(path).isFile() || lstatSync(path).size > MAX_DOCUMENT_BYTES) return null; } catch { return null; }
    return parse(readJsonObject(path));
  };
  return {
    list() {
      if (!safe() || !existsSync(directory)) return [];
      return readdirSync(directory).filter(name => name.endsWith(".json")).sort().map(name => read(join(directory, name))).filter((pkg): pkg is TextPackage => pkg !== null);
    },
    get(id) { const path = file(id); return path ? read(path) : null; },
    put(pkg) {
      const path = file(pkg.id);
      if (!path) throw new Error("the package store cannot be used");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      protectPrivateDirectory(base); protectPrivateDirectory(directory);
      atomicWriteJson(path, { ...pkg });
    },
    remove(id) {
      const path = file(id);
      if (!path || isLink(path) || !existsSync(path)) return false;
      unlinkSync(path);
      return true;
    },
  };
}
