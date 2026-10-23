#!/usr/bin/env node
/**
 * `xueness` command line (Python `xueness.cli.main`): the parser registry is
 * owned per feature, as the bundled manifests' `commands` lists declare.
 */
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDict } from "@xueness/contracts";
import { loadCatalogManifests } from "../manifests.ts";
import { CliExit, Parser, type Args } from "./argparse.ts";
import { Cli, err, errorText, osErrorText, PROJECT_ROOT } from "./host.ts";
import * as sessions from "./sessions.ts";
import * as runs from "./run.ts";
import * as headless from './headless.ts';
import * as ops from "./ops.ts";
import * as catalog from "./catalog.ts";
import * as plugins from "./plugins.ts";
import * as workflows from "./workflows.ts";
import * as workflowScripts from './workflow-scripts.ts';
import * as automation from "./automation.ts";
import * as remote from "./remote.ts";
import * as memoryDream from "./memory-dream.ts";

interface Module { register(sub: ReturnType<Parser["subparsers"]>): void; execute(cli: Cli): Promise<number | null> }
const MODULES: Module[] = [sessions, runs, headless, ops, catalog, workflows, workflowScripts, automation, remote, memoryDream, plugins];

/** `plugin_runtime.cli_owner`: resources by kind, every other command by its manifest's `commands`. */
/** Python's subcommand order (`xueness.cli` registers the plugins' parsers in catalog order). */
const COMMAND_ORDER = ["new", "run", "headless", "chat", "list", "journal", "answer", "show", "sessions", "goal", "providers", "memory-tracks", "memory-dream", "settings", "settings-set", "usage", "git", "workflow", "jobs", "expert", "workflows",
  "commands", "skills", "hooks", "mcp-check", "mcp", "automation", "doctor", "remote", "app-server", "bots", "onboarding", "update", "plugins", "plugin", "resources"];

export function cliOwner(projectRoot: string, args: Args): string | null {
  if (args.cmd === "resources") return args.kind === "plugins" ? "extensions" : ["skills", "commands", "hooks", "mcp", "subagents"].includes(args.kind) ? args.kind : null;
  for (const [id, manifest] of loadCatalogManifests(projectRoot)) if (Array.isArray(manifest.commands) && manifest.commands.includes(args.cmd)) return id;
  return null;
}

/** `_require_cli_plugins`: the owner, providers for runs, and each plugin a flag turns on. */
function refusal(cli: Cli): string | null {
  const args = cli.args, owner = cliOwner(cli.projectRoot, args);
  const requested = owner ? [owner] : [];
  if (["run", "chat", "headless"].includes(args.cmd)) requested.push("providers");
  for (const [flag, id] of [["skill_catalog", "skills"], ["inject_skills", "skills"], ["allow_hooks", "hooks"], ["allow_mcp", "mcp"], ["allow_subagents", "subagents"]] as const) if (args[flag]) requested.push(id);
  for (const id of new Set(requested)) if (!cli.enabled(id)) return "plugin disabled or dependency unavailable: " + id;
  return null;
}

export function buildParser(projectRoot = PROJECT_ROOT): Parser {
  const parser = new Parser("xueness", "Xueness local coding-agent harness");
  parser.add("--state", { default: join(projectRoot, ".state") });
  parser.add("--language", { choices: ["zh", "en"], default: process.env.XUENESS_LANGUAGE ?? "zh", help: "CLI language (zh or en)" });
  const sub = parser.subparsers("cmd");
  for (const module of MODULES) module.register(sub);
  sub.reorder(COMMAND_ORDER);
  return parser;
}

function isEntry(path: string): boolean {
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path); } catch { return false; }
}

export async function main(argv: readonly string[]): Promise<number> {
  const parser = buildParser();
  let args: Args;
  try {
    args = parser.parse(argv);
    if (args.cmd === null) args = parser.parse(["--state", String(args.state), "--language", String(args.language), "chat"]);
  } catch (error) { if (error instanceof CliExit) return error.code; throw error; }
  const cli = new Cli(args, parser);
  try {
    if (args.cmd !== "plugins" && args.cmd !== "plugin") {
      const refused = refusal(cli);
      if (refused) { err("ERROR: " + refused); return 1; }
    }
    for (const module of MODULES) {
      const code = await module.execute(cli);
      if (code !== null) return code;
    }
    return cli.error("unsupported command");
  } catch (error) {
    if (error instanceof CliExit) return error.code;
    const path = (error as { path?: unknown })?.path;
    // A Node file error reads as Python's `str(OSError)`.
    err("ERROR: " + (typeof path === "string" && (error as { code?: unknown }).code ? osErrorText(error, path) : isDict(error) && typeof error.message === "string" ? error.message : errorText(error)));
    return 1;
  } finally {
    await cli.close().catch(() => {});
  }
}

if (process.argv[1] && isEntry(process.argv[1])) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
  // Flush stdout/stderr, then end even if a feature left a handle open.
  process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
}
