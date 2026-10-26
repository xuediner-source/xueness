/** Reproducible GitHub artifacts. Run after Vite; desktop receives core assets only. */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const repo = resolve(import.meta.dirname, "../.."), assets = join(repo, "webapp/dist/assets");
const out = join(repo, "marketplace/packages"); mkdirSync(out, { recursive: true });
const sha = (raw: Buffer): string => createHash("sha256").update(raw).digest("hex");
const definitions = [
  { id: "subscriptions", packageId: "xueness-subscriptions" },
  { id: "model_monitor", packageId: "xueness-model-monitor" },
  { id: "workbuddy", packageId: "xueness-workbuddy" },
];
function walk(directory: string, prefix: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en")).flatMap(entry => {
    const relative = `${prefix}/${entry.name}`, path = join(directory, entry.name);
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing a link: ${relative}`);
    return entry.isDirectory() ? walk(path, relative) : [relative];
  });
}
const pins: Record<string, unknown> = {}, removed: string[] = [];
for (const definition of definitions) {
  const source = join(repo, "ts/plugins", definition.id);
  const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
  const front = readdirSync(assets).filter(name => name.startsWith(`optional-${definition.id}-`) && /\.(?:js|css)$/.test(name)).sort();
  if (!front.some(name => name.endsWith(".js"))) throw new Error(`Missing optional frontend chunk: ${definition.id}`);
  const paths = [...new Set(["package.json", "manifest.json", ...walk(join(source, "src"), "src"), ...manifest.backendAssets ?? [], ...manifest.dataFiles ?? []])].sort();
  const files = paths.map(path => {
    if (path.includes("..") || path.includes("auths") || path.includes("\\") || lstatSync(join(source, path)).isSymbolicLink()) throw new Error("Unsafe optional source path");
    return { path: `backend/${path}`, bytes: readFileSync(join(source, path)), executable: (lstatSync(join(source, path)).mode & 0o111) !== 0 && /\.(?:sh|mjs)$/.test(path) };
  });
  files.push(...front.map(name => ({ path: `frontend/${name}`, bytes: readFileSync(join(assets, name)), executable: false })));
  const payload = { id: definition.id, version: manifest.version, files: files.map(file => ({ path: file.path, content: file.bytes.toString("base64") })) };
  const compressed = gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 }), digest = sha(compressed);
  const filename = `${definition.packageId}-${manifest.version}-${digest.slice(0, 16)}.json.gz`;
  writeFileSync(join(out, filename), compressed);
  pins[definition.id] = { ...definition, version: manifest.version, sha256: digest, bytes: compressed.length,
    url: `https://raw.githubusercontent.com/xuediner-source/xueness/main/marketplace/packages/${filename}`,
    files: files.map(file => ({ path: file.path, bytes: file.bytes.length, sha256: sha(file.bytes), executable: file.executable })) };
  removed.push(...front);
}
const encoded = JSON.stringify(pins, null, 2) + "\n";
writeFileSync(join(repo, "ts/packages/kernel/src/optional-packages.json"), encoded);
// Keep an existing generated backend consistent when Vite runs after it in CI.
for (const path of ["ts/dist/packages/kernel/src/optional-packages.json", "ts/dist/node_modules/@xueness/kernel/src/optional-packages.json"]) {
  if (existsSync(join(repo, path))) writeFileSync(join(repo, path), encoded);
}
for (const name of removed) rmSync(join(assets, name));
writeFileSync(join(repo, "webapp/dist/optional-packages.json"), encoded);
process.stdout.write(`Packaged ${definitions.length} optional plugins; removed ${removed.length} optional frontend assets from core.\n`);
