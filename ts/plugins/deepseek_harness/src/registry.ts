/**
 * Mount registry for hot-loaded harnesses (H01.06).
 *
 * The registry is the ordered store the loader writes through: it indexes
 * every contribution (tool, hook, verifier, skill, prompt template) under
 * `${kind}:${name}` with one owning harness, so a second mount that repeats
 * a contributed name is refused. `list` shows what is mounted; `verify`
 * re-reads each source and reports a structured, per-item check report.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import {
  HARNESS_SDK_API_VERSION, HarnessAlreadyMountedError, readHarnessManifest,
  type HarnessManifest, type HarnessMountSnapshot, type HarnessMountTarget, type HarnessSourceKind,
} from "./loader.ts";

export type ContributionKind = "tools" | "hooks" | "verifiers" | "skills" | "promptTemplates";

/** One indexed contribution: what it is and which harness owns it. */
export interface HarnessContributionRef {
  key: string;
  kind: ContributionKind;
  name: string;
  owner: string;
}

/** A live mount plus the contribution index entries it owns. */
export interface MountedHarness extends HarnessMountSnapshot {
  contributions: HarnessContributionRef[];
}

/** One row of `list`: counts only, safe to show in any panel. */
export interface HarnessListRow {
  id: string;
  version: string;
  kind: HarnessSourceKind;
  source: string;
  loadedAt: string;
  contributions: Record<ContributionKind, number>;
}

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerifyItemReport {
  id: string;
  version: string;
  kind: HarnessSourceKind;
  source: string;
  status: "ok" | "degraded";
  checks: VerifyCheck[];
}

export interface VerifyReport {
  ok: boolean;
  checked: number;
  items: VerifyItemReport[];
}

/** All contributions of one manifest, as index refs owned by `owner`. */
export function contributionRefs(manifest: HarnessManifest, owner: string): HarnessContributionRef[] {
  const refs: HarnessContributionRef[] = [];
  const add = (kind: ContributionKind, name: string): void => { refs.push({ key: `${kind}:${name}`, kind, name, owner }); };
  for (const tool of manifest.tools) add("tools", tool.name);
  for (const hook of manifest.hooks) add("hooks", `${hook.event}:${hook.handler}`);
  for (const verifier of manifest.verifiers) add("verifiers", verifier.name);
  for (const skill of manifest.skills) add("skills", skill.id);
  for (const template of manifest.promptTemplates) add("promptTemplates", template.id);
  return refs;
}

const countsOf = (manifest: HarnessManifest): Record<ContributionKind, number> => ({
  tools: manifest.tools.length,
  hooks: manifest.hooks.length,
  verifiers: manifest.verifiers.length,
  skills: manifest.skills.length,
  promptTemplates: manifest.promptTemplates.length,
});

/**
 * The in-memory registry. `mount` is atomic: it either lands with every
 * contribution indexed, or throws after restoring the previous state, so a
 * refused mount leaves nothing behind.
 */
export class HarnessRegistry implements HarnessMountTarget {
  readonly #mounts = new Map<string, MountedHarness>();
  readonly #owners = new Map<string, string>();

  mount(snapshot: HarnessMountSnapshot): void {
    if (this.#mounts.has(snapshot.id)) throw new HarnessAlreadyMountedError(`harness ${snapshot.id} is already mounted`);
    const mounted: MountedHarness = { ...snapshot, contributions: [] };
    this.#mounts.set(snapshot.id, mounted);
    const added: string[] = [];
    try {
      for (const ref of contributionRefs(snapshot.manifest, snapshot.id)) {
        const owner = this.#owners.get(ref.key);
        if (owner !== undefined) throw new Error(`${ref.kind} ${ref.name} is already contributed by harness ${owner}`);
        this.#owners.set(ref.key, snapshot.id);
        added.push(ref.key);
        mounted.contributions.push(ref);
      }
    } catch (error) {
      for (const key of added) this.#owners.delete(key);
      this.#mounts.delete(snapshot.id);
      throw error;
    }
  }

  unmount(id: string): boolean {
    const mounted = this.#mounts.get(id);
    if (!mounted) return false;
    for (const ref of mounted.contributions) this.#owners.delete(ref.key);
    this.#mounts.delete(id);
    return true;
  }

  get(id: string): MountedHarness | null {
    return this.#mounts.get(id) ?? null;
  }

  /** Contribution key → owning harness id, for cross-mount clash checks. */
  ownerOf(key: string): string | null {
    return this.#owners.get(key) ?? null;
  }

  get size(): number {
    return this.#mounts.size;
  }

  /** `list`: every mounted harness, id-sorted, with per-kind contribution counts. */
  list(): HarnessListRow[] {
    return [...this.#mounts.values()]
      .map((mounted): HarnessListRow => ({ id: mounted.id, version: mounted.version, kind: mounted.kind, source: mounted.source, loadedAt: mounted.loadedAt, contributions: countsOf(mounted.manifest) }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  #check(mounted: MountedHarness): VerifyItemReport {
    const checks: VerifyCheck[] = [];
    const push = (name: string, ok: boolean, detail: string): void => { checks.push({ name, ok, detail }); };
    push("sdk_supported", mounted.manifest.sdkApiVersion === HARNESS_SDK_API_VERSION, `manifest targets sdkApiVersion ${mounted.manifest.sdkApiVersion}, host provides ${HARNESS_SDK_API_VERSION}`);
    let directory = false;
    try {
      directory = statSync(mounted.source).isDirectory();
    } catch {
      directory = false;
    }
    push("source_present", directory, directory ? mounted.source : `source directory is gone: ${mounted.source}`);
    if (directory) {
      const read = readHarnessManifest(mounted.source);
      if (read.ok) {
        const same = read.source.manifest.id === mounted.manifest.id && read.source.manifest.version === mounted.manifest.version
          && read.source.kind === mounted.kind;
        push("manifest_current", same, same ? `source still ships ${mounted.manifest.id} ${mounted.manifest.version}` : `source changed: now ${read.source.manifest.id} ${read.source.manifest.version} (${read.source.kind})`);
      } else {
        push("manifest_current", false, `source manifest no longer loads: ${read.error.message}`);
      }
      const missing = mounted.manifest.skills
        .filter((skill) => skill.path && !existsFile(join(mounted.source, skill.path)))
        .map((skill) => skill.id);
      push("contributions_resolved", missing.length === 0, missing.length ? `skill files missing on disk: ${missing.join(", ")}` : `${mounted.contributions.length} indexed contributions`);
    } else {
      push("manifest_current", false, "source unavailable; manifest drift cannot be checked");
      push("contributions_resolved", false, "source unavailable; skill files cannot be checked");
    }
    return {
      id: mounted.id,
      version: mounted.version,
      kind: mounted.kind,
      source: mounted.source,
      status: checks.every((check) => check.ok) ? "ok" : "degraded",
      checks,
    };
  }

  /**
   * `verify`: re-read every mounted source (or one harness when `id` is
   * given) and report per-item checks. Unknown ids report as failed items
   * rather than throwing, so the report stays structured.
   */
  verify(id?: string): VerifyReport {
    const mounted = id === undefined ? [...this.#mounts.values()].sort((left, right) => left.id.localeCompare(right.id)) : [this.#mounts.get(id)].filter((entry): entry is MountedHarness => entry !== undefined);
    const items = mounted.map((entry) => this.#check(entry));
    if (id !== undefined && items.length === 0) {
      items.push({ id, version: "", kind: "directory", source: "", status: "degraded", checks: [{ name: "mounted", ok: false, detail: `harness ${id} is not mounted` }] });
    }
    return { ok: items.every((item) => item.status === "ok"), checked: items.length, items };
  }
}

function existsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
