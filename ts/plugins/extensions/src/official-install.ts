/** Official executable artifacts are pinned in the host, independently of market data. */
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { artifactHash, coreNodeModules, optionalArtifactByPackage, optionalInstalled, optionalPath, optionalRoot, type OptionalArtifact } from "@xueness/kernel";
import { protectPrivateDirectory, protectPrivateFile, writeAll } from "@xueness/sessions";

export type ArtifactDownload = (artifact: OptionalArtifact) => Promise<Buffer>;

export const downloadArtifact: ArtifactDownload = async artifact => {
  if (!artifact.url.startsWith("https://raw.githubusercontent.com/xuediner-source/xueness/main/marketplace/packages/")) throw new Error("untrusted artifact origin");
  const response = await fetch(artifact.url, { redirect: "error", signal: AbortSignal.timeout(120_000), headers: { Accept: "application/octet-stream" } });
  if (!response.ok || !response.body) throw new Error(`GitHub download failed (${response.status})`);
  const chunks: Uint8Array[] = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > artifact.bytes || bytes > 32 * 1024 * 1024) throw new Error("artifact download exceeds declared size");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
};

function privateDirectory(root: string, relative: string): string {
  const path = optionalPath(root, relative); mkdirSync(path, { recursive: true, mode: 0o700 }); protectPrivateDirectory(path); return path;
}

function privateFile(path: string, bytes: Buffer): void {
  const fd = openSync(path, "wx", 0o600);
  try { protectPrivateFile(fd); writeAll(fd, bytes); } finally { closeSync(fd); }
}

/** Checks every byte before publishing the directory. Nothing is evaluated here. */
export function storeOfficialArtifact(stateDir: string, artifact: OptionalArtifact, compressed: Buffer): void {
  if (compressed.length !== artifact.bytes || artifactHash(compressed) !== artifact.sha256) throw new Error("GitHub artifact checksum mismatch");
  const value = JSON.parse(gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 }).toString("utf8"));
  if (value.id !== artifact.id || value.version !== artifact.version || !Array.isArray(value.files) || value.files.length !== artifact.files.length) throw new Error("invalid official artifact");
  const files = artifact.files.map((entry, index) => {
    const row = value.files[index];
    if (!row || row.path !== entry.path || !/^(?:backend\/(?:src|assets)\/|backend\/package\.json$|backend\/manifest\.json$|frontend\/)/.test(entry.path)
      || entry.path.split("/").some(part => !part || part === "." || part === ".." || /[\\:\x00-\x1f]/.test(part)) || typeof row.content !== "string") throw new Error("invalid artifact file");
    const bytes = Buffer.from(row.content, "base64");
    if (bytes.length !== entry.bytes || artifactHash(bytes) !== entry.sha256) throw new Error("artifact file checksum mismatch");
    return { entry, bytes };
  });
  const parent = privateDirectory(stateDir, "optional-plugins");
  const dependencies = join(parent, "node_modules"), core = coreNodeModules();
  if (existsSync(dependencies)) {
    if (!lstatSync(dependencies).isSymbolicLink() || realpathSync.native(dependencies) !== core) throw new Error("optional dependency link is invalid");
  } else symlinkSync(core, dependencies, process.platform === "win32" ? "junction" : "dir");
  const stageName = `.staging-${randomUUID()}`, stage = privateDirectory(parent, stageName);
  try {
    for (const { entry, bytes } of files) {
      const target = optionalPath(stage, entry.path); privateDirectory(stage, dirname(entry.path));
      privateFile(target, bytes);
      if (entry.executable && process.platform !== "win32") chmodSync(target, 0o700);
    }
    const receipt = join(stage, ".installed.json");
    privateFile(receipt, Buffer.from(JSON.stringify({ id: artifact.id, version: artifact.version, sha256: artifact.sha256 })));
    privateDirectory(parent, artifact.id);
    const target = optionalRoot(stateDir, artifact);
    if (existsSync(target)) {
      if (!optionalInstalled(stateDir, artifact.id)) throw new Error("existing plugin payload is damaged; remove it before reinstalling");
    } else renameSync(stage, target);
  } finally {
    if (dirname(resolve(stage)) !== resolve(parent)) throw new Error("invalid staging cleanup");
    optionalPath(parent, stageName); rmSync(stage, { recursive: true, force: true });
  }
}

export async function fetchOfficialArtifact(stateDir: string, packageId: string, download: ArtifactDownload = downloadArtifact): Promise<void> {
  const artifact = optionalArtifactByPackage(packageId);
  if (!artifact) throw new Error("unknown official plugin");
  storeOfficialArtifact(stateDir, artifact, await download(artifact));
}

export function removeOfficialArtifact(stateDir: string, packageId: string): void {
  const artifact = optionalArtifactByPackage(packageId);
  if (!artifact) return;
  const target = optionalRoot(stateDir, artifact); optionalPath(stateDir, "optional-plugins");
  // target is a pinned version directory, never the account/configuration directory.
  rmSync(target, { recursive: true, force: true });
}
