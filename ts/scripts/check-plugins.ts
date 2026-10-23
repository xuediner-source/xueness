/** CLI for the plugin gate; see scripts/plugin-gate.ts for the rules. */
import { join } from "node:path";
import { checkPlugins } from "./plugin-gate.ts";

const { problems, plugins, files } = checkPlugins(join(import.meta.dirname, ".."));
if (problems.length) {
  process.stderr.write(`check:plugins found ${problems.length} problem(s):\n${problems.map((line) => `  ${line}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`check:plugins ok: ${plugins} plugins, ${files} source files\n`);
