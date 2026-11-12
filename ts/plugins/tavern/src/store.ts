/** Private store for imported characters and world books: one JSON document each under `<state>/tavern/<kind>/`. */
import { existsSync, lstatSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson, isLink, protectPrivateDirectory, readJsonObject, validResourceId } from "@xueness/sessions";
import type { Character, WorldBook } from "./cards.ts";

export type TavernKind = "characters" | "worldbooks";
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
export const MAX_ITEMS = 200;

export class TavernStore {
  private readonly stateDir: string;
  constructor(stateDir: string) { this.stateDir = stateDir; }
  private directory(kind: TavernKind): string | null {
    const base = join(this.stateDir, "tavern"), directory = join(base, kind);
    return [this.stateDir, base, directory].some(isLink) ? null : directory;
  }
  private file(kind: TavernKind, id: string): string | null {
    const directory = this.directory(kind);
    return directory && validResourceId(id) && !id.endsWith("\n") ? join(directory, id + ".json") : null;
  }
  private read(path: string): Record<string, unknown> | null {
    try { if (isLink(path) || !lstatSync(path).isFile() || lstatSync(path).size > MAX_DOCUMENT_BYTES) return null; } catch { return null; }
    const value = readJsonObject(path);
    return value && typeof value.id === "string" && typeof value.name === "string" ? value : null;
  }
  list<T extends Character | WorldBook>(kind: TavernKind): T[] {
    const directory = this.directory(kind);
    if (!directory || !existsSync(directory)) return [];
    return readdirSync(directory).filter(name => name.endsWith(".json")).sort().slice(0, MAX_ITEMS).map(name => this.read(join(directory, name))).filter((item): item is Record<string, unknown> => item !== null) as unknown as T[];
  }
  get<T extends Character | WorldBook>(kind: TavernKind, id: unknown): T | null {
    const path = typeof id === "string" ? this.file(kind, id) : null;
    return path ? this.read(path) as unknown as T | null : null;
  }
  put(kind: TavernKind, item: Character | WorldBook): void {
    const path = this.file(kind, item.id), directory = this.directory(kind);
    if (!path || !directory) throw new Error("the tavern store cannot be used");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    protectPrivateDirectory(join(this.stateDir, "tavern")); protectPrivateDirectory(directory);
    atomicWriteJson(path, { ...item });
  }
  remove(kind: TavernKind, id: unknown): boolean {
    const path = typeof id === "string" ? this.file(kind, id) : null;
    if (!path || isLink(path) || !existsSync(path)) return false;
    unlinkSync(path);
    return true;
  }
}
