/**
 * Rule pack importer (H04.03/H04.04): brings external rule formats into the
 * harness registry as declarative mounts, with zero glue.
 *
 * Recognized formats at a source root:
 *   cursor           `.cursorrules` and/or `.cursor/rules/*.mdc|*.md` files
 *                    become prompt templates of one converted harness.
 *   claude-skills    `.claude/skills/<id>/SKILL.md` directories become skill
 *                    contributions with source-relative paths.
 *   deepseek-harness `deepseek-harness.json`, `.deepseek-harness.json` or a
 *                    `package.json` `xuenessHarness` block mounts natively,
 *                    exactly as the H01 hot loader reads it — no conversion.
 *
 * H04.04 adds `importToolBundle`: an external MCP/tool harness bundle is a
 * native harness source that declares tools (gate `mcp` for MCP-exposed
 * ones). Importing is plain loading, so the registry's list/verify report it
 * like any other mount — the "zero glue" rule of H01 holds: nothing from a
 * source is ever imported as code, evaluated or executed.
 *
 * An import is all-or-nothing: every detected format is converted and
 * validated first, then all mounts land; any refusal rolls back what this
 * call mounted, leaving the target exactly as it was.
 */
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import {
  HARNESS_SDK_API_VERSION, HarnessAlreadyMountedError, MAX_MANIFEST_BYTES, parseHarnessManifest, readHarnessManifest,
  type HarnessManifest, type HarnessMountSnapshot, type HarnessMountTarget, type Issue, type LoadOptions,
} from "../loader.ts";

/** Classic Cursor rule file at a project root. */
export const CURSOR_RULES_FILE = ".cursorrules";
/** Newer Cursor rule directory (`.mdc`/`.md` rule files). */
export const CURSOR_RULES_DIR = ".cursor/rules";
/** Claude skills directory; each child with a SKILL.md is one skill. */
export const CLAUDE_SKILLS_DIR = ".claude/skills";
/** Project-local dot-file variant of the harness manifest. */
export const DEEPSEEK_HARNESS_DOTFILE = ".deepseek-harness.json";
/** Version stamped on converted packs; the source formats carry none. */
export const IMPORTED_PACK_VERSION = "0.1.0";
export const RULE_PACK_FORMATS = ["cursor", "claude-skills", "deepseek-harness"] as const;
export type RulePackFormat = (typeof RULE_PACK_FORMATS)[number];

/** One landed import: which format it came from and its mount snapshot. */
export interface RulePackImport {
  format: RulePackFormat;
  entry: HarnessMountSnapshot;
}

export type RulePackErrorCode =
  | "not_found" | "not_a_directory" | "format_unknown" | "empty_pack" | "unreadable" | "symlink_refused"
  | "too_large" | "invalid_json" | "invalid_manifest" | "manifest_missing" | "not_a_bundle" | "already_mounted" | "mount_refused";

export interface RulePackError {
  code: RulePackErrorCode;
  message: string;
  issues?: Issue[];
}

export type RulePacksResult = { ok: true; imported: RulePackImport[] } | { ok: false; error: RulePackError };
export type BundleImportResult = { ok: true; entry: HarnessMountSnapshot } | { ok: false; error: RulePackError };

export interface RulePackOptions extends LoadOptions {
  /** Base id for converted packs; defaults to the source directory name. */
  id?: string;
}

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** Include links in detection so readTextSafe can refuse them, even when their target is absent or a directory. */
const isRuleFileCandidate = (path: string): boolean => {
  try {
    const info = lstatSync(path);
    return info.isSymbolicLink() || info.isFile();
  } catch {
    return false;
  }
};

/** One bounded, non-symlinked text file; refuses before any parsing. */
function readTextSafe(path: string): { ok: true; text: string } | { ok: false; error: RulePackError } {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    return { ok: false, error: { code: "unreadable", message: `cannot stat ${path}` } };
  }
  if (info.isSymbolicLink()) return { ok: false, error: { code: "symlink_refused", message: `rule file must not be a symlink: ${path}` } };
  try {
    const file = statSync(path);
    if (!file.isFile()) return { ok: false, error: { code: "unreadable", message: `not a regular file: ${path}` } };
    if (file.size > MAX_MANIFEST_BYTES) return { ok: false, error: { code: "too_large", message: `rule file exceeds ${MAX_MANIFEST_BYTES} bytes: ${path}` } };
    return { ok: true, text: readFileSync(path, "utf8") };
  } catch (error) {
    return { ok: false, error: { code: "unreadable", message: `cannot read ${path}: ${(error as Error).message}` } };
  }
}

/** Stable slug for ids derived from file or directory names. */
export function slugify(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** A valid harness id from a slug: letter-first, with a fallback prefix. */
function packId(slug: string, fallback: string): string {
  const base = slug || fallback;
  return /^[a-z]/.test(base) ? base : `pack-${base}`;
}

/** Which rule pack formats a directory source carries, in detection order. */
export function detectRulePackFormats(source: string): { ok: true; formats: RulePackFormat[] } | { ok: false; error: RulePackError } {
  const dir = isAbsolute(source) ? source : resolve(source);
  let stats;
  try {
    stats = statSync(dir);
  } catch {
    return { ok: false, error: { code: "not_found", message: `rule pack source not found: ${dir}` } };
  }
  if (!stats.isDirectory()) return { ok: false, error: { code: "not_a_directory", message: `rule pack source must be a directory: ${dir}` } };
  const formats: RulePackFormat[] = [];
  const native = readHarnessManifest(dir);
  if (native.ok || isRuleFileCandidate(join(dir, DEEPSEEK_HARNESS_DOTFILE))) formats.push("deepseek-harness");
  if (isRuleFileCandidate(join(dir, CURSOR_RULES_FILE)) || isDirectory(join(dir, CURSOR_RULES_DIR))) formats.push("cursor");
  if (isDirectory(join(dir, CLAUDE_SKILLS_DIR))) formats.push("claude-skills");
  return { ok: true, formats };
}

const emptyManifest = (id: string): HarnessManifest => ({
  sdkApiVersion: HARNESS_SDK_API_VERSION, id, version: IMPORTED_PACK_VERSION,
  tools: [], hooks: [], verifiers: [], skills: [], promptTemplates: [],
});

/** Cursor rules → prompt templates: `.cursorrules` plus every `.mdc`/`.md` under `.cursor/rules`. */
function cursorManifest(root: string, id: string): { ok: true; manifest: HarnessManifest } | { ok: false; error: RulePackError } {
  const templates: Array<{ id: string; template: string }> = [];
  const add = (id: string, path: string): RulePackError | null => {
    const read = readTextSafe(path);
    if (!read.ok) return read.error;
    const body = read.text.trim();
    if (!body) return { code: "empty_pack", message: `rule file is empty: ${path}` };
    templates.push({ id, template: body });
    return null;
  };
  const main = join(root, CURSOR_RULES_FILE);
  if (isRuleFileCandidate(main)) {
    const failure = add("cursor-rules", main);
    if (failure) return { ok: false, error: failure };
  }
  const rulesDir = join(root, CURSOR_RULES_DIR);
  if (isDirectory(rulesDir)) {
    const names = readdirSync(rulesDir).filter((name) => name.endsWith(".mdc") || name.endsWith(".md")).sort();
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index] as string;
      const failure = add(slugify(name.replace(/\.mdc?$/, "")) || `rule-${index + 1}`, join(rulesDir, name));
      if (failure) return { ok: false, error: failure };
    }
  }
  if (!templates.length) return { ok: false, error: { code: "empty_pack", message: `no Cursor rules found in ${root}` } };
  const used = new Set<string>();
  for (const template of templates) {
    while (used.has(template.id)) template.id = `${template.id}-2`;
    used.add(template.id);
  }
  return { ok: true, manifest: { ...emptyManifest(id), promptTemplates: templates } };
}

/** Claude skills → skill contributions with paths relative to the source root. */
function claudeSkillsManifest(root: string, id: string): { ok: true; manifest: HarnessManifest } | { ok: false; error: RulePackError } {
  const skillsDir = join(root, ...CLAUDE_SKILLS_DIR.split("/"));
  const skills: Array<{ id: string; path: string }> = [];
  let failure: RulePackError | null = null;
  for (const entry of readdirSync(skillsDir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const skillFile = join(skillsDir, entry.name, "SKILL.md");
    if (!isRuleFileCandidate(skillFile)) continue;
    const read = readTextSafe(skillFile);
    if (!read.ok) {
      failure = read.error;
      break;
    }
    if (!read.text.trim()) {
      failure = { code: "empty_pack", message: `skill file is empty: ${skillFile}` };
      break;
    }
    skills.push({ id: slugify(entry.name) || `skill-${skills.length + 1}`, path: `${CLAUDE_SKILLS_DIR}/${entry.name}/SKILL.md` });
  }
  if (failure) return { ok: false, error: failure };
  if (!skills.length) return { ok: false, error: { code: "empty_pack", message: `no skills with a SKILL.md under ${skillsDir}` } };
  return { ok: true, manifest: { ...emptyManifest(id), skills } };
}

/** Mount every plan or nothing: rolls back what landed when a target refuses. */
function mountAll(target: HarnessMountTarget, plans: RulePackImport[]): RulePackError | null {
  const mounted: string[] = [];
  try {
    for (const plan of plans) {
      target.mount(plan.entry);
      mounted.push(plan.entry.id);
    }
  } catch (error) {
    for (const id of mounted) target.unmount(id);
    if (error instanceof HarnessAlreadyMountedError) return { code: "already_mounted", message: error.message };
    return { code: "mount_refused", message: error instanceof Error ? error.message : String(error) };
  }
  return null;
}

/**
 * Import every rule pack format a source carries. All detected formats are
 * converted first; the mounts then land together or not at all, and any
 * refusal rolls back only what this call mounted.
 */
export function importRulePacks(target: HarnessMountTarget, source: string, options: RulePackOptions = {}): RulePacksResult {
  const detected = detectRulePackFormats(source);
  if (!detected.ok) return { ok: false, error: detected.error };
  const root = resolve(source);
  const base = packId(slugify(options.id ?? basename(root)), "imported-pack");
  const now = options.now ?? ((): string => new Date().toISOString());
  const plans: RulePackImport[] = [];
  for (const format of detected.formats) {
    let manifest: HarnessManifest;
    let kind: HarnessMountSnapshot["kind"] = "directory";
    if (format === "cursor") {
      const converted = cursorManifest(root, `${base}-cursor`);
      if (!converted.ok) return { ok: false, error: converted.error };
      manifest = converted.manifest;
    } else if (format === "claude-skills") {
      const converted = claudeSkillsManifest(root, `${base}-claude-skills`);
      if (!converted.ok) return { ok: false, error: converted.error };
      manifest = converted.manifest;
    } else {
      const native = readNativeManifest(root);
      if (!native.ok) return { ok: false, error: native.error };
      manifest = native.manifest;
      kind = native.kind;
    }
    plans.push({ format, entry: { id: manifest.id, kind, source: root, version: manifest.version, manifest, loadedAt: now() } });
  }
  const failure = mountAll(target, plans);
  return failure ? { ok: false, error: failure } : { ok: true, imported: plans };
}

/** Native manifests: the loader's own discovery, plus the project dot-file. */
function readNativeManifest(root: string): { ok: true; manifest: HarnessManifest; kind: HarnessMountSnapshot["kind"] } | { ok: false; error: RulePackError } {
  const read = readHarnessManifest(root);
  if (read.ok) return { ok: true, manifest: read.source.manifest, kind: read.source.kind };
  if (read.error.code !== "manifest_missing") return { ok: false, error: read.error };
  const dotRead = readTextSafe(join(root, DEEPSEEK_HARNESS_DOTFILE));
  if (!dotRead.ok) return { ok: false, error: dotRead.error };
  let document: unknown;
  try {
    document = JSON.parse(dotRead.text) as unknown;
  } catch (error) {
    return { ok: false, error: { code: "invalid_json", message: `${DEEPSEEK_HARNESS_DOTFILE}: ${(error as Error).message}` } };
  }
  const parsed = parseHarnessManifest(document);
  if (!parsed.manifest) return { ok: false, error: { code: "invalid_manifest", message: `${DEEPSEEK_HARNESS_DOTFILE} is invalid: ${root}`, issues: parsed.issues } };
  return { ok: true, manifest: parsed.manifest, kind: "directory" };
}

/**
 * H04.04: import an external MCP/tool harness bundle. A bundle is a native
 * harness source that declares at least one tool (gate `mcp` for MCP-exposed
 * tools); it mounts exactly as the hot loader would, so `list` and `verify`
 * treat it like any other harness — no adapter glue, no code from the bundle
 * is ever run.
 */
export function importToolBundle(target: HarnessMountTarget, source: string, options: LoadOptions = {}): BundleImportResult {
  const native = readNativeManifest(resolve(source));
  if (!native.ok) return { ok: false, error: native.error };
  if (!native.manifest.tools.length) {
    return { ok: false, error: { code: "not_a_bundle", message: `harness ${native.manifest.id} declares no tools; nothing to mount as a bundle` } };
  }
  const entry: HarnessMountSnapshot = {
    id: native.manifest.id, kind: native.kind, source: resolve(source), version: native.manifest.version,
    manifest: native.manifest, loadedAt: (options.now ?? ((): string => new Date().toISOString()))(),
  };
  const failure = mountAll(target, [{ format: "deepseek-harness", entry }]);
  return failure ? { ok: false, error: failure } : { ok: true, entry };
}
