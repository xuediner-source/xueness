/** Build-only packaging; runtime entry and installer belong to desktop.cli_distribution. */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { cliReleaseManifest } from "../plugins/desktop/src/cli-distribution.ts";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
if (process.platform !== "win32" || process.arch !== "x64") throw new Error("The initial standalone CLI artifact must be built on Windows x64");
const output = resolve(process.argv[2] ?? join(repo, "desktop", "release", "cli"));
const version = process.argv[3] ?? JSON.parse(readFileSync(join(repo, "ts", "package.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Invalid CLI version");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
const built = join(repo, "ts", "dist");
if (!existsSync(join(built, ".xueness-generated-build"))) throw new Error("Run npm --prefix ts run build first");
const payload = join(output, "payload"), file = `xueness-cli-${version}-windows-x64.zip`, archive = join(output, file);
if (existsSync(payload) || existsSync(archive)) throw new Error("Use a fresh output directory; existing packages are not overwritten");
mkdirSync(payload, { recursive: true });
cpSync(built, join(payload, "backend-ts"), { recursive: true, filter(path) {
  const rel = relative(built, path).replaceAll("\\", "/");
  return !path.endsWith(".map") && !/(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[^.]+$/.test(rel)
    && !rel.startsWith("node_modules/.bin")
    && !/^(?:plugins\/|node_modules\/@xueness\/plugin-)(?:subscriptions|model_monitor|workbuddy)\/(?:src|assets)(?:\/|$)/.test(rel);
} });
cpSync(join(repo, "desktop", "src", "cli-launcher.cjs"), join(payload, "cli-launcher.cjs"));
for (const name of ["LICENSE", "NOTICE.md"]) cpSync(join(repo, name), join(payload, name));
cpSync(join(repo, "marketplace"), join(payload, "marketplace"), { recursive: true });
const node = join(payload, "backend-ts", "runtime", "node.exe");
const nodeVersion = execFileSync(node, ["--version"], { encoding: "utf8", windowsHide: true }).trim();
writeFileSync(join(payload, "cli-release.json"), JSON.stringify({ schemaVersion: 1, version, platform: "windows-x64", sourceCommit: commit, nodeVersion }, null, 2));
execFileSync(node, [join(payload, "cli-launcher.cjs"), "--version"], { windowsHide: true, stdio: "inherit" });
execFileSync("tar.exe", ["-a", "-cf", archive, "-C", payload, "."], { windowsHide: true, stdio: "inherit" });
const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
const manifest = cliReleaseManifest({ version, sourceCommit: commit, file, sha256, bytes: statSync(archive).size, nodeVersion });
writeFileSync(join(output, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(join(output, "SHA256SUMS.txt"), `${sha256}  ${file}\n`);
console.log(JSON.stringify({ archive, bytes: statSync(archive).size, sha256, version, sourceCommit: commit, nodeVersion }));
