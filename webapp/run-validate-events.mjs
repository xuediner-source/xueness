import { build } from "esbuild";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const outfile = resolve(root, "tools/.validate-events-v1.mjs");

await build({
  entryPoints: [resolve(root, "tools/validate-events-v1.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  logLevel: "warning",
});

await import(pathToFileURL(outfile).href);
