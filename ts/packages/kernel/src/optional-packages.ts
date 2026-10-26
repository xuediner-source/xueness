/** Build-pinned optional artifacts. External manifests cannot add code to this registry. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import pins from "./optional-packages.json" with { type: "json" };

export type OptionalFile = { path: string; bytes: number; sha256: string; executable: boolean };
export type OptionalArtifact = { id: string; packageId: string; version: string; sha256: string; bytes: number; url: string; files: OptionalFile[] };
export const OPTIONAL_IDS = ["subscriptions", "model_monitor", "workbuddy"] as const;
export type OptionalId = typeof OPTIONAL_IDS[number];
const registry = pins as Record<string, OptionalArtifact>;
const requireModule = createRequire(import.meta.url);
const checked = new Map<string, { stamp: string; digest: string }>();
export const artifactHash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const optionalArtifact = (id: string): OptionalArtifact | null => OPTIONAL_IDS.includes(id as OptionalId) ? registry[id] ?? null : null;
export const optionalArtifactByPackage = (id: string): OptionalArtifact | null => Object.values(registry).find(row => row.packageId === id) ?? null;

/** Every ancestor under this private root must be a real directory, never a redirect. */
export function optionalPath(root: string, relative: string): string {
  const base = resolve(root), target = resolve(base, relative);
  if (target !== base && !target.startsWith(base + sep)) throw new Error("optional artifact path escaped its root");
  for (let path = target; ; path = dirname(path)) {
    try { if (lstatSync(path).isSymbolicLink()) throw new Error("optional artifact path is a link"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (path === base) return target;
  }
}

export function optionalRoot(stateDir: string, artifact: OptionalArtifact): string {
  optionalPath(stateDir, "optional-plugins");
  return optionalPath(join(resolve(stateDir), "optional-plugins"), `${artifact.id}/${artifact.sha256}`);
}

function verifiedFile(root: string, file: OptionalFile, read = false): Buffer {
  const path = optionalPath(root, file.path), stat = lstatSync(path);
  if (!stat.isFile() || stat.size !== file.bytes) throw new Error("optional artifact file missing or damaged");
  const stamp = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`, previous = checked.get(path);
  if (!read && previous?.stamp === stamp && previous.digest === file.sha256) return Buffer.alloc(0);
  const bytes = readFileSync(path);
  const digest = previous?.stamp === stamp ? previous.digest : artifactHash(bytes);
  if (digest !== file.sha256) throw new Error("optional artifact checksum mismatch");
  checked.set(path, { stamp, digest }); return bytes;
}

/** A marker from an older release is insufficient: the entire pinned payload must exist. */
export function optionalInstalled(stateDir: string, id: string): boolean {
  const artifact = optionalArtifact(id);
  if (!artifact) return false;
  try {
    const root = optionalRoot(stateDir, artifact), receipt = optionalPath(root, ".installed.json");
    if (lstatSync(receipt).size > 1024) return false;
    const value = JSON.parse(readFileSync(receipt, "utf8"));
    if (value.id !== id || value.sha256 !== artifact.sha256 || value.version !== artifact.version) return false;
    for (const file of artifact.files) verifiedFile(root, file);
    return true;
  } catch { return false; }
}

/** This is the only executable loader. Both the entry and all bytes are build-pinned. */
export function loadOptionalModule(stateDir: string, id: string): unknown {
  const artifact = optionalArtifact(id);
  if (!artifact || !optionalInstalled(stateDir, id)) throw new Error(`Download ${id} from the extension marketplace first`);
  return requireModule(join(optionalRoot(stateDir, artifact), "backend/src/index.ts"));
}

/** Fixed frontend file names share the core React runtime through relative ESM imports. */
export function optionalAsset(stateDir: string, name: string): Buffer | null {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes("..")) return null;
  for (const artifact of Object.values(registry)) {
    const file = artifact.files.find(item => item.path === `frontend/${name}`);
    if (file && optionalInstalled(stateDir, artifact.id)) return verifiedFile(optionalRoot(stateDir, artifact), file, true);
  }
  return null;
}

/** Link destination is computed from the signed-in host's own core dependency tree. */
export function coreNodeModules(): string {
  for (let path = import.meta.dirname; ; path = dirname(path)) {
    if (existsSync(join(path, "node_modules/@xueness/contracts/package.json"))) return realpathSync.native(join(path, "node_modules"));
    if (dirname(path) === path) throw new Error("core dependency directory missing");
  }
}
