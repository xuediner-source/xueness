/**
 * Stage a draft GitHub release from one successful "Desktop installers" run of
 * this exact commit. Run by `.github/workflows/stage-desktop-release.yml`
 * (`node ts/scripts/stage-desktop-release.ts`); it replaces the
 * legacy Python release staging with the current TypeScript implementation.
 *
 * 1. The run must be completed/success, from `GITHUB_SHA`, by desktop-build.yml.
 * 2. Every artifact's SHA256SUMS.txt must match its installers, and every
 *    `latest*.yml` entry (sha512, size) must match a release file. The two
 *    macOS builds each write `latest-mac.yml`; their entries are merged.
 * 3. Draft release `v<desktop version>` is created, or an existing draft is
 *    refreshed. A published release with that tag is never touched.
 *
 * Env: `XUENESS_BUILD_RUN` (run id), `GITHUB_SHA`; `gh` must be authenticated.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export const WORKFLOW = "Desktop installers";
const INSTALLER = /\.(exe|zip|dmg)$/, FEED = /^latest.*\.yml$/, ASSET = /\.(exe|zip|dmg|blockmap)$|^latest.*\.yml$/;
export class StageError extends Error {}
const fail = (message: string): never => { throw new StageError(message); };
const digest = (algorithm: string, path: string, encoding: "hex" | "base64" = "hex"): string => createHash(algorithm).update(readFileSync(path)).digest(encoding);
export interface Yaml { load(text: string): unknown; dump(value: unknown, options?: object): string }
type Row = Record<string, any>;

export function checkRun(run: Row, commit: string): void {
  if (run.status !== "completed" || run.conclusion !== "success") fail(`build run is ${run.status}/${run.conclusion}, not completed/success`);
  if (run.headSha !== commit) fail(`build run built ${run.headSha}, not ${commit}`);
  if (run.workflowName !== WORKFLOW) fail(`build run belongs to "${run.workflowName}", not "${WORKFLOW}"`);
}

/** Verify each downloaded artifact and collect the release files (name -> path). */
export function collectAssets(downloads: string, yaml: Yaml, out: string): { assets: Map<string, string>; sums: Map<string, string> } {
  const assets = new Map<string, string>(), sums = new Map<string, string>(), feeds = new Map<string, { name: string; path: string }[]>();
  const artifacts = existsSync(downloads) ? readdirSync(downloads).filter((name) => name.startsWith("Xueness-") && !name.endsWith("-update-smoke-evidence")).sort() : [];
  if (!artifacts.length) fail("no installer artifacts in the build run");
  for (const name of artifacts) {
    const dir = join(downloads, name), listing = join(dir, "SHA256SUMS.txt"), listed = new Set<string>();
    if (!existsSync(listing)) fail(`${name}: SHA256SUMS.txt missing`);
    for (const line of readFileSync(listing, "utf8").split(/\r?\n/).filter(Boolean)) {
      const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line) ?? fail(`${name}: malformed SHA256SUMS.txt line`);
      const [, sum, file] = match as RegExpExecArray, path = join(dir, file!);
      if (basename(file!) !== file || !existsSync(path)) fail(`${name}: ${file} is listed but missing`);
      if (digest("sha256", path) !== sum) fail(`${name}: ${file} does not match SHA256SUMS.txt`);
      if (sums.has(file!) && sums.get(file!) !== sum) fail(`${file} differs between artifacts`);
      listed.add(file!); sums.set(file!, sum!);
    }
    for (const file of readdirSync(dir).sort()) {
      const path = join(dir, file);
      if (!ASSET.test(file) || !statSync(path).isFile()) continue;
      if (INSTALLER.test(file) && !listed.has(file)) fail(`${name}: ${file} is not in SHA256SUMS.txt`);
      if (FEED.test(file)) { feeds.set(file, [...feeds.get(file) ?? [], { name, path }]); continue; }
      if (assets.has(file) && digest("sha256", assets.get(file)!) !== digest("sha256", path)) fail(`${file} differs between artifacts`);
      assets.set(file, path);
    }
  }
  mkdirSync(out, { recursive: true });
  for (const [file, sources] of feeds) {
    const docs = sources.map(({ name, path }) => {
      const doc = yaml.load(readFileSync(path, "utf8")) as Row | null;
      if (!doc || typeof doc !== "object" || !Array.isArray(doc.files) || typeof doc.version !== "string") fail(`${name}: ${file} is not an update feed`);
      return doc!;
    });
    const merged: Row = { ...docs[0], files: [] };
    for (const doc of docs) {
      if (doc.version !== merged.version) fail(`${file}: versions differ between artifacts`);
      for (const entry of doc.files as Row[]) if (!merged.files.some((row: Row) => row.url === entry.url)) merged.files.push(entry);
    }
    for (const entry of merged.files as Row[]) {
      const path = assets.get(String(entry.url)) ?? fail(`${file}: ${entry.url} is not among the release files`);
      if (digest("sha512", path, "base64") !== entry.sha512 || entry.size !== undefined && statSync(path).size !== entry.size) fail(`${file}: ${entry.url} does not match its sha512 or size`);
    }
    const target = join(out, file);
    writeFileSync(target, sources.length > 1 ? yaml.dump(merged, { lineWidth: -1 }) : readFileSync(sources[0]!.path, "utf8"));
    assets.set(file, target);
  }
  const listing = join(out, "SHA256SUMS.txt");
  writeFileSync(listing, [...sums].sort(([a], [b]) => (a < b ? -1 : 1)).map(([file, sum]) => `${sum}  ${file}\n`).join(""));
  assets.set("SHA256SUMS.txt", listing);
  return { assets, sums };
}

export interface StageOptions { env?: NodeJS.ProcessEnv; root?: string; yaml?: Yaml; gh?: (args: string[]) => string }
export function stage(options: StageOptions = {}): { tag: string; files: string[]; created: boolean } {
  const env = options.env ?? process.env, root = options.root ?? join(import.meta.dirname, "..", "..");
  const gh = options.gh ?? ((args: string[]) => execFileSync("gh", args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }));
  const runId = env.XUENESS_BUILD_RUN ?? "", commit = env.GITHUB_SHA ?? "";
  if (!/^\d+$/.test(runId)) fail("XUENESS_BUILD_RUN must be a workflow run id");
  if (!/^[0-9a-f]{40}$/.test(commit)) fail("GITHUB_SHA must be the full commit being released");
  checkRun(JSON.parse(gh(["run", "view", runId, "--json", "status,conclusion,headSha,workflowName"])), commit);
  const version = String(JSON.parse(readFileSync(join(root, "desktop", "package.json"), "utf8")).version), tag = `v${version}`;
  const work = mkdtempSync(join(tmpdir(), "xueness-stage-")), downloads = join(work, "artifacts");
  gh(["run", "download", runId, "--dir", downloads]);
  const yaml = options.yaml ?? createRequire(join(root, "desktop", "package.json"))("js-yaml") as Yaml;
  const { assets, sums } = collectAssets(downloads, yaml, join(work, "release"));
  for (const file of assets.keys()) if (/\d+\.\d+\.\d+/.test(file) && !file.includes(version)) fail(`${file} is not version ${version}`);
  const notes = join(work, "notes.md");
  writeFileSync(notes, `Xueness ${version}\n\nBuilt by workflow run ${runId} from ${commit}.\n\nSHA-256:\n\n${[...sums].map(([file, sum]) => `- \`${file}\`: \`${sum}\``).join("\n")}\n`);
  let existing: Row | null = null;
  try { existing = JSON.parse(gh(["release", "view", tag, "--json", "isDraft"])); } catch { existing = null; }
  if (existing && existing.isDraft !== true) fail(`${tag} is already published; bump the desktop version first`);
  const files = [...assets.values()];
  if (existing) { gh(["release", "upload", tag, "--clobber", ...files]); gh(["release", "edit", tag, "--notes-file", notes]); }
  else gh(["release", "create", tag, "--draft", "--target", commit, "--title", `Xueness ${version}`, "--notes-file", notes, ...files]);
  return { tag, files: [...assets.keys()].sort(), created: !existing };
}

if (process.argv[1] === import.meta.filename) {
  try { const result = stage(); console.log(`staged draft ${result.tag}: ${result.files.join(", ")}`); }
  catch (error) { console.error(error instanceof StageError ? `ERROR: ${error.message}` : error); process.exit(1); }
}
