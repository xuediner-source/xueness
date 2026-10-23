/**
 * Regenerate `complete-project-manifest.json`: path, size and SHA-256 of every
 * project file outside the manifest's own `exclusions`. Keeps the original
 * file order (new paths sorted after it) and CRLF line endings.
 *
 *   node ts/scripts/project-manifest.ts [--write] [--migration "<note>"]
 *
 * Without `--write` it reports changed, added and removed paths and exits 1
 * when the manifest is stale.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

export interface ManifestFile { path: string; sizeBytes: number; sha256: string }
const glob = (pattern: string): RegExp => new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");

/** fnmatch on any segment for bare names, prefix match for paths; the manifest excludes only itself at the root. */
export function excluded(rel: string, exclusions: readonly string[]): boolean {
  const parts = rel.split("/");
  return exclusions.some((pattern) => pattern === "complete-project-manifest.json" ? rel === pattern
    : pattern.includes("/") ? rel === pattern || rel.startsWith(pattern + "/") : parts.some((part) => glob(pattern).test(part)));
}

export function scan(root: string, exclusions: readonly string[]): ManifestFile[] {
  const files: ManifestFile[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (excluded(path, exclusions)) continue;
      if (entry.isDirectory()) walk(join(dir, entry.name), path);
      else if (entry.isFile()) {
        const bytes = readFileSync(join(dir, entry.name));
        files.push({ path, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      }
    }
  };
  walk(root, "");
  return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}

export function compare(previous: readonly ManifestFile[], current: readonly ManifestFile[]): { changed: string[]; added: string[]; removed: string[]; files: ManifestFile[] } {
  const old = new Map(previous.map((file, index) => [file.path, { file, index }])), now = new Map(current.map((file) => [file.path, file]));
  const changed = current.filter((file) => old.has(file.path) && old.get(file.path)!.file.sha256 !== file.sha256).map((file) => file.path);
  const added = current.filter((file) => !old.has(file.path)).map((file) => file.path);
  const removed = previous.filter((file) => !now.has(file.path)).map((file) => file.path).sort();
  const rank = (path: string): number => old.get(path)?.index ?? previous.length;
  const files = [...current].sort((a, b) => rank(a.path) - rank(b.path) || (a.path < b.path ? -1 : 1));
  return { changed, added, removed, files };
}

if (process.argv[1] === import.meta.filename) {
  const { values } = parseArgs({ options: { write: { type: "boolean" }, migration: { type: "string" }, root: { type: "string" } } });
  const root = values.root ?? join(import.meta.dirname, "..", ".."), path = join(root, "complete-project-manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  const { changed, added, removed, files } = compare(manifest.files, scan(root, manifest.exclusions));
  console.log(`changed ${changed.length}, added ${added.length}, removed ${removed.length}`);
  for (const [mark, list] of [["M", changed], ["A", added], ["D", removed]] as const) for (const item of list) console.log(`  ${mark} ${item}`);
  if (values.write) {
    if (values.migration) manifest.migration = `${manifest.migration}; ${values.migration}`;
    manifest.sourceFileCount = files.length; manifest.files = files;
    writeFileSync(path, (JSON.stringify(manifest, null, 2) + "\n").replace(/\n/g, "\r\n"));
    console.log(`written ${files.length}`);
  } else if (changed.length || added.length || removed.length) process.exit(1);
}
