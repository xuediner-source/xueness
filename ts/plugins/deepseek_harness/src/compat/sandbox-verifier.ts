/**
 * H04.05 — isolated worktree/container sandbox verifier.
 * H04.06 — opt-in sandboxed execution for `deepseek_harness/verify`.
 *
 * A sandbox verifier clones the workspace into an isolated directory (a
 * worktree sandbox) or a container-backed root, runs the H02 auto-verify
 * gate table *inside* that clone, and — when a gate fails — rolls the clone
 * back to the snapshot taken before the gates ran. The source workspace is
 * never touched, so a failing gate can never leave mutations behind.
 *
 * Everything that touches files or processes is injected (`SandboxFs`,
 * `GateRunner`), mirroring the auto-verify module: the isolation, snapshot
 * and rollback rules are pure and unit-testable without spawning anything;
 * `nodeSandboxFs` and `spawnGateRunner` are the production implementations.
 */
import { basename, isAbsolute, join, relative } from "node:path";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import {
  createAutoVerify, spawnGateRunner,
  type CompressionLimits, type GateDefinition, type GateOutcome, type GateRunner,
} from "../builtins/auto-verify.ts";
import type { HarnessApi } from "../index.ts";

/** Isolation strategy: a directory clone, or a container-backed root. */
export type SandboxKind = "worktree" | "container";

/** Minimal directory tree the sandbox manipulates; text round-trip only. */
export interface SandboxFs {
  /** Every file under `dir`, as `/`-separated paths relative to `dir`. */
  list(dir: string): string[];
  read(path: string): string;
  write(path: string, content: string): void;
  mkdir(path: string): void;
  remove(path: string): void;
  exists(path: string): boolean;
}

/** Production `SandboxFs` over `node:fs`; writes create parent directories. */
export const nodeSandboxFs: SandboxFs = {
  list(dir: string): string[] {
    const out: string[] = [];
    const walk = (current: string): void => {
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = join(current, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile()) out.push(relative(dir, path).split("\\").join("/"));
      }
    };
    walk(dir);
    return out.sort();
  },
  read: (path) => readFileSync(path, "utf8"),
  write: (path, content) => {
    const parent = join(path, "..");
    if (!nodeSandboxFs.exists(parent)) mkdirSync(parent, { recursive: true });
    writeFileSync(path, content, "utf8");
  },
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  remove: (path) => rmSync(path, { recursive: true, force: true }),
  exists: (path) => {
    try {
      return statSync(path).isFile() || statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
};

/** Files of one sandbox root at snapshot time: relative path → content. */
export interface SandboxSnapshot {
  readonly root: string;
  readonly files: ReadonlyMap<string, string>;
}

/** What one rollback actually did, so callers can audit the restore. */
export interface SandboxRollbackReport {
  /** Mutated files whose snapshot content was written back. */
  readonly restored: string[];
  /** Files created after the snapshot and deleted by the rollback. */
  readonly removed: string[];
}

/** How long a sandbox directory survives after `verify` returns. */
export type KeepSandbox = "always" | "never" | "onFailure";

export interface Sandbox {
  readonly id: string;
  readonly kind: SandboxKind;
  /** Isolated root the gates run in; never the source workspace. */
  readonly root: string;
  /** The workspace directory the sandbox was cloned from. */
  readonly source: string;
  snapshot(): SandboxSnapshot;
  rollback(snapshot: SandboxSnapshot): SandboxRollbackReport;
  dispose(): void;
}

const DEFAULT_EXCLUDES = ["node_modules", ".git", "dist", ".tmp"];

const isExcluded = (path: string, excludes: readonly string[]): boolean =>
  excludes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

/**
 * `fs.list` returns `/`-separated paths, so the sandbox root's own relative
 * path is `/`-normalized too. Comparing a raw `node:path.join` result never
 * matches on Windows and, once the clone descends into the nested root path,
 * makes the sandbox copy itself recursively.
 */
const rootWithinSource = (source: string, root: string): string | null => {
  const path = relative(source, root).split("\\").join("/");
  return path.startsWith("..") || isAbsolute(path) ? null : path;
};

function createSandbox(fs: SandboxFs, kind: SandboxKind, source: string, root: string, excludes: readonly string[]): Sandbox {
  fs.mkdir(root);
  const skip = rootWithinSource(source, root);
  /** Paths belonging to the nested sandbox root are never workspace content. */
  const hidden = (path: string): boolean => skip !== null && (path === skip || path.startsWith(`${skip}/`));
  const clone = (): void => {
    for (const path of fs.list(source)) {
      if (isExcluded(path, excludes) || hidden(path)) continue;
      fs.write(join(root, path), fs.read(join(source, path)));
    }
  };
  clone();
  return {
    id: basename(root),
    kind,
    root,
    source,
    snapshot(): SandboxSnapshot {
      const files = new Map<string, string>();
      for (const path of fs.list(root)) {
        if (isExcluded(path, excludes) || hidden(path)) continue;
        files.set(path, fs.read(join(root, path)));
      }
      return { root, files };
    },
    rollback(snapshot: SandboxSnapshot): SandboxRollbackReport {
      const current = new Set<string>();
      for (const path of fs.list(root)) if (!isExcluded(path, excludes) && !hidden(path)) current.add(path);
      const restored: string[] = [];
      const removed: string[] = [];
      for (const [path, content] of snapshot.files) {
        // A deleted or rewritten snapshot file is restored: rolling back to the
        // snapshot must reinstate it, not just undo in-place edits.
        if (!current.has(path) || fs.read(join(root, path)) !== content) {
          fs.write(join(root, path), content);
          restored.push(path);
        }
        current.delete(path);
      }
      for (const path of current) {
        fs.remove(join(root, path));
        removed.push(path);
      }
      return { restored: restored.sort(), removed: removed.sort() };
    },
    dispose(): void {
      fs.remove(root);
    },
  };
}

/** Container spec: how gate commands are wrapped for the container runtime. */
export interface ContainerSpec {
  /** Image the gate commands run in, e.g. `node:24`. */
  readonly image: string;
  /** Read-only mount point of the sandbox root inside the container. */
  readonly workdir?: string;
}

/** Wraps one gate command into a container invocation for `spec`. */
export function containerCommand(spec: ContainerSpec, gate: GateDefinition, root: string): GateDefinition {
  const workdir = spec.workdir ?? "/workspace";
  return { ...gate, command: ["docker", "run", "--rm", "-v", `${root}:${workdir}`, "-w", workdir, spec.image, ...gate.command] };
}

export interface SandboxVerifyOptions {
  /** Gate table, validated once when the verifier is created. */
  readonly gates: readonly GateDefinition[];
  /** Workspace directory to isolate; gates never run here. Defaults to `.`. */
  readonly cwd?: string;
  /** Isolation strategy; defaults to `worktree`. */
  readonly kind?: SandboxKind;
  /** Container spec required when `kind` is `container`. */
  readonly container?: ContainerSpec;
  /** Parent directory sandboxes are created under; defaults to `<cwd>/.sandboxes`. */
  readonly sandboxRoot?: string;
  /** Source-relative prefixes skipped by clone/snapshot (defaults: build dirs). */
  readonly excludes?: readonly string[];
  /** Directory tree implementation; defaults to `nodeSandboxFs`. */
  readonly fs?: SandboxFs;
  /** Gate executor inside a worktree sandbox; defaults to `spawnGateRunner`. */
  readonly run?: GateRunner;
  /** Sandbox lifetime; defaults to `onFailure` (kept for diagnostics). */
  readonly keep?: KeepSandbox;
  readonly defaultTimeoutMs?: number;
  readonly limits?: CompressionLimits;
  readonly now?: () => number;
}

/** One sandboxed verify pass: gate outcomes plus the rollback decision. */
export interface SandboxVerifyResult {
  readonly passed: boolean;
  readonly sandbox: { readonly id: string; readonly kind: SandboxKind; readonly root: string; readonly source: string };
  /** True when a failing gate triggered a snapshot rollback. */
  readonly rolledBack: boolean;
  readonly restored: readonly string[];
  readonly removed: readonly string[];
  readonly outcomes: readonly GateOutcome[];
  readonly summary: string;
  /** Sandbox root kept on disk for inspection, or null when disposed. */
  readonly keptRoot: string | null;
}

export interface SandboxVerifier {
  readonly gates: readonly GateDefinition[];
  /**
   * Clone the workspace into a fresh sandbox, run the gates selected by
   * `edited` inside it, roll back to the pre-gate snapshot on any failure,
   * then keep or dispose the sandbox per the `keep` policy.
   */
  verify(edited?: readonly string[]): Promise<SandboxVerifyResult>;
}

function validateSandboxGates(gates: readonly GateDefinition[], kind: SandboxKind, container: ContainerSpec | undefined): void {
  for (const gate of gates) {
    if (!gate.name.trim()) throw new Error("sandbox-verifier: every gate needs a non-empty name");
    if (gate.command.length === 0 || gate.command.some((part) => !part.trim())) {
      throw new Error(`sandbox-verifier: gate ${gate.name} needs a non-empty command`);
    }
  }
  if (kind === "container" && container === undefined) throw new Error("sandbox-verifier: container sandboxes need a container image");
}

export function createSandboxVerifier(options: SandboxVerifyOptions): SandboxVerifier {
  const kind = options.kind ?? "worktree";
  validateSandboxGates(options.gates, kind, options.container);
  const fs = options.fs ?? nodeSandboxFs;
  const source = options.cwd ?? ".";
  const sandboxRoot = options.sandboxRoot ?? join(source, ".sandboxes");
  const excludes = options.excludes ?? DEFAULT_EXCLUDES;
  const run = options.run ?? spawnGateRunner;
  const keep = options.keep ?? "onFailure";
  let counter = 0;
  return {
    gates: options.gates,
    async verify(edited): Promise<SandboxVerifyResult> {
      counter += 1;
      const root = join(sandboxRoot, `${kind}-${process.pid}-${counter}`);
      const sandbox = createSandbox(fs, kind, source, root, excludes);
      const container = kind === "container" ? options.container : undefined;
      const inner = createAutoVerify({
        gates: container ? options.gates.map((g) => containerCommand(container, g, sandbox.root)) : options.gates,
        cwd: sandbox.root,
        run,
        defaultTimeoutMs: options.defaultTimeoutMs,
        limits: options.limits,
        now: options.now,
      });
      const snapshot = sandbox.snapshot();
      const summary = await inner.verify(edited);
      let rollback: SandboxRollbackReport = { restored: [], removed: [] };
      if (!summary.passed) rollback = sandbox.rollback(snapshot);
      const failure = !summary.passed;
      const shouldKeep = keep === "always" || (keep === "onFailure" && failure);
      if (!shouldKeep) sandbox.dispose();
      return {
        passed: summary.passed,
        sandbox: { id: sandbox.id, kind, root: sandbox.root, source: sandbox.source },
        rolledBack: failure,
        restored: rollback.restored,
        removed: rollback.removed,
        outcomes: summary.outcomes,
        summary: failure ? `${summary.summary}; sandbox rolled back to snapshot` : summary.summary,
        keptRoot: shouldKeep ? sandbox.root : null,
      };
    },
  };
}

/**
 * H04.06 — wrap a `HarnessApi` so `deepseek_harness/verify` can opt into
 * sandboxed gate execution: dispatching `{ sandbox: true }` (or any of the
 * truthy spellings below) runs the configured gate table inside an isolated
 * sandbox instead of the registry's source re-read. Everything else — the
 * other methods, the feature gate, the underlying registry — is delegated
 * untouched, so the wrapped API stays a drop-in `deepseek_harness` surface.
 */
export function withSandboxedVerify(api: HarnessApi, verifier: SandboxVerifier): HarnessApi {
  const wantsSandbox = (value: unknown): boolean => value === true || value === "true" || value === 1;
  return {
    ...api,
    async dispatch(method, data) {
      const row = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
      if (method === "deepseek_harness/verify" && wantsSandbox(row.sandbox)) {
        // Feature gate first: a disabled plugin must not start a clone, a gate
        // command or a container. The wrapped API owns the same switch, so its
        // `list` dispatch is the cheapest way to learn the gate state without
        // duplicating it here; a refusal is returned verbatim (`disabled`).
        const gate = await api.dispatch("deepseek_harness/list", {});
        if (!gate.ok) return gate;
        const result = await verifier.verify();
        return { ok: result.passed, sandbox: result.sandbox, rolledBack: result.rolledBack, restored: result.restored, removed: result.removed, outcomes: result.outcomes, summary: result.summary, keptRoot: result.keptRoot };
      }
      return api.dispatch(method, data);
    },
  };
}

/** `xueness harness verify --sandbox` — the CLI arm of the H04.06 wiring. */
export async function sandboxVerifyCommand(argv: readonly string[], api: HarnessApi, verifier: SandboxVerifier): Promise<{ code: number; output: string }> {
  const flags = new Set(argv.filter((part) => part.startsWith("--")));
  const id = argv.find((part) => !part.startsWith("--"));
  const result = await withSandboxedVerify(api, verifier).dispatch("deepseek_harness/verify", { ...(id ? { id } : {}), sandbox: flags.has("--sandbox") });
  return { code: result.ok ? 0 : 1, output: JSON.stringify(result) };
}
