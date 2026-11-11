/**
 * `plugins` / `plugin` (Python `plugin_cli`): the kernel lists and toggles
 * bundled features; `validate`, `update` and `profile` run in the plugin whose
 * manifest lists them in `pluginsActions`. `imports`, `import` and `unimport`
 * drive the general package import surface for every registered package type.
 */
import { importCommand, importSkillsCommand, profileCommand, updatePackages, validatePath } from "@xueness/plugin-extensions";
import { loadCatalogManifests } from "../manifests.ts";
import type { Parser } from "./argparse.ts";
import { type Cli, dumps, err, out, pyPath } from "./host.ts";

type Sub = ReturnType<Parser["subparsers"]>;
type Row = Record<string, any>;
const GROUP_NAMES = ["plugins", "plugin"], MANAGED = ["list", "enable", "disable", "show"];

export function register(sub: Sub): void {
  for (const name of GROUP_NAMES) {
    const group = sub.add(name, "list and toggle bundled features").subparsers("plugins_action", true);
    group.add("list", "list bundled plugins and their status");
    for (const [action, help] of [["enable", "enable a bundled plugin"], ["disable", "disable a bundled plugin"], ["show", "show one bundled plugin"]] as const) group.add(action, help).add("id");
    group.add("validate", "audit a data manifest, marketplace listing or directory of them without writing anything").add("path");
    const update = group.add("update", "upgrade installed data manifests from the marketplace");
    update.add("id", { nargs: "?" }).add("--all", { action: "store_true", help: "check every installed manifest" }).add("--dry-run", { action: "store_true", help: "report the plan without writing" });
    group.add("imports", "list importable package types and imported packages");
    const importing = group.add("import", "import a declarative package from a manifest file or a folder; nothing in it is executed");
    importing.add("path").add("--type", { help: "package type when more than one recognises the manifest" }).add("--replace", { action: "store_true", help: "replace an imported package with the same id" }).add("--dry-run", { action: "store_true", help: "show what would be imported without writing" })
      .add("--all-skills", { action: "store_true", help: "import every skill folder (SKILL.md) found under the folder, such as the checkout of a plugin for another harness; its code is not touched" });
    group.add("unimport", "remove an imported package").add("type").add("id");
    group.add("activate", "make an imported package's skills and prompt templates available through the skills and commands plugins").add("type").add("id");
    group.add("deactivate", "remove the skills and commands an imported package activated").add("type").add("id");
    const profile = group.add("profile", "list or apply a plugin composition profile").subparsers("profile_action", true);
    profile.add("list", "list the selectable profiles");
    profile.add("show", "show one profile and the catalog it would produce").add("name");
    profile.add("apply", "choose one profile as the plugin set").add("name").add("--dry-run", { action: "store_true", help: "report the change without writing" });
  }
}

/** `plugin_runtime.plugins_action_owner`: the manifest listing the action in `pluginsActions`. */
function actionOwner(cli: Cli, action: string): string | null {
  for (const [id, manifest] of loadCatalogManifests(cli.projectRoot)) if (Array.isArray(manifest.pluginsActions) && manifest.pluginsActions.includes(action)) return id;
  return null;
}

export async function execute(cli: Cli): Promise<number | null> {
  const a = cli.args;
  if (!GROUP_NAMES.includes(a.cmd)) return null;
  const action = String(a.plugins_action);
  if (!MANAGED.includes(action)) {
    const owner = actionOwner(cli, action);
    if (owner === null) { err(`ERROR: no plugin owns the ${action} subcommand`); return 1; }
    if (!cli.enabled(owner)) { err("ERROR: plugin disabled or dependency unavailable: " + owner); return 1; }
    if (["imports", "import", "unimport", "activate", "deactivate"].includes(action)) {
      const run = action === "import" && a.all_skills ? (api: Parameters<typeof importCommand>[0], _action: string, args: Parameters<typeof importCommand>[2]) => importSkillsCommand(api, args) : importCommand;
      const done = await run((method, path, data) => cli.api(method, path, data), action, { path: a.path === undefined ? null : pyPath(a.path), type: a.type ?? null, id: a.id ?? null, replace: Boolean(a.replace), dryRun: Boolean(a.dry_run) });
      out(dumps(done.output, 2));
      return done.code;
    }
    let result: Row;
    try {
      result = action === "validate" ? validatePath(pyPath(a.path))
        : action === "update" ? updatePackages(cli.state, a.id ?? null, Boolean(a.all), Boolean(a.dry_run))
          : profileCommand(cli.state, String(a.profile_action), a.name ?? null, Boolean(a.dry_run));
    } catch (error) { err("ERROR: " + (error instanceof Error ? error.message : String(error))); return 1; }
    out(dumps(result, 2));
    return result.ok === false ? 1 : 0;
  }
  let result: unknown;
  if (action === "list" || action === "show") {
    const [status, payload] = await cli.api("GET", "/api/plugins");
    if (status >= 400) { err("ERROR: " + String(payload?.error)); return 1; }
    result = action === "list" ? payload.plugins : (payload.plugins as Row[]).find((item) => item.id === a.id);
    if (result === undefined) { err("ERROR: unknown plugin: " + a.id); return 1; }
  } else {
    const enabled = action === "enable";
    const [status, payload] = await cli.api("POST", "/api/plugins/" + encodeURIComponent(String(a.id)), { enabled });
    if (status >= 400) { err("ERROR: " + String(payload?.error)); return 1; }
    result = (payload.plugins as Row[]).find((item) => item.id === a.id) ?? { id: a.id, enabled };
  }
  out(dumps(result, 2));
  return 0;
}
