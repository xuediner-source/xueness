/**
 * Static gate for bundled TypeScript plugins (`npm run check:plugins`).
 *
 * Plugins run in-process, so the capability guard only covers what the
 * kernel hands out (ctx.spawn, ctx.fetch, ctx.serve, ctx.secret, guard.path).
 * This gate covers what source code could reach on its own:
 *
 *  - plugins/<id>/manifest.json is a valid apiVersion 2 manifest named <id>,
 *    the catalog is clean, and apps/server/src/bundled-plugins.ts imports
 *    exactly the plugins under plugins/;
 *  - sources import only node builtins, @xueness/contracts, @xueness/kernel,
 *    @xueness/engine-tools and their own files (no third-party code, no other
 *    plugin's code, nothing outside the plugin directory);
 *  - a builtin or engine export that reaches outside needs the matching
 *    declared capability: child_process/worker_threads/cluster and process
 *    runners need exec, net/http/https/http2/tls/dgram/dns and global
 *    fetch/WebSocket/EventSource need net, fs and the file tools need fs;
 *  - no eval, Function, require, node:vm, process.binding or import() of a
 *    computed specifier;
 *  - the manifests' frontend and desktop module declarations hold
 *    (scripts/frontend-gate.ts).
 *
 * It is a lint, not a sandbox: it checks that a power is declared, not how
 * finely the code uses it. Type-only imports are ignored.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";
import { catalogIssues, upgradeManifestV1, validateManifest, type PluginManifest } from "@xueness/contracts";
import { frontendIssues } from "./frontend-gate.ts";

export type Need = "exec" | "net" | "fs";

export interface Finding {
  line: number;
  message: string;
}

const BUILTIN_NEEDS: Readonly<Record<string, Need>> = {
  child_process: "exec", worker_threads: "exec", cluster: "exec",
  net: "net", http: "net", https: "net", http2: "net", tls: "net", dgram: "net", dns: "net",
  fs: "fs",
};
/** Builtins that load, compile or inspect code. */
const FORBIDDEN_BUILTINS = new Set(["vm", "inspector", "repl", "module", "v8", "wasi", "trace_events"]);
const GLOBAL_NEEDS: Readonly<Record<string, Need>> = { fetch: "net", WebSocket: "net", EventSource: "net" };
/** Engine exports that run processes; every other value export of the engine touches files. */
const ENGINE_EXEC = new Set(["runProcess", "createExecTool", "execTool", "BUILTIN_TOOLS"]);
const MEDIATED = new Set(["@xueness/contracts", "@xueness/kernel"]);
/** Shared persistence and provider adapters carry the same powers as their I/O. */
const PACKAGE_NEEDS: Readonly<Record<string, readonly Need[]>> = {
  "@xueness/sessions": ["fs"],
  "@xueness/providers": ["net"],
  "@xueness/agent": ["fs"],
};
/** These reviewed exports only inspect data / tag object identity; no transport. */
const PROVIDER_PURE = new Set(["markBoundMediaMessage", "transferToolMedia", "bindToolMedia", "validMediaSignature", "b64decodeStrict", "FINISH_REASONS", "publicDiagnostics", "ProviderCallbackError", "ProviderRequestError", "ProviderCancelled", "notifyStreamCallback", "reportedUsage", "explicitRequestDeadline"]);
const EVAL_LIKE = new Set(["eval", "Function", "require"]);

export function declares(manifest: Pick<PluginManifest, "capabilities">, need: Need): boolean {
  const caps = manifest.capabilities;
  if (need === "exec") return caps.exec.length > 0;
  if (need === "net") return caps.net.connect.length > 0 || caps.net.listen.length > 0;
  return caps.fs.read.length > 0 || caps.fs.write.length > 0;
}

interface Imported {
  name: string;
  typeOnly: boolean;
}

function importedNames(clause: ts.ImportClause | undefined): Imported[] {
  if (!clause) return [];
  const typeOnly = clause.isTypeOnly;
  const names: Imported[] = clause.name ? [{ name: "default", typeOnly }] : [];
  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) names.push({ name: "*", typeOnly });
  if (bindings && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) names.push({ name: (element.propertyName ?? element.name).text, typeOnly: typeOnly || element.isTypeOnly });
  }
  return names;
}

function exportedNames(node: ts.ExportDeclaration): Imported[] {
  const clause = node.exportClause;
  if (!clause || !ts.isNamedExports(clause)) return [{ name: "*", typeOnly: node.isTypeOnly }];
  return clause.elements.map((element) => ({ name: (element.propertyName ?? element.name).text, typeOnly: node.isTypeOnly || element.isTypeOnly }));
}

/** Problems in one plugin source file, plus the packages it imports. */
export function scanSource(file: string, text: string, manifest: Pick<PluginManifest, "capabilities">, inside: (specifier: string) => boolean): { findings: Finding[]; packages: string[] } {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2024, true, ts.ScriptKind.TS);
  const findings: Finding[] = [];
  const packages = new Set<string>();
  const report = (node: ts.Node, message: string): void => {
    findings.push({ line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, message });
  };
  const need = (node: ts.Node, what: Need, why: string): void => {
    if (!declares(manifest, what)) report(node, `${why} needs a declared ${what} capability`);
  };
  const module = (node: ts.Node, specifier: string, names: Imported[]): void => {
    const values = names.filter((name) => !name.typeOnly);
    if (names.length && !values.length) return;
    if (specifier.startsWith(".")) return void (inside(specifier) || report(node, `${specifier} reaches outside the plugin directory`));
    const bare = specifier.replace(/^node:/, "");
    const root = bare.split("/")[0] as string;
    if (specifier.startsWith("node:") || builtinModules.includes(bare)) {
      if (FORBIDDEN_BUILTINS.has(root)) return void report(node, `${specifier} loads or inspects code and is not allowed in plugins`);
      const what = BUILTIN_NEEDS[root];
      if (what) need(node, what, specifier);
      return;
    }
    packages.add(specifier);
    if (specifier === "@xueness/engine-tools") {
      if (!values.length || values.some((name) => name.name === "*" || name.name === "default")) return void report(node, "import named exports from @xueness/engine-tools");
      for (const { name } of values) need(node, ENGINE_EXEC.has(name) ? "exec" : "fs", `${name} from @xueness/engine-tools`);
      return;
    }
    if (specifier === "@xueness/providers" && values.length && values.every((value) => PROVIDER_PURE.has(value.name))) return;
    if (PACKAGE_NEEDS[specifier]) {
      for (const what of PACKAGE_NEEDS[specifier]) need(node, what, specifier);
      return;
    }
    if (!MEDIATED.has(specifier)) report(node, `${specifier} is not allowed: plugins import node builtins, capability-checked infrastructure packages and their own files`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const names = importedNames(node.importClause);
      module(node, node.moduleSpecifier.text, node.importClause ? names : [{ name: "*", typeOnly: false }]);
    } else if (ts.isImportEqualsDeclaration(node)) {
      report(node, "import = require() is not allowed in plugins");
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      module(node, node.moduleSpecifier.text, exportedNames(node));
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument && ts.isStringLiteralLike(argument)) module(node, argument.text, [{ name: "*", typeOnly: false }]);
      else report(node, "import() of a computed specifier is not allowed in plugins");
    } else if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (EVAL_LIKE.has(name)) report(node, `${name}() is not allowed in plugins`);
      const what = GLOBAL_NEEDS[name];
      if (what) need(node, what, `global ${name}`);
    } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const [object, property] = [node.expression.text, node.name.text];
      if (object === "process" && ["binding", "_linkedBinding", "dlopen"].includes(property)) report(node, `process.${property} is not allowed in plugins`);
      const what = GLOBAL_NEEDS[property];
      if (what && (object === "globalThis" || object === "window" || object === "self")) need(node, what, `global ${property}`);
      if (EVAL_LIKE.has(property) && object === "globalThis") report(node, `globalThis.${property} is not allowed in plugins`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { findings, packages: [...packages] };
}

function* sourceFiles(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (entry.isFile() && /\.(?:ts|mts|js|mjs|cjs)$/.test(entry.name)) yield path;
  }
}

const within = (dir: string, path: string): boolean => {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

function readJson(path: string, problems: string[], shown: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    problems.push(`${shown}: ${(error as Error).message}`);
    return null;
  }
}

/** Catalog v1 and executable manifests must describe the same owned surfaces. */
export function manifestContractDrift(manifest: Pick<PluginManifest, "features" | "dependencies" | "frontendModules">, catalog: Pick<PluginManifest, "features" | "dependencies" | "frontendModules">): string[] {
  const sameSet = (left: string[], right: string[]): boolean => JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
  const fields: string[] = [];
  if (!sameSet(manifest.features.map(feature => feature.id), catalog.features.map(feature => feature.id))) fields.push("features");
  for (const field of ["dependencies", "frontendModules"] as const) if (!sameSet(manifest[field], catalog[field])) fields.push(field);
  return fields;
}

/** Every problem with the plugins under `root`/plugins; empty when the gate passes. */
export function checkPlugins(root: string): { problems: string[]; plugins: number; files: number } {
  const problems: string[] = [];
  const pluginsDir = join(root, "plugins");
  const ids = readdirSync(pluginsDir).filter((name) => statSync(join(pluginsDir, name)).isDirectory()).sort();
  const manifests: PluginManifest[] = [];
  let files = 0;
  for (const id of ids) {
    const dir = join(pluginsDir, id);
    const document = readJson(join(dir, "manifest.json"), problems, `plugins/${id}/manifest.json`);
    if (!document) continue;
    const { manifest, issues } = validateManifest(document);
    for (const issue of issues) problems.push(`plugins/${id}/manifest.json ${issue.path || "/"}: ${issue.message}`);
    if (!manifest) continue;
    if (manifest.id !== id) problems.push(`plugins/${id}/manifest.json /id: must be the directory name ${JSON.stringify(id)}`);
    manifests.push(manifest);
    const catalog = readJson(join(root, "catalog", `${id}.json`), problems, `catalog/${id}.json`);
    const upgraded = upgradeManifestV1(catalog);
    for (const issue of [...upgraded.issues, ...(upgraded.document ? validateManifest(upgraded.document).issues : [])]) {
      problems.push(`catalog/${id}.json ${issue.path || "/"}: ${issue.message}`);
    }
    if (upgraded.document) {
      const catalogManifest = validateManifest(upgraded.document).manifest;
      if (catalogManifest) for (const field of manifestContractDrift(manifest, catalogManifest)) problems.push(`catalog/${id}.json /${field}: ${field === "features" ? "feature IDs" : "declarations"} differ from the plugin manifest`);
    }
    const pkg = readJson(join(dir, "package.json"), problems, `plugins/${id}/package.json`) ?? {};
    if (pkg.name !== `@xueness/plugin-${id}`) problems.push(`plugins/${id}/package.json: name must be @xueness/plugin-${id}`);
    const deps = Object.keys((pkg.dependencies as Record<string, string> | undefined) ?? {});
    for (const dep of deps) if (!dep.startsWith("@xueness/")) problems.push(`plugins/${id}/package.json: ${dep} is not a workspace package`);
    for (const file of sourceFiles(join(dir, "src"))) {
      files += 1;
      const shown = relative(root, file).split("\\").join("/");
      const { findings, packages } = scanSource(shown, readFileSync(file, "utf8"), manifest, (specifier) => within(dir, resolve(dirname(file), specifier)));
      for (const finding of findings) problems.push(`${shown}:${finding.line}: ${finding.message}`);
      for (const name of packages) if (!deps.includes(name)) problems.push(`${shown}: imports ${name}, which plugins/${id}/package.json does not depend on`);
    }
  }
  for (const issue of catalogIssues(manifests)) problems.push(`plugins/${issue.plugin}/manifest.json ${issue.path}: ${issue.message}`);
  for (const issue of frontendIssues(join(root, ".."), manifests)) problems.push(`frontend: ${issue}`);
  const listFile = join(root, "apps", "server", "src", "bundled-plugins.ts");
  const listed = [...readFileSync(listFile, "utf8").matchAll(/from\s+["']@xueness\/plugin-([a-z][a-z0-9_]*)["']/g)].map((match) => match[1] as string).sort();
  // These three reviewed optional implementations ship separately. Core keeps
  // their manifest ownership, and the kernel accepts only build-pinned bytes.
  const optional = ["subscriptions", "model_monitor", "workbuddy"];
  const metadata = [...readFileSync(listFile, "utf8").matchAll(/from\s+["']\.\.\/\.\.\/\.\.\/plugins\/([a-z_]+)\/manifest\.json["']/g)].map(match => match[1]!);
  for (const id of metadata) {
    const manifest = manifests.find(item => item.id === id);
    if (!optional.includes(id) || !manifest?.installPackage || manifest.defaultEnabled) problems.push(`apps/server/src/bundled-plugins.ts: invalid optional descriptor ${id}`);
    else listed.push(id);
  }
  for (const id of ids.filter((id) => !listed.includes(id))) problems.push(`apps/server/src/bundled-plugins.ts: plugin ${id} is not listed`);
  for (const id of listed.filter((id) => !ids.includes(id))) problems.push(`apps/server/src/bundled-plugins.ts: ${id} is not a directory under plugins/`);
  return { problems, plugins: ids.length, files };
}
