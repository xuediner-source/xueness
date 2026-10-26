/**
 * Artifact references for dynamic workflow runs (F10.05): large node results
 * and report payloads are saved by reference under the plugin's private state
 * directory, so a run record never grows with artifact bodies.
 *
 * An artifact is content-addressed — its id is the sha256 of the canonical
 * JSON body — so saving the same value twice is one idempotent write, and a
 * reference can be verified against its file at resolve time (tampering or a
 * truncated body is a hard refusal, never silent corruption). Values at or
 * below the inline threshold stay inline: a reference is only worth its
 * bookkeeping when the body is actually large.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pyEncodeUtf8, pyJsonDumps, PyValueError } from "@xueness/contracts";
import { ensurePrivateDirectory, isSymlink, readJson, writeJsonAtomic } from "./state-file.ts";
import { resolvePath } from "./plan.ts";

/** Bodies at or below this many characters stay inline instead of by-reference. */
export const ARTIFACT_INLINE_MAX_CHARS = 2048;
/** A single artifact body may never exceed this many characters. */
export const ARTIFACT_MAX_CHARS = 8 * 1024 * 1024;

const RUN_ID = /^[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;

/** A by-reference artifact descriptor embedded where the body used to be. */
export interface DynamicArtifactRef {
  $artifact: string;
  runId: string;
  nodeId: string;
  chars: number;
  sha256: string;
  createdAt: string;
}

export interface DynamicArtifactRecord {
  id: string;
  runId: string;
  nodeId: string;
  chars: number;
  sha256: string;
  createdAt: string;
  value: unknown;
}

/** `save` outcome: inline values carry the body, stored ones only the ref. */
export type DynamicArtifactSave =
  | { stored: false; value: unknown }
  | { stored: true; ref: DynamicArtifactRef; write: "created" | "already-present" };

export function isArtifactRef(value: unknown): value is DynamicArtifactRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const ref = value as Partial<DynamicArtifactRef>;
  return typeof ref.$artifact === "string" && SHA256.test(ref.$artifact) &&
    typeof ref.runId === "string" && typeof ref.nodeId === "string" && typeof ref.chars === "number";
}

/** Canonical encoding shared by save/verify so the digest always matches. */
function canonicalBody(value: unknown): string {
  return pyJsonDumps(value, { sortKeys: true, ensureAscii: false, separators: [",", ":"] });
}

function requireRunId(runId: string): void {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new PyValueError("artifact run id must be 32 hex characters");
}

/** Private, per-run artifact directory under `<state>/dynamic-workflows/artifacts`. */
export class DynamicArtifactStore {
  readonly stateDir: string;
  readonly directory: string;

  constructor(stateDir: string) {
    if (isSymlink(stateDir)) throw new PyValueError("artifact state directory cannot be a symlink");
    this.stateDir = resolvePath(stateDir);
    this.directory = join(this.stateDir, "dynamic-workflows", "artifacts");
    if (isSymlink(this.directory)) throw new PyValueError("artifact directory cannot be a symlink");
    ensurePrivateDirectory(this.directory, "artifact directory cannot be a symlink");
  }

  #runDirectory(runId: string): string {
    requireRunId(runId);
    const path = join(this.directory, runId);
    if (isSymlink(path)) throw new PyValueError("artifact run directory cannot be a symlink");
    ensurePrivateDirectory(path, "artifact run directory cannot be a symlink");
    return path;
  }

  path(runId: string, artifactId: string): string {
    if (typeof artifactId !== "string" || !SHA256.test(artifactId)) throw new PyValueError("artifact id must be a sha256 hex digest");
    return join(this.#runDirectory(runId), `${artifactId}.json`);
  }

  /**
   * Save `value` for `nodeId`: inline when small, by-reference when large.
   * Content addressing makes repeated saves of one value idempotent — an
   * existing, byte-identical file is never rewritten.
   */
  save(runId: string, nodeId: string, value: unknown, options: { inlineMaxChars?: number } = {}): DynamicArtifactSave {
    if (typeof nodeId !== "string" || !nodeId.trim()) throw new PyValueError("artifact nodeId must be a non-empty string");
    const inlineMax = options.inlineMaxChars === undefined ? ARTIFACT_INLINE_MAX_CHARS : options.inlineMaxChars;
    if (!Number.isInteger(inlineMax) || inlineMax < 0) throw new PyValueError("inlineMaxChars must be a non-negative integer");
    const body = canonicalBody(value);
    if (body.length <= inlineMax) return { stored: false, value };
    if (body.length > ARTIFACT_MAX_CHARS) throw new PyValueError(`artifact body of ${body.length} chars exceeds the ${ARTIFACT_MAX_CHARS} cap`);
    const digest = createHash("sha256").update(pyEncodeUtf8(body)).digest("hex");
    const destination = this.path(runId, digest);
    const record: DynamicArtifactRecord = {
      id: digest, runId, nodeId, chars: body.length, sha256: digest, createdAt: new Date().toISOString(), value,
    };
    const existing = existsSync(destination);
    if (existing) {
      const previous = readJson(destination) as Partial<DynamicArtifactRecord>;
      if (previous.sha256 !== digest || canonicalBody(previous.value) !== body) {
        throw new PyValueError("artifact collision: identical id with a different body");
      }
      return { stored: true, ref: this.#ref(record), write: "already-present" };
    }
    writeJsonAtomic(join(this.directory, runId), ".artifact-", destination, record);
    return { stored: true, ref: this.#ref(record), write: "created" };
  }

  #ref(record: DynamicArtifactRecord): DynamicArtifactRef {
    const { id, runId, nodeId, chars, sha256, createdAt } = record;
    return { $artifact: id, runId, nodeId, chars, sha256, createdAt };
  }

  /** Load the referenced body, verifying the digest before returning it. */
  resolve(runId: string, ref: unknown): unknown {
    if (!isArtifactRef(ref)) throw new PyValueError("artifact reference required");
    if (ref.runId !== runId) throw new PyValueError("artifact reference belongs to another run");
    const record = readJson(this.path(runId, ref.$artifact)) as Partial<DynamicArtifactRecord>;
    if (record.runId !== runId) throw new PyValueError("artifact record belongs to another run");
    const body = canonicalBody(record.value);
    const digest = createHash("sha256").update(pyEncodeUtf8(body)).digest("hex");
    if (digest !== record.id || record.id !== record.sha256) throw new PyValueError("artifact body does not match its digest");
    return record.value;
  }

  /** Provenance-only listing for dashboards: metadata, never bodies. */
  manifest(runId: string): DynamicArtifactRef[] {
    const directory = this.#runDirectory(runId);
    let names: string[];
    try { names = readdirSync(directory); } catch { return []; }
    const refs: DynamicArtifactRef[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      if (!SHA256.test(id)) continue;
      try {
        const record = readJson(join(directory, name)) as Partial<DynamicArtifactRecord>;
        if (record.id === id && record.runId === runId && record.sha256 === id) {
          refs.push(this.#ref(record as DynamicArtifactRecord));
        }
      } catch { /* A corrupt or concurrently removed artifact is not listed. */ }
    }
    return refs.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.$artifact.localeCompare(right.$artifact));
  }
}
