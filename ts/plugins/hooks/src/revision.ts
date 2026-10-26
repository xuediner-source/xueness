/**
 * The configuration revision workspace-hook authorizations are bound to
 * (F07.03): a digest over every input a grant depends on — the feature
 * document and each discovered hook source file. `grantTrust` stamps it into
 * the record; `admitted` re-derives it, so any later configuration change
 * (an edited declaration, a touched source file, a flipped feature switch)
 * makes the old grant stale instead of silently admitting a hook that was
 * reviewed under a different configuration.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { readCapped, utf8 } from "./files.ts";
import { canonicalWorkspace, discover, sha256Payload } from "./workspace.ts";
import { FEATURE_FILENAME, FEATURE_MAX_BYTES } from "./trust.ts";

export const REVISION_VERSION = 1;

/** The digest of one state file's exact bytes; null when absent or unreadable. */
export function stateFileDigest(stateDir: string, name: string, maxBytes: number): string | null {
  // `resolve`, never `join`: source files arrive as absolute paths.
  const path = resolve(stateDir, name);
  const raw = readCapped(path, maxBytes);
  if (raw === null || raw.length > maxBytes) return null;
  return createHash("sha256").update(raw).digest("hex");
}

export interface RevisionInputs { feature: string | null; sources: [string, string, string][] }

/** The exact revision document: which file bytes the grants were reviewed against. */
export function revisionInputs(stateDir: string, root: unknown): RevisionInputs {
  const workspace = canonicalWorkspace(root);
  const sources: [string, string, string][] = workspace === null ? []
    : discover(workspace).sources.map((source) => [String(source.path), String(source.kind),
      stateFileDigest(workspace, String(source.file), 256 * 1024) ?? "unreadable"]);
  return { feature: stateFileDigest(stateDir, FEATURE_FILENAME, FEATURE_MAX_BYTES), sources };
}

/**
 * The authorization revision for one workspace: a stable digest of
 * `revisionInputs`. Two identical revisions mean every byte a grant was
 * reviewed against is unchanged; any difference invalidates the grant.
 */
export function authorizationRevision(stateDir: string, root: unknown): string {
  const inputs = revisionInputs(stateDir, root);
  return sha256Payload(["xueness-hook-authorization-revision", REVISION_VERSION, inputs.feature, inputs.sources]);
}
