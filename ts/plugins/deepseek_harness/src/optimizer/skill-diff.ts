/**
 * H10.02 — Skill pack diff/apply/revert inside a sandbox root.
 */
import { resolveInsideSandbox } from "./loop.ts";

export interface SkillFilePatch {
  readonly path: string;
  readonly content: string;
}

export interface SkillDiff {
  readonly id: string;
  readonly files: readonly SkillFilePatch[];
}

export interface SkillStore {
  read(path: string): string | null;
  write(path: string, content: string): void;
  remove(path: string): void;
}

export interface AppliedSkillDiff {
  readonly diff: SkillDiff;
  revert(): void;
}

export function applySkillDiff(store: SkillStore, root: string, diff: SkillDiff): AppliedSkillDiff {
  if (!diff.id.trim()) throw new Error("skill diff id required");
  const backups: { path: string; prior: string | null }[] = [];
  for (const file of diff.files) {
    const check = resolveInsideSandbox(root, file.path);
    if (!check.inside) throw new Error(`skill path escapes sandbox: ${file.path}`);
    backups.push({ path: file.path, prior: store.read(file.path) });
    store.write(file.path, file.content);
  }
  return {
    diff,
    revert() {
      for (const entry of [...backups].reverse()) {
        if (entry.prior === null) store.remove(entry.path);
        else store.write(entry.path, entry.prior);
      }
    },
  };
}

export function createMemorySkillStore(seed: Record<string, string> = {}): SkillStore & { snapshot(): Record<string, string> } {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    read(path) { return map.has(path) ? map.get(path)! : null; },
    write(path, content) { map.set(path, content); },
    remove(path) { map.delete(path); },
    snapshot() { return Object.fromEntries(map.entries()); },
  };
}
