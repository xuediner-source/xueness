/**
 * Hot loader for external DeepSeek Harness sources (H01.05).
 *
 * A harness source is either a *directory* shipping a `deepseek-harness.json`
 * manifest or a *package* whose `package.json` carries a `xuenessHarness`
 * block. Both are declarative data manifests: the loader never imports,
 * evaluates or executes anything from a source (zero glue, as the plugin
 * gate enforces for this plugin's own sources too).
 *
 * Loading is all-or-nothing. The manifest is parsed and fully validated
 * before anything is mounted; if the mount target refuses halfway, the
 * loader unmounts whatever landed and reports a structured error, so a
 * failed load always leaves the registry exactly as it was.
 */
import { lstatSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/** SDK apiVersion a harness manifest must target (see H01.01 contracts). */
export const HARNESS_SDK_API_VERSION = 1;
/** Manifest file name of a directory source. */
export const HARNESS_MANIFEST_FILE = "deepseek-harness.json";
export const MAX_MANIFEST_BYTES = 256 * 1024;
export const MAX_CONTRIBUTIONS = 200;

export type HarnessSourceKind = "directory" | "package";

export interface Issue {
  path: string;
  message: string;
}

export interface HarnessToolDeclaration {
  name: string;
  gate: string;
  mutating: boolean;
  description: string;
}

export interface HarnessHookDeclaration {
  event: string;
  handler: string;
}

export interface HarnessVerifierDeclaration {
  name: string;
  command: string;
}

export interface HarnessSkillDeclaration {
  id: string;
  path: string;
}

export interface HarnessPromptTemplateDeclaration {
  id: string;
  template: string;
}

/** A validated harness manifest: pure data, no code references to run. */
export interface HarnessManifest {
  sdkApiVersion: number;
  id: string;
  version: string;
  tools: HarnessToolDeclaration[];
  hooks: HarnessHookDeclaration[];
  verifiers: HarnessVerifierDeclaration[];
  skills: HarnessSkillDeclaration[];
  promptTemplates: HarnessPromptTemplateDeclaration[];
}

/** What a mount looks like once it is live in the registry. */
export interface HarnessMountSnapshot {
  id: string;
  kind: HarnessSourceKind;
  source: string;
  version: string;
  manifest: HarnessManifest;
  loadedAt: string;
}

/** The loader's view of the registry: mount/unmount only, so any ordered store fits. */
export interface HarnessMountTarget {
  /** Insert one snapshot; may throw halfway through, after inserting part of it. */
  mount(snapshot: HarnessMountSnapshot): void;
  /** Remove a mount by harness id; true when one was there. */
  unmount(id: string): boolean;
}

export type LoadResult = { ok: true; entry: HarnessMountSnapshot } | { ok: false; error: HarnessLoadError };

export interface HarnessLoadError {
  code: "not_found" | "not_a_directory" | "manifest_missing" | "unreadable" | "symlink_refused" | "too_large" | "invalid_json" | "invalid_manifest" | "already_mounted" | "mount_refused";
  message: string;
  issues?: Issue[];
}

export interface LoadOptions {
  /** Injectable clock so tests get deterministic `loadedAt` stamps. */
  now?: () => string;
}

const ID = /^[a-z][a-z0-9_-]*$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const NAME = /^[a-z][a-z0-9_-]*$/;
const EVENT = /^[a-z][a-z0-9_.-]*$/;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

/** Pure validation of one parsed manifest document; empty issues means valid. */
export function harnessManifestIssues(document: unknown): Issue[] {
  const issues: Issue[] = [];
  if (!isObject(document)) return [{ path: "", message: "manifest must be a JSON object" }];
  if (document.sdkApiVersion !== HARNESS_SDK_API_VERSION) issues.push({ path: "/sdkApiVersion", message: `must be ${HARNESS_SDK_API_VERSION}` });
  if (typeof document.id !== "string" || !ID.test(document.id)) issues.push({ path: "/id", message: "is not a valid harness id" });
  if (typeof document.version !== "string" || !VERSION.test(document.version)) issues.push({ path: "/version", message: "must be MAJOR.MINOR.PATCH" });
  const seen = new Map<string, Set<string>>();
  const claim = (kind: string, key: string, index: number): void => {
    const taken = seen.get(kind) ?? new Set<string>();
    if (taken.has(key)) issues.push({ path: `/${kind}/${index}`, message: `duplicates contribution ${JSON.stringify(key)}` });
    else taken.add(key);
    seen.set(kind, taken);
  };
  rows(document.tools).forEach((tool, index) => {
    if (typeof tool.name !== "string" || !NAME.test(tool.name)) issues.push({ path: `/tools/${index}/name`, message: "is not a valid tool name" });
    else claim("tools", tool.name, index);
    if (typeof tool.gate !== "string" || !NAME.test(tool.gate)) issues.push({ path: `/tools/${index}/gate`, message: "is not a valid gate kind" });
    if (typeof tool.mutating !== "boolean") issues.push({ path: `/tools/${index}/mutating`, message: "must be a boolean" });
  });
  rows(document.hooks).forEach((hook, index) => {
    if (typeof hook.event !== "string" || !EVENT.test(hook.event)) issues.push({ path: `/hooks/${index}/event`, message: "is not a valid event name" });
    if (typeof hook.handler !== "string" || !hook.handler.trim()) issues.push({ path: `/hooks/${index}/handler`, message: "must be a non-empty handler reference" });
    else claim("hooks", `${hook.event}:${hook.handler}`, index);
  });
  rows(document.verifiers).forEach((verifier, index) => {
    if (typeof verifier.name !== "string" || !NAME.test(verifier.name)) issues.push({ path: `/verifiers/${index}/name`, message: "is not a valid verifier name" });
    else claim("verifiers", verifier.name, index);
  });
  rows(document.skills).forEach((skill, index) => {
    if (typeof skill.id !== "string" || !skill.id.trim()) issues.push({ path: `/skills/${index}/id`, message: "must be a non-empty skill id" });
    else claim("skills", skill.id, index);
  });
  rows(document.promptTemplates).forEach((template, index) => {
    if (typeof template.id !== "string" || !template.id.trim()) issues.push({ path: `/promptTemplates/${index}/id`, message: "must be a non-empty template id" });
    else claim("promptTemplates", template.id, index);
    if (typeof template.template !== "string" || !template.template.trim()) issues.push({ path: `/promptTemplates/${index}/template`, message: "must be a non-empty template body" });
  });
  for (const [kind, count] of [["tools", rows(document.tools)], ["hooks", rows(document.hooks)], ["verifiers", rows(document.verifiers)], ["skills", rows(document.skills)], ["promptTemplates", rows(document.promptTemplates)]] as const) {
    if (count.length > MAX_CONTRIBUTIONS) issues.push({ path: `/${kind}`, message: `lists more than ${MAX_CONTRIBUTIONS} entries` });
  }
  return issues;
}

/** Parse and validate one manifest document; `manifest` is null when invalid. */
export function parseHarnessManifest(document: unknown): { manifest: HarnessManifest | null; issues: Issue[] } {
  const issues = harnessManifestIssues(document);
  if (issues.length || !isObject(document)) return { manifest: null, issues };
  const doc = document;
  return {
    manifest: {
      sdkApiVersion: HARNESS_SDK_API_VERSION,
      id: doc.id as string,
      version: doc.version as string,
      tools: rows(doc.tools).map((tool) => ({ name: tool.name as string, gate: tool.gate as string, mutating: tool.mutating as boolean, description: text(tool.description) })),
      hooks: rows(doc.hooks).map((hook) => ({ event: hook.event as string, handler: hook.handler as string })),
      verifiers: rows(doc.verifiers).map((verifier) => ({ name: verifier.name as string, command: text(verifier.command) })),
      skills: rows(doc.skills).map((skill) => ({ id: skill.id as string, path: text(skill.path) })),
      promptTemplates: rows(doc.promptTemplates).map((template) => ({ id: template.id as string, template: template.template as string })),
    },
    issues: [],
  };
}

/** Read one bounded, non-symlinked JSON file; refuses before any parsing. */
function readJsonSafe(path: string, limit: number): { ok: true; document: unknown } | { ok: false; code: "unreadable" | "symlink_refused" | "too_large" | "invalid_json"; message: string } {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    return { ok: false, code: "unreadable", message: `cannot stat ${path}` };
  }
  if (info.isSymbolicLink()) return { ok: false, code: "symlink_refused", message: `manifest must not be a symlink: ${path}` };
  let raw: string;
  try {
    const file = statSync(path);
    if (!file.isFile()) return { ok: false, code: "unreadable", message: `not a regular file: ${path}` };
    if (file.size > limit) return { ok: false, code: "too_large", message: `manifest exceeds ${limit} bytes: ${path}` };
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return { ok: false, code: "unreadable", message: `cannot read ${path}: ${(error as Error).message}` };
  }
  try {
    return { ok: true, document: JSON.parse(raw) as unknown };
  } catch (error) {
    return { ok: false, code: "invalid_json", message: `${path}: ${(error as Error).message}` };
  }
}

export interface ReadManifestResult {
  kind: HarnessSourceKind;
  manifest: HarnessManifest;
}

/**
 * Read a harness manifest from a directory or package source:
 * `package.json` with an `xuenessHarness` block wins, then
 * `deepseek-harness.json`. Absolute or relative paths both work.
 */
export function readHarnessManifest(source: string): { ok: true; source: ReadManifestResult } | { ok: false; error: HarnessLoadError } {
  const dir = isAbsolute(source) ? source : resolve(source);
  let stats;
  try {
    stats = statSync(dir);
  } catch {
    return { ok: false, error: { code: "not_found", message: `harness source not found: ${dir}` } };
  }
  if (!stats.isDirectory()) return { ok: false, error: { code: "not_a_directory", message: `harness source must be a directory: ${dir}` } };
  const packageRead = readJsonSafe(join(dir, "package.json"), MAX_MANIFEST_BYTES);
  if (!packageRead.ok && packageRead.code === "symlink_refused") return { ok: false, error: { code: packageRead.code, message: packageRead.message } };
  if (packageRead.ok && isObject(packageRead.document) && isObject(packageRead.document.xuenessHarness)) {
    const parsed = parseHarnessManifest(packageRead.document.xuenessHarness);
    if (parsed.manifest) return { ok: true, source: { kind: "package", manifest: parsed.manifest } };
    return { ok: false, error: { code: "invalid_manifest", message: `package.json xuenessHarness block is invalid: ${dir}`, issues: parsed.issues } };
  }
  const harnessRead = readJsonSafe(join(dir, HARNESS_MANIFEST_FILE), MAX_MANIFEST_BYTES);
  if (harnessRead.ok) {
    const parsed = parseHarnessManifest(harnessRead.document);
    if (parsed.manifest) return { ok: true, source: { kind: "directory", manifest: parsed.manifest } };
    return { ok: false, error: { code: "invalid_manifest", message: `${HARNESS_MANIFEST_FILE} is invalid: ${dir}`, issues: parsed.issues } };
  }
  if (!harnessRead.ok && harnessRead.code === "unreadable") return { ok: false, error: { code: "manifest_missing", message: `no ${HARNESS_MANIFEST_FILE} and no package.json xuenessHarness block in ${dir}` } };
  if (!harnessRead.ok) return { ok: false, error: { code: harnessRead.code, message: harnessRead.message } };
  return { ok: false, error: { code: "manifest_missing", message: `no ${HARNESS_MANIFEST_FILE} and no package.json xuenessHarness block in ${dir}` } };
}

/** Thrown by a mount target when the harness id is already live; the loader must not roll the existing mount back. */
export class HarnessAlreadyMountedError extends Error {
  override name = "HarnessAlreadyMountedError";
}

/**
 * Hot-load one source into the mount target. Validation happens before any
 * mutation; when the target refuses mid-mount, the partial mount is rolled
 * back and the failure is reported, leaving prior mounts untouched.
 */
export function loadHarness(target: HarnessMountTarget, source: string, options: LoadOptions = {}): LoadResult {
  const read = readHarnessManifest(source);
  if (!read.ok) return { ok: false, error: read.error };
  const { kind, manifest } = read.source;
  const entry: HarnessMountSnapshot = {
    id: manifest.id,
    kind,
    source: isAbsolute(source) ? source : resolve(source),
    version: manifest.version,
    manifest,
    loadedAt: (options.now ?? ((): string => new Date().toISOString()))(),
  };
  try {
    target.mount(entry);
  } catch (error) {
    // A duplicate id never inserted anything; anything else may have landed
    // part of the mount, so unmount it before reporting.
    if (error instanceof HarnessAlreadyMountedError) return { ok: false, error: { code: "already_mounted", message: error.message } };
    target.unmount(entry.id);
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: { code: "mount_refused", message } };
  }
  return { ok: true, entry };
}
