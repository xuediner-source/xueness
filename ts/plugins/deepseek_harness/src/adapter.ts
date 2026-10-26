/**
 * Zero-glue adapter that mounts external DeepSeek Harness packages into
 * Xueness without modifying core code (H01.01 / H01.02).
 *
 * The adapter is a pure in-memory mount table: it accepts validated
 * `HarnessPackageContract` values (or raw documents via `parseHarnessPackage`),
 * indexes every contribution under `${kind}:${name}`, and refuses duplicates.
 * Hosts consume `list()` / `lookup()`; nothing here imports or executes harness
 * source.
 */
import {
  HARNESS_CONTRACT_API_VERSION,
  parseHarnessPackage,
  type ContractIssue,
  type HarnessContribution,
  type HarnessContributionKind,
  type HarnessPackageContract,
} from "./contracts.ts";

export { HARNESS_CONTRACT_API_VERSION, parseHarnessPackage };
export type { ContractIssue, HarnessContribution, HarnessContributionKind, HarnessPackageContract };

export interface MountedContribution {
  key: string;
  contribution: HarnessContribution;
  owner: string;
}

export interface MountedPackage {
  id: string;
  version: string;
  contributions: readonly MountedContribution[];
}

export interface AdapterMountResult {
  ok: true;
  package: MountedPackage;
}

export interface AdapterMountFailure {
  ok: false;
  code: "invalid_package" | "already_mounted" | "contribution_conflict";
  message: string;
  issues?: readonly ContractIssue[];
  conflictKey?: string;
  conflictOwner?: string;
}

function contributionKey(contribution: HarnessContribution): string {
  if (contribution.kind === "tool" || contribution.kind === "verifier") return `${contribution.kind}:${contribution.name}`;
  if (contribution.kind === "hook") return `hook:${contribution.event}:${contribution.handler}`;
  return `${contribution.kind}:${contribution.id}`;
}

/** In-memory zero-glue mount table for harness packages. */
export class HarnessAdapter {
  readonly #packages = new Map<string, MountedPackage>();
  readonly #index = new Map<string, MountedContribution>();

  get size(): number {
    return this.#packages.size;
  }

  /** Mount a validated package, or parse+mount a raw document. */
  mount(input: HarnessPackageContract | unknown): AdapterMountResult | AdapterMountFailure {
    const parsed = isPackage(input) ? { ok: true as const, package: input } : parseHarnessPackage(input);
    if (!parsed.ok) {
      return { ok: false, code: "invalid_package", message: "harness package failed contract validation", issues: parsed.issues };
    }
    const pkg = parsed.package;
    if (this.#packages.has(pkg.id)) {
      return { ok: false, code: "already_mounted", message: `harness ${pkg.id} is already mounted` };
    }
    for (const contribution of pkg.contributions) {
      const key = contributionKey(contribution);
      const existing = this.#index.get(key);
      if (existing) {
        return {
          ok: false,
          code: "contribution_conflict",
          message: `contribution ${key} already owned by ${existing.owner}`,
          conflictKey: key,
          conflictOwner: existing.owner,
        };
      }
    }
    const mounted: MountedContribution[] = pkg.contributions.map((contribution) => ({
      key: contributionKey(contribution),
      contribution,
      owner: pkg.id,
    }));
    for (const row of mounted) this.#index.set(row.key, row);
    const entry: MountedPackage = { id: pkg.id, version: pkg.version, contributions: mounted };
    this.#packages.set(pkg.id, entry);
    return { ok: true, package: entry };
  }

  unmount(id: string): boolean {
    const entry = this.#packages.get(id);
    if (!entry) return false;
    for (const row of entry.contributions) this.#index.delete(row.key);
    this.#packages.delete(id);
    return true;
  }

  list(): readonly MountedPackage[] {
    return [...this.#packages.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  lookup(key: string): MountedContribution | null {
    return this.#index.get(key) ?? null;
  }

  /** Contributions of one kind across every mounted package, key-sorted. */
  listByKind(kind: HarnessContributionKind): readonly MountedContribution[] {
    return [...this.#index.values()]
      .filter((row) => row.contribution.kind === kind)
      .sort((left, right) => left.key.localeCompare(right.key));
  }
}

function isPackage(value: unknown): value is HarnessPackageContract {
  return typeof value === "object" && value !== null && (value as HarnessPackageContract).sdkApiVersion === HARNESS_CONTRACT_API_VERSION
    && typeof (value as HarnessPackageContract).id === "string"
    && Array.isArray((value as HarnessPackageContract).contributions);
}
