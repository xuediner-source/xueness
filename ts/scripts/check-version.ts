/**
 * One product version. `desktop/package.json` is the source; every other place that states the product
 * version must agree with it. Internal workspace packages and the separately released CLI channel
 * (`cli/latest.json`) keep their own versions and are not checked here.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "../..");
const read = (path: string): string => readFileSync(join(repo, path), "utf8");
const product = (JSON.parse(read("desktop/package.json")) as { version: string }).version;
const match = (path: string, pattern: RegExp): string | null => pattern.exec(read(path))?.[1] ?? null;

const stated: [place: string, version: string | null][] = [
  ["webapp/package.json", (JSON.parse(read("webapp/package.json")) as { version: string }).version],
  ["ts/apps/server/src/front-door.ts (FRONT_DOOR_VERSION)", match("ts/apps/server/src/front-door.ts", /FRONT_DOOR_VERSION = "([^"]+)"/)],
  ["ts/plugins/desktop/src/http.ts (default version)", match("ts/plugins/desktop/src/http.ts", /options\.version \?\? "([^"]+)"/)],
  ["README.en.md (heading)", match("README.en.md", /^# Xueness (\S+)/m)],
];
const wrong = stated.filter(([, version]) => version !== product);
if (wrong.length) {
  process.stderr.write(`check:version: the product version is ${product} (desktop/package.json), but:\n${wrong.map(([place, version]) => `  ${place} says ${version ?? "nothing recognisable"}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`check:version ok: ${product} in ${stated.length + 1} places\n`);
