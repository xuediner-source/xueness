/**
 * `skills`, `commands`, `resources` and the in-chat `/skills`, `/commands`,
 * `/mcp` replies (Python `skills_cli`, `commands_cli`, `cli._run_resources`);
 * hooks and MCP live in `hooks-mcp.ts`.
 */
import { readFileSync } from "node:fs";
import { BODY_PREVIEW_CHARS, BUILTIN_SOURCE, EXPAND_MAX_CHARS, inspectCommand, listAll as listCommands, MAX_COMMAND_FILE_BYTES, MAX_COMMANDS_PER_ROOT } from "@xueness/plugin-commands";
import { inspectSkill, listAll as listSkills, READ_TOTAL_BUDGET } from "@xueness/plugin-skills";
import { RESOURCE_KINDS, resourceDispatch } from "@xueness/sessions";
import type { Parser } from "./argparse.ts";
import { type Cli, dumps, err, out, pyPath, workspacePath } from "./host.ts";
import * as hooksMcp from "./hooks-mcp.ts";
import { manifestCommands } from "./chat-commands.ts";

type Sub = ReturnType<Parser["subparsers"]>;
type Row = Record<string, any>;
const SKILLS_USAGE = "Usage: xueness skills [list|inspect <name>] [--root PATH] [--json]";
const COMMANDS_USAGE = "Usage: xueness commands [list|inspect <name>] [--root PATH] [--json]";
const EXPANSION_NOTE = "expansion: $ARGUMENTS and $1..$9 only; no shell expansion, no @file reads and no model switch";
const BUILTIN_EXPANSION_NOTE = "expansion: the arguments are appended below the shipped prompt as quoted data; $ARGUMENTS, $1..$9, shell and @file expansion do not apply here, and no workspace file can override this text";
const BUILTIN_ORIGIN_NOTE = "(built-in prompt shipped with the commands plugin)";
const MAX_ATTACHMENTS_PER_SKILL = 32;

export function register(sub: Sub): void {
  for (const [name, help, kind, folder] of [["skills", "discover directory-shaped and stored skills, and inspect one", "skill", "skills"], ["commands", "discover file and stored custom commands, and inspect one", "command", "commands"]] as const) {
    const actions = sub.add(name, help).subparsers(name + "_action");
    const common = (parser: Parser): void => { parser.add("--root", { default: null, help: `workspace holding .xueness/${folder} (default: current directory)` }).add("--json", { action: "store_true", help: "machine-readable output on stdout" }); };
    common(actions.add("list", `every ${kind}, its source and any diagnostics`));
    const inspect = actions.add("inspect", `one ${kind}, with its bounded body`);
    inspect.add("name");
    common(inspect);
  }
  hooksMcp.register(sub);
  const res = sub.add("resources", "manage skills/commands/hooks/mcp/subagents/plugins resources").subparsers("res_cmd", true);
  res.add("list", "list items of one kind (JSON)").add("kind", { choices: RESOURCE_KINDS });
  res.add("show", "print one resource item (JSON)").add("kind", { choices: RESOURCE_KINDS }).add("id");
  for (const [verb, help] of [["create", "create a resource item"], ["enable", "enable one resource item"], ["disable", "disable one resource item"], ["delete", "delete one resource item (config file removed; journal untouched)"]] as const) {
    const parser = res.add(verb, help).add("kind", { choices: RESOURCE_KINDS }).add("id");
    if (verb !== "create") continue;
    parser.add("--description", { default: null }).add("--event", { default: null, help: "hooks only: hook event name" });
    parser.add("--command", { default: null, help: "hooks: command; mcp config via --body-file" }).add("--body", { default: null, help: "skills/commands: inline prompt body" });
    parser.add("--body-file", { default: null, help: "skills/commands: read body from a file ('-' for stdin)" }).add("--disable", { action: "store_true", help: "create the item disabled (default enabled)" });
  }
}

const diagnosticLines = (diagnostics: Row[] | undefined): string[] => !diagnostics?.length ? [] : ["", `Diagnostics (${diagnostics.length})`, ...diagnostics.map((item) => `- [${item.severity}] ${item.code}: ${item.message}${item.path ? ` (${item.path})` : ""}`)];
const join = (lines: string[], diagnostics?: Row[]): string => [...lines, ...diagnosticLines(diagnostics)].join("\n");

function skillListing(cli: Cli, root: string): Row {
  const document = listSkills(cli.state, root);
  return { root, stateDir: cli.stateText, skills: document.skills, diagnostics: document.diagnostics };
}
function formatSkills(document: Row): string {
  const rows: Row[] = document.skills;
  if (!rows.length) return join(["No skills found."], document.diagnostics);
  return join([`Available skills (${rows.length})`, ...rows.map((row) => [`${row.name} (${row.source})${row.shadowedBy ? ` [shadowed by ${row.shadowedBy}]` : ""}`, "  " + (row.description || "(no description)"), "  " + row.path].join("\n"))], document.diagnostics);
}
function formatSkill(result: Row): string {
  if (!result.ok) return join([`ERROR: ${result.error ?? "skill not readable"}`, `Available: ${(result.available ?? []).join(", ") || "(none)"}`], result.diagnostics);
  const row = result.skill;
  const lines = [`Skill: ${row.name}`, `source: ${row.source} (scope ${row.scope})`, `id: ${row.id}`, `path: ${row.path}`, `directory: ${row.directory}`, `description: ${row.description || "(none)"}`,
    `tags: ${row.tags?.length ? row.tags.join(", ") : "(none)"}`, `shadowed: ${row.shadowedBy || "no"}`, `size: ${Math.trunc(Number(result.sizeBytes || row.bytes || 0))} bytes`];
  const files: Row[] = row.attachments || [];
  if (files.length) {
    lines.push("attachments: " + files.map((item) => `${item.name} (${item.bytes} bytes)`).join(", "));
    if (row.attachmentsTruncated) lines.push(`  (only the first ${MAX_ATTACHMENTS_PER_SKILL} attachment names are listed)`);
  }
  lines.push("", "Content", result.content || "(empty)");
  if (result.truncated) lines.push(`(body clipped to ${READ_TOTAL_BUDGET} characters)`);
  return join(lines, result.diagnostics);
}

function commandListing(cli: Cli, root: string): Row {
  const document = listCommands({ stateDir: cli.state, root, language: cli.language, manifestCommands: new Set(manifestCommands(cli).keys()) });
  return { root, stateDir: cli.stateText, commands: document.commands, diagnostics: document.diagnostics, limits: { expandChars: EXPAND_MAX_CHARS, previewChars: BODY_PREVIEW_CHARS, commandFileBytes: MAX_COMMAND_FILE_BYTES, commandsPerRoot: MAX_COMMANDS_PER_ROOT } };
}
function formatCommands(document: Row): string {
  const rows: Row[] = document.commands;
  if (!rows.length) return join(["No custom commands found."], document.diagnostics);
  return join([`Custom commands (${rows.length})`, ...rows.map((row) => {
    const label = `- /${row.id}${row.argumentHint ? " " + row.argumentHint : ""} (${row.source})${row.shadowedBy === "builtin" ? " [shadowed-by-builtin]" : row.shadowedBy ? ` [shadowed by ${row.shadowedBy}]` : ""}`;
    return [label, "  " + (row.description || "(no description)"), "  " + String(row.path) + (row.source === BUILTIN_SOURCE ? "  " + BUILTIN_ORIGIN_NOTE : "")].join("\n");
  })], document.diagnostics);
}
function formatCommand(result: Row): string {
  if (!result.ok) return join([`ERROR: ${result.error ?? "command not readable"}`, `Available: ${(result.available ?? []).map((name: string) => "/" + name).join(", ") || "(none)"}`], result.diagnostics);
  const row = result.command, builtin = row.source === BUILTIN_SOURCE;
  const lines = [`Command: /${row.id}`, `source: ${row.source} (scope ${row.scope})`, `path: ${row.path}`, `root: ${row.rootPath}`, `description: ${row.description || "(none)"}`];
  if (row.argumentHint) lines.push("argument-hint: " + row.argumentHint);
  if (row.model) lines.push(`model: ${row.model} (shown only; a command file never selects a model)`);
  if (row.frontmatterKeys?.length) lines.push("frontmatter: " + row.frontmatterKeys.join(", "));
  lines.push("shadowed: " + (row.shadowedBy || "no"));
  if (builtin) lines.push(`language: ${row.language} (the interface language this prompt was rendered in)`);
  lines.push(`size: ${Math.trunc(Number(result.sizeBytes || row.bytes || 0))} bytes`, builtin ? BUILTIN_EXPANSION_NOTE : EXPANSION_NOTE, "", "Content", result.content || "(empty)");
  if (result.truncated) lines.push(`(body clipped to ${BODY_PREVIEW_CHARS} characters)`);
  return join(lines, result.diagnostics);
}

function catalogCommand(cli: Cli, kind: "skills" | "commands"): number {
  const a = cli.args, root = workspacePath(a.root), action = a[kind + "_action"] ?? "list";
  try {
    if (action === "list") {
      const document = kind === "skills" ? skillListing(cli, root) : commandListing(cli, root);
      out(a.json ? dumps(document, 2) : kind === "skills" ? formatSkills(document) : formatCommands(document));
      return 0;
    }
    const result = kind === "skills" ? inspectSkill(cli.state, a.name, root) : inspectCommand({ stateDir: cli.state, root, language: cli.language, manifestCommands: new Set(manifestCommands(cli).keys()) }, a.name);
    out(a.json ? dumps({ ...result, root, stateDir: cli.stateText }, 2) : kind === "skills" ? formatSkill(result) : formatCommand(result));
    return result.ok ? 0 : 1;
  } catch (error) { err("ERROR: " + (error instanceof Error ? error.message : String(error))); return 1; }
}

/** `_run_resources`: the shared resource store, as the settings page edits it. */
function resourcesCommand(cli: Cli): number {
  const a = cli.args, verb: string = a.res_cmd;
  const method = ({ list: "GET", show: "GET", create: "POST", enable: "PATCH", disable: "PATCH", delete: "DELETE" } as Row)[verb];
  const parts = ["list", "create", "show"].includes(verb) ? ["api", "resources", a.kind] : ["api", "resources", a.kind, a.id];
  const data: Row = {};
  if (verb === "enable" || verb === "disable") data.enabled = verb === "enable";
  if (verb === "create") {
    data.id = a.id;
    for (const key of ["description", "event", "command", "body"]) if (a[key] != null) data[key] = a[key];
    if (a.body_file != null) {
      if (a.body != null) cli.error("--body and --body-file are mutually exclusive");
      if (pyPath(a.body_file) === "-") data.body = readFileSync(0, "utf8");
      else {
        try { data.body = readFileSync(a.body_file, "utf8"); }
        catch (error) { cli.error("--body-file unreadable: " + strerror(error)); }
      }
    }
    data.enabled = !a.disable;
  }
  const reply = resourceDispatch(cli.state, method, parts, data);
  if (reply === null) cli.error("unsupported resources subcommand");
  const [status, payload] = reply;
  if (status >= 400) { err(`ERROR (${status}): ${payload.error ?? "unknown"}`); return 1; }
  if (verb === "create") out(dumps(payload.item ?? {}, 2));
  else if (verb === "enable" || verb === "disable") out(dumps({ id: a.id, enabled: verb === "enable" }));
  else if (verb === "delete") out(dumps({ deleted: a.id }));
  else if (verb === "show") {
    const match = (payload.items as Row[] | undefined ?? []).find((item) => item.id === a.id);
    if (!match) { err("ERROR (404): resource not found: " + a.id); return 1; }
    out(dumps(match, 2));
  } else out(dumps(payload, 2));
  return 0;
}

const STRERROR: Row = { ENOENT: "No such file or directory", EACCES: "Permission denied", EISDIR: "Is a directory", ENOTDIR: "Not a directory", ELOOP: "Too many levels of symbolic links" };
const strerror = (error: unknown): string => STRERROR[(error as { code?: string })?.code ?? ""] ?? (error instanceof Error ? error.message : String(error));

export async function execute(cli: Cli): Promise<number | null> {
  const cmd = cli.args.cmd;
  if (cmd === "skills" || cmd === "commands") return catalogCommand(cli, cmd);
  if (cmd === "resources") return resourcesCommand(cli);
  return hooksMcp.execute(cli);
}

/** `/skills`, `/commands` and `/mcp` in chat: the same listings as text. */
export async function catalogSlash(cli: Cli, name: string, argument: string, ctx: { session: Row | null; root: string }): Promise<string> {
  const root = workspacePath(ctx.root || ctx.session?.root || null);
  if (name === "mcp") {
    try { return (await hooksMcp.mcpRun(cli.state, argument, root, cli.language)).text; }
    catch (error) { return "mcp: " + (error instanceof Error ? error.message : String(error)); }
  }
  const usage = name === "skills" ? SKILLS_USAGE : COMMANDS_USAGE;
  const text = argument.trim(), space = text.search(/\s/);
  const verb = (space < 0 ? text : text.slice(0, space)).toLowerCase(), rest = space < 0 ? "" : text.slice(space + 1).trim();
  if (verb === "" || verb === "list") {
    if (rest) return `${name} list takes no arguments.\n${usage}`;
    return name === "skills" ? formatSkills(skillListing(cli, root)) : formatCommands(commandListing(cli, root));
  }
  if (verb === "inspect") {
    if (!rest) return `${name} inspect needs a name.\n${usage}`;
    return name === "skills" ? formatSkill(inspectSkill(cli.state, rest, root)) : formatCommand(inspectCommand({ stateDir: cli.state, root, language: cli.language, manifestCommands: new Set(manifestCommands(cli).keys()) }, rest));
  }
  return `Unknown ${name} command: ${verb}\n${usage}`;
}
