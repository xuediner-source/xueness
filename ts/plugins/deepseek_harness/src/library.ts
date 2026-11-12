/**
 * The local library of declarative harness packages imported before the
 * format was retired (H01.07, retired 2026-11-12).
 *
 * A package is the declarative manifest the loader understands
 * (`deepseek-harness.json`, or a `package.json` with an `xuenessHarness`
 * block) plus the skill files its `skills[].path` entries reference. The
 * format was defined by Xueness, not by DeepSeek Harness, and no published
 * DSH plugin uses it, so new imports are refused (`importer.ts`); this module
 * still validates a manifest for the refusal's preview, and lists, re-checks,
 * reads and removes the packages already in the library.
 *
 * Nothing in a package is imported as code, evaluated or executed.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { isLink, protectPrivateDirectory, withFileLockSync } from "@xueness/sessions";
import { HARNESS_MANIFEST_FILE, MAX_MANIFEST_BYTES, loadHarness, parseHarnessManifest, type HarnessManifest, type HarnessSourceKind, type Issue } from "./loader.ts";
import { HarnessRegistry, contributionRefs, type MountedHarness } from "./registry.ts";

export const LIBRARY_DIR = join("deepseek-harness", "library");
export const MAX_PACKAGE_FILES = 40;
export const MAX_PACKAGE_FILE_BYTES = 128 * 1024;
const META_FILE = "import.json";
const ID = /^[a-z][a-z0-9_-]*$/;
const TEXT_FILE = /\.(md|markdown|txt)$/i;
const SAFE_PATH = /^[A-Za-z0-9._\-/ ]{1,240}$/;
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

type Row = Record<string, unknown>;
export interface PackageFile { path: string; content: string }
export interface PackageInfo { name: string; description: string; author: string }
export interface LibraryError { code: string; message: string; issues?: Issue[] }
export interface ImportPreview {
  id: string; version: string; kind: HarnessSourceKind; info: PackageInfo;
  manifest: HarnessManifest; files: string[]; missing: string[];
  /** The version already imported under this id, when importing would replace it. */
  replaces: string | null;
  /** Contributions another imported harness already owns; importing is refused while any remain. */
  clashes: string[];
}

const isObject = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const fail = (code: string, message: string, issues?: Issue[]): { ok: false; error: LibraryError } => ({ ok: false, error: { code, message, ...(issues ? { issues } : {}) } });
/** One display line from untrusted text: control characters out, bounded. */
const line = (value: unknown, max: number): string => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]+/g, " ").trim().slice(0, max) : "";
const validId = (id: string): boolean => ID.test(id) && !RESERVED_NAME.test(id);
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

function withLibrary<T>(stateDir: string, mode: "read" | "remove", action: (root: string) => T): T | ReturnType<typeof fail> {
  const root = join(stateDir, LIBRARY_DIR);
  const lock = join(root, ".library.lock");
  if ([stateDir, dirname(root), root, lock].some(isLink)) return fail("unsafe_library", "the harness library cannot use symbolic links");
  try {
    if (!existsSync(root)) return action(root);
    return withFileLockSync(lock, { shared: mode === "read", timeoutSeconds: 2 }, () => action(root));
  } catch {
    return fail("library_storage", "the harness library could not complete the storage operation");
  }
}

function readMeta(dir: string): Row {
  const path = join(dir, META_FILE);
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.size > MAX_MANIFEST_BYTES) return {};
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isObject(value) ? value : {};
  } catch { return {}; }
}

/** Build the index from disk while holding the library lock. */
function readLibrary(root: string): HarnessRegistry {
  const registry = new HarnessRegistry();
  if (existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !validId(entry.name)) continue;
      const dir = join(root, entry.name);
      if (isLink(dir)) continue;
      const importedAt = line(readMeta(dir).importedAt, 40);
      const loaded = loadHarness(registry, dir, { now: () => importedAt || new Date().toISOString() });
      if (loaded.ok && loaded.entry.id !== entry.name) registry.unmount(loaded.entry.id);
    }
  }
  return registry;
}

/** `skills[].path` as a safe relative POSIX path, or null when it could escape the package. */
export function packagePath(value: string): string | null {
  const unified = value.replace(/\\/g, "/");
  if (!SAFE_PATH.test(unified) || unified.startsWith("/")) return null;
  if (unified.split("/").some(part => part === ".." || part !== "." && (/[ .]$/.test(part) || RESERVED_NAME.test(part)))) return null;
  const normal = posix.normalize(unified);
  return normal === "." || normal.startsWith("../") || normal === ".." ? null : normal;
}

interface ParsedPackage { manifest: HarnessManifest; kind: HarnessSourceKind; info: PackageInfo; files: PackageFile[]; missing: string[] }

/** Validate the text the webapp sent: one manifest, optional referenced skill files. */
function parsePackage(request: Row): { ok: true; value: ParsedPackage } | { ok: false; error: LibraryError } {
  if (typeof request.manifest !== "string" || !request.manifest.trim()) return fail("invalid_input", "manifest text required");
  if (Buffer.byteLength(request.manifest, "utf8") > MAX_MANIFEST_BYTES) return fail("too_large", `manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
  let document: unknown;
  // Windows editors often save UTF-8 with a byte-order mark; it is not part of the JSON.
  try { document = JSON.parse(request.manifest.replace(/^﻿/, "")); } catch (error) { return fail("invalid_json", (error as Error).message); }
  if (!isObject(document)) return fail("invalid_manifest", "manifest must be a JSON object");
  const isPackage = isObject(document.xuenessHarness);
  if (!isPackage && document.sdkApiVersion === undefined && (typeof document.main === "string" || isObject(document.scripts) || isObject(document.dependencies) || document.exports !== undefined)) {
    return fail("code_package", "package.json has no xuenessHarness block; packages that run their own code cannot be imported");
  }
  const source = isPackage ? document.xuenessHarness as Row : document;
  const parsed = parseHarnessManifest(source);
  if (!parsed.manifest) return fail("invalid_manifest", "manifest does not pass harness validation", parsed.issues);
  const manifest = parsed.manifest;
  if (!validId(manifest.id)) return fail("invalid_manifest", "harness id is a reserved file name");
  const author = isObject(document.author) ? document.author.name : document.author;
  const info: PackageInfo = {
    name: line(source.name ?? (isPackage ? document.name : undefined), 80) || manifest.id,
    description: line(source.description ?? document.description, 400),
    author: line(source.author ?? author, 80),
  };
  const wanted = new Set<string>();
  for (const skill of manifest.skills) {
    if (!skill.path) continue;
    const path = packagePath(skill.path);
    if (path === null || !TEXT_FILE.test(path)) return fail("invalid_manifest", `skill ${skill.id} has an unsafe or non-text path`, [{ path: "/skills", message: skill.path }]);
    if ([...wanted].some(other => other !== path && other.toLowerCase() === path.toLowerCase())) {
      return fail("invalid_manifest", "skill paths differ only by case");
    }
    skill.path = path;
    wanted.add(path);
  }
  const rawFiles = request.files === undefined ? [] : request.files;
  if (!Array.isArray(rawFiles) || rawFiles.length > MAX_PACKAGE_FILES) return fail("invalid_input", `at most ${MAX_PACKAGE_FILES} skill files`);
  const files: PackageFile[] = [];
  for (const raw of rawFiles) {
    if (!isObject(raw) || typeof raw.path !== "string" || typeof raw.content !== "string") return fail("invalid_input", "each file needs a path and text content");
    const path = packagePath(raw.path);
    if (path === null || !wanted.has(path)) return fail("invalid_input", `file is not a skill this manifest references: ${line(raw.path, 200)}`);
    if (Buffer.byteLength(raw.content, "utf8") > MAX_PACKAGE_FILE_BYTES) return fail("too_large", `${path} exceeds ${MAX_PACKAGE_FILE_BYTES} bytes`);
    if (!files.some((file) => file.path === path)) files.push({ path, content: raw.content });
  }
  const missing = [...wanted].filter((path) => !files.some((file) => file.path === path));
  return { ok: true, value: { manifest, kind: isPackage ? "package" : "directory", info, files, missing } };
}

/** Contributions of `manifest` that a different imported harness already owns. */
function clashesFor(registry: HarnessRegistry, manifest: HarnessManifest): string[] {
  return contributionRefs(manifest, manifest.id)
    .filter((ref) => { const owner = registry.ownerOf(ref.key); return owner !== null && owner !== manifest.id; })
    .map((ref) => `${ref.kind} ${ref.name} (${registry.ownerOf(ref.key)})`);
}

/** What importing would do, without changing anything. */
export function previewImport(stateDir: string, request: Row): { ok: true; preview: ImportPreview } | { ok: false; error: LibraryError } {
  const parsed = parsePackage(request);
  if (!parsed.ok) return parsed;
  const { manifest, kind, info, files, missing } = parsed.value;
  return withLibrary(stateDir, "read", root => {
    const registry = readLibrary(root);
    return { ok: true as const, preview: { id: manifest.id, version: manifest.version, kind, info, manifest, files: files.map((file) => file.path), missing,
      replaces: registry.get(manifest.id)?.version ?? null, clashes: clashesFor(registry, manifest) } };
  });
}

function discard(path: string): void {
  try { rmSync(path, { recursive: true, force: true }); } catch { /* The library no longer references this directory. */ }
}

/** Unmount one imported harness and delete its library copy. */
export function removePackage(stateDir: string, id: unknown): { ok: true } | { ok: false; error: LibraryError } {
  if (typeof id !== "string" || !validId(id)) return fail("invalid_input", "a harness id is required");
  return withLibrary(stateDir, "remove", root => {
    const dir = join(root, id);
    if (isLink(dir)) return fail("unsafe_library", "the imported harness directory cannot be a symbolic link");
    if (!existsSync(dir)) return fail("not_found", `harness ${id} is not imported`);
    const removed = join(root, `.removed-${randomBytes(6).toString("hex")}`);
    renameSync(dir, removed);
    discard(removed);
    return { ok: true as const };
  });
}

function present(dir: string, path: string): boolean {
  let entry = dir;
  for (const part of path.split("/")) {
    entry = join(entry, part);
    if (isLink(entry)) return false;
  }
  try { return statSync(entry).isFile(); } catch { return false; }
}

/** Everything the library page shows about one harness; untrusted text stays bounded. */
export function describeHarness(mounted: MountedHarness): Row {
  const meta = readMeta(mounted.source);
  const { manifest } = mounted;
  return {
    id: mounted.id, version: mounted.version, importedAt: mounted.loadedAt,
    kind: meta.kind === "package" ? "package" : "directory", fileName: line(meta.fileName, 200),
    name: line(meta.name, 80) || mounted.id, description: line(meta.description, 400), author: line(meta.author, 80),
    tools: manifest.tools.map((tool) => ({ name: tool.name, gate: tool.gate, mutating: tool.mutating, description: line(tool.description, 300) })),
    hooks: manifest.hooks.map((hook) => ({ event: hook.event, handler: line(hook.handler, 200) })),
    verifiers: manifest.verifiers.map((verifier) => ({ name: verifier.name, command: line(verifier.command, 300) })),
    skills: manifest.skills.map((skill) => ({ id: line(skill.id, 120), path: line(skill.path, 240), present: skill.path ? present(mounted.source, packagePath(skill.path) ?? "") : false })),
    promptTemplates: manifest.promptTemplates.map((template) => ({ id: line(template.id, 120), preview: line(template.template, 240) })),
  };
}

/** The library: every imported harness plus a fresh verify report. */
export function listLibrary(stateDir: string): Row {
  return withLibrary(stateDir, "read", root => {
    const registry = readLibrary(root);
    const items = registry.list().map(row => describeHarness(registry.get(row.id)!));
    const report = registry.verify();
    for (const item of report.items) {
      const expected = readMeta(item.source).manifestSha256;
      if (typeof expected !== "string") continue;
      const check = item.checks.find(entry => entry.name === "manifest_current");
      const path = join(item.source, HARNESS_MANIFEST_FILE);
      if (check?.ok && (!present(item.source, HARNESS_MANIFEST_FILE) || lstatSync(path).size > MAX_MANIFEST_BYTES
          || digest(readFileSync(path, "utf8")) !== expected)) {
        check.ok = false;
        check.detail = "the stored manifest differs from the imported copy";
        item.status = "degraded";
      }
    }
    return { items, report, limits: { manifestBytes: MAX_MANIFEST_BYTES, files: MAX_PACKAGE_FILES, fileBytes: MAX_PACKAGE_FILE_BYTES } };
  });
}

/** The text a package offers for activation: skill files and prompt templates, read from the stored copy. Nothing else is returned. */
export function packageTexts(stateDir: string, id: unknown): { version: string; skills: { id: string; text: string }[]; promptTemplates: { id: string; text: string }[] } | null {
  if (typeof id !== "string" || !validId(id)) return null;
  const found = withLibrary(stateDir, "read", root => {
    const mounted = readLibrary(root).get(id);
    if (!mounted) return null;
    const skills: { id: string; text: string }[] = [];
    for (const skill of mounted.manifest.skills) {
      const path = skill.path ? packagePath(skill.path) : null;
      if (path === null || !TEXT_FILE.test(path) || !present(mounted.source, path)) continue;
      const file = join(mounted.source, ...path.split("/"));
      if (lstatSync(file).size <= MAX_PACKAGE_FILE_BYTES) skills.push({ id: skill.id, text: readFileSync(file, "utf8") });
    }
    return { version: mounted.version, skills, promptTemplates: mounted.manifest.promptTemplates.map(template => ({ id: template.id, text: template.template })) };
  });
  return found && "version" in found ? found : null;
}
