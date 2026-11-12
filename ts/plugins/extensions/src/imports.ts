/**
 * General package import: one surface, many package types.
 *
 *   GET  /api/plugins/imports           registered types and every imported item
 *   POST /api/plugins/imports/preview   { type?, manifest, files?, fileName? }
 *   POST /api/plugins/imports/install   { type?, manifest, files?, fileName?, replace? }
 *   POST /api/plugins/imports/remove    { type, id }
 *   POST /api/plugins/imports/activate  { type, id }   write the package's skills and prompt templates as resources
 *   POST /api/plugins/imports/deactivate { type, id }  remove exactly those resources
 *
 * A type is contributed by the plugin that owns the format and works only
 * while that plugin is effective. This module knows no format: it picks the
 * importer (the named `type`, or the single one that recognises the body)
 * and forwards. Importers answer with `PackageView` rows, so the settings
 * page and the CLI render every type the same way. Bodies carry text the
 * person picked locally; nothing is fetched and nothing from a package is
 * executed. Validation results, refusals included, answer 200 with `ok`.
 */
import { optionalArtifactByPackage } from "@xueness/kernel";
import { COMPONENT_KINDS, loadComponentPackages, uninstallPackage, validateComponents, type ComponentDeclaration, type ComponentKind } from "./components.ts";
import { contributionIssues } from "./contribution.ts";
import { installAll } from "./sdk.ts";
import { activatePackage, activationState, deactivatePackage, type PackageContribution, type ResourceWriter } from "./activation.ts";

type Row = Record<string, unknown>;
export type ImportReply = [number, unknown];

/** Display text is Chinese source text; clients translate it and fill `{n}` from `args`. */
export interface ViewNote { tone: "warn" | "danger"; text: string; args?: string[] }
export interface ViewRow { name: string; note?: string; body?: string; chips?: { text: string; tone?: "warn" }[] }
/** One package, described without reference to its format. */
export interface PackageView {
  id: string;
  version: string;
  name: string;
  description: string;
  author: string;
  facts: { label: string; value: string }[];
  counts: { label: string; count: number }[];
  sections: { title: string; rows: ViewRow[] }[];
  /** Imported items only. */
  status?: "ok" | "attention";
  checks?: { label: string; ok: boolean; detail: string }[];
  importedAt?: string;
  fileName?: string;
  enabled?: boolean;
  /** Installed and removed elsewhere (the marketplace); this surface only shows it. */
  managed?: boolean;
}
/**
 * `preview` adds what installing would do. `missing` lists package files the importer still wants as text. `wants` lists
 * path patterns, relative to the manifest's folder (`*` within a segment, `**` across segments), whose files the client
 * sends as `{ path, content, encoding: "base64" }`. `replaces` is the imported version, or "" when the format has none.
 */
export interface PackagePreview extends PackageView { replaces: string | null; missing: string[]; wants?: string[]; notes: ViewNote[]; blocked: boolean }

/** What a plugin implements to make one package format importable. */
export interface PackageImporter {
  /** Stable type id shown to people and sent back as `type`. */
  readonly type: string;
  /** Plugin that owns the format; the type is unavailable while it is not effective. */
  readonly owner: string;
  readonly name: string;
  readonly nameEn: string;
  /** Manifest file names to look for in a picked folder, most specific first; `*.ext` matches any file with that ending. */
  readonly manifestNames: readonly string[];
  /** Does this body look like this format? Pure and cheap; no I/O. */
  detect(body: Row): boolean;
  /** Imported items as `PackageView` rows. */
  list(): Row[];
  /** `{ ok: true, preview: PackagePreview }` or a refusal. */
  preview(body: Row): Row;
  /** `{ ok: true, item: PackageView }` or a refusal. */
  install(body: Row): Row;
  remove(id: unknown): Row;
  /** Text contributions of an imported package that the host may activate; absent when the format carries none. */
  contributions?(id: string): PackageContribution[];
  version?(id: string): string;
}

export const IMPORT_ROUTES = ["GET /api/plugins/imports", "POST /api/plugins/imports/preview", "POST /api/plugins/imports/install", "POST /api/plugins/imports/remove", "POST /api/plugins/imports/activate", "POST /api/plugins/imports/deactivate"];
export const MAX_IMPORT_MANIFEST_BYTES = 256 * 1024;
export const MAX_IMPORT_FILE_BYTES = 128 * 1024;
/** Folder files an importer asks for with `wants`; together with the manifest they must fit one request body. */
export const MAX_IMPORT_FOLDER_FILES = 100;
export const MAX_IMPORT_FOLDER_BYTES = 600 * 1024;

const isObject = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const refuse = (code: string, message: string, extra: Row = {}): Row => ({ ok: false, error: { code, message, ...extra } });

/** The body's `manifest` text as a JSON object, or null when it is absent, too large or not an object. */
export function manifestDocument(body: Row): Row | null {
  const text = body.manifest;
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_IMPORT_MANIFEST_BYTES) return null;
  try { const value = JSON.parse(text.replace(/^﻿/, "")) as unknown; return isObject(value) ? value : null; } catch { return null; }
}

const KIND_LABELS: Record<ComponentKind, string> = { skills: "技能", commands: "命令", hooks: "钩子", mcp: "MCP 服务器" };

function nativeView(manifest: { id: string; version: string; builtin: string; capabilities: readonly string[] }, components: readonly ComponentDeclaration[]): PackageView {
  const of = (kind: ComponentKind) => components.filter(component => component.kind === kind);
  return {
    id: manifest.id, version: manifest.version, name: manifest.id, description: "", author: "",
    facts: [{ label: "内置能力", value: manifest.builtin }, ...(manifest.capabilities.length ? [{ label: "声明权限", value: manifest.capabilities.join(", ") }] : [])],
    counts: COMPONENT_KINDS.map(kind => ({ label: KIND_LABELS[kind], count: of(kind).length })),
    sections: COMPONENT_KINDS.filter(kind => of(kind).length).map(kind => ({ title: KIND_LABELS[kind],
      rows: of(kind).map(component => ({ name: component.id, note: component.description,
        // A hook's command is shown in full before anything is saved: it is what would run.
        ...(component.hook ? { body: component.hook.command } : {}),
        ...(component.alwaysLoad || component.body || component.hook ? { chips: [...(component.alwaysLoad ? [{ text: "始终加载" }] : []), ...(component.body ? [{ text: "含内容" }] : []),
          ...(component.hook ? [{ text: component.hook.event }, { text: "需逐个检查后启用", tone: "warn" as const }] : [])] } : {}) })) })),
  };
}

/** Xueness's own declarative package manifest (`sdk.ts` / `contribution.ts`). */
export function nativeImporter(stateDir: string): PackageImporter {
  const check = (body: Row): [Row, null] | [null, Row] => {
    const document = manifestDocument(body);
    if (!document) return [null, refuse("invalid_manifest", "the manifest must be a JSON object of at most 256 KB")];
    const issues = contributionIssues(document);
    return issues.length ? [null, refuse("invalid_manifest", "the manifest does not pass package validation", { issues })] : [document, null];
  };
  const installed = (id: unknown): string | null => loadComponentPackages(stateDir).find(item => item.id === id)?.version ?? null;
  const viewOf = (document: Row): PackageView => nativeView({ id: String(document.id), version: String(document.version), builtin: String(document.builtin),
    capabilities: Array.isArray(document.capabilities) ? document.capabilities.map(String) : [] }, validateComponents(document.components, String(document.id))[0]);
  return {
    type: "xueness", owner: "extensions", name: "Xueness 声明式扩展包", nameEn: "Xueness declarative package", manifestNames: ["xueness-plugin.json"],
    detect: body => { const document = manifestDocument(body); return !!document && typeof document.builtin === "string" && document.sdkApiVersion === undefined; },
    list: () => loadComponentPackages(stateDir).map(item => ({ ...nativeView(item, item.components), status: "ok", enabled: item.enabled, managed: optionalArtifactByPackage(item.id) !== null })),
    preview(body) {
      const [document, refusal] = check(body);
      if (!document) return refusal;
      const managed = optionalArtifactByPackage(String(document.id)) !== null;
      const preview: PackagePreview = { ...viewOf(document), replaces: installed(document.id), missing: [], blocked: managed,
        notes: managed ? [{ tone: "danger", text: "官方可选插件请从扩展市场安装。" }] : [{ tone: "warn", text: "导入后默认关闭，需要到插件管理中启用。" }] };
      return { ok: true, preview };
    },
    install(body) {
      const [document, refusal] = check(body);
      if (!document) return refusal;
      if (optionalArtifactByPackage(String(document.id))) return refuse("managed_package", "official optional plugins are installed from the marketplace");
      const previous = installed(document.id);
      if (previous !== null && body.replace !== true) return refuse("already_imported", `package ${String(document.id)} ${previous} is already imported`);
      // An imported package starts disabled, as a marketplace install does; the person enables it in plugin management.
      const result = installAll(stateDir, [{ ...document, enabled: false }]);
      return result.ok ? { ok: true, item: { ...viewOf(document), status: "ok", enabled: false, managed: false } }
        : refuse("install_failed", "the package could not be saved", { issues: result.errors });
    },
    remove(id) {
      if (typeof id !== "string" || !id) return refuse("invalid_input", "a package id is required");
      if (optionalArtifactByPackage(id)) return refuse("managed_package", "official optional plugins are removed from the marketplace");
      const result = uninstallPackage(stateDir, id);
      return result.ok ? { ok: true } : refuse("remove_failed", result.error ?? `package ${id} could not be removed`);
    },
    /** Skills and commands whose text the package carries; components that only name something have nothing to activate. */
    contributions(id) {
      const pkg = loadComponentPackages(stateDir).find(item => item.id === id);
      return (pkg?.components ?? []).flatMap((component): PackageContribution[] => {
        if ((component.kind === "skills" || component.kind === "commands") && component.body) {
          return [{ kind: component.kind, id: component.id, name: component.kind === "skills" ? `${id}:${component.id}` : `${id}.${component.id}`, description: component.description, body: component.body }];
        }
        if (component.kind === "hooks" && component.hook) {
          const { command, ...when } = component.hook;
          return [{ kind: "hooks", id: component.id, name: `${id}.${component.id}`, description: component.description, body: command, hook: when }];
        }
        return [];
      });
    },
    version: id => installed(id) ?? "",
  };
}

export interface ImportsOptions {
  importers: readonly PackageImporter[];
  /** Is the plugin that owns a type effective right now? */
  enabled(id: string): boolean;
  stateDir: string;
  /** The owning plugins' resource handlers; without it nothing can be activated. */
  writeResource?: ResourceWriter;
}

export const ownsImports = (parts: readonly string[]): boolean => parts[0] === "api" && parts[1] === "plugins" && parts[2] === "imports";

export async function dispatchImports(options: ImportsOptions, method: string, parts: readonly string[], data: unknown): Promise<ImportReply | null> {
  if (!ownsImports(parts)) return null;
  const available = options.importers.filter(importer => options.enabled(importer.owner));
  if (parts.length === 3) {
    if (method !== "GET") return [405, { error: "method not allowed" }];
    return [200, {
      types: options.importers.map(({ type, owner, name, nameEn, manifestNames }) => ({ type, owner, name, nameEn, manifestNames, available: options.enabled(owner) })),
      items: available.flatMap(importer => importer.list().map(item => ({ ...item, type: importer.type,
        ...(importer.contributions ? { activation: activationState(options.stateDir, importer.type, String(item.id), importer.contributions(String(item.id))) } : {}) }))),
      limits: { manifestBytes: MAX_IMPORT_MANIFEST_BYTES, fileBytes: MAX_IMPORT_FILE_BYTES, folderFiles: MAX_IMPORT_FOLDER_FILES, folderBytes: MAX_IMPORT_FOLDER_BYTES },
    }];
  }
  const action = parts[3];
  if (parts.length !== 4 || method !== "POST") return [405, { error: "method not allowed" }];
  if (!["preview", "install", "remove", "activate", "deactivate"].includes(action ?? "")) return [404, { error: "import operation not found" }];
  const body = isObject(data) ? data : {};
  let importer: PackageImporter | undefined;
  if (typeof body.type === "string") {
    const named = options.importers.find(item => item.type === body.type);
    if (!named) return [200, refuse("unknown_package_type", `no importer is registered for type ${body.type}`)];
    if (!options.enabled(named.owner)) return [200, refuse("type_unavailable", `enable the ${named.owner} plugin to import this package type`, { plugin: named.owner, type: named.type })];
    importer = named;
  } else if (action !== "preview" && action !== "install") {
    return [200, refuse("invalid_input", `${action} needs the package type`)];
  } else {
    const matches = available.filter(item => item.detect(body));
    if (matches.length > 1) return [200, refuse("ambiguous_package_type", "more than one importer recognises this package; choose a type", { types: matches.map(item => item.type) })];
    importer = matches[0];
    if (!importer) {
      // Name the switch when a disabled plugin's format is the one that matches.
      const dormant = options.importers.find(item => !options.enabled(item.owner) && item.detect(body));
      return [200, dormant ? refuse("type_unavailable", `enable the ${dormant.owner} plugin to import this package type`, { plugin: dormant.owner, type: dormant.type })
        : refuse("unknown_package_type", "no registered importer recognises this package")];
    }
  }
  const type = importer.type, id = typeof body.id === "string" ? body.id : "";
  if (action === "activate" || action === "deactivate") {
    if (!id || !importer.list().some(item => item.id === id)) return [200, { ...refuse("not_found", `package ${id} is not imported`), type }];
    const contributions = importer.contributions?.(id) ?? [];
    if (!contributions.length) return [200, { ...refuse("nothing_to_activate", "this package has no skills or prompt templates to activate"), type }];
    if (action === "deactivate") return [200, { ok: true, type, removed: deactivatePackage(options.stateDir, type, id), activation: activationState(options.stateDir, type, id, contributions) }];
    if (!options.writeResource) return [200, { ...refuse("activation_unavailable", "this host cannot activate packages"), type }];
    const done = await activatePackage({ stateDir: options.stateDir, enabled: options.enabled, write: options.writeResource }, type, id, importer.version?.(id) ?? "", contributions);
    return [200, { ...done, type, ...(done.ok ? {} : { error: { code: "nothing_activated", message: "no contribution could be activated" } }), activation: activationState(options.stateDir, type, id, contributions) }];
  }
  if (action === "preview") return [200, { ...importer.preview(body), type }];
  if (action === "remove") {
    const result = importer.remove(body.id);
    // A removed package leaves nothing behind in other plugins' stores.
    return [200, { ...result, type, ...(result.ok === true && id ? { deactivated: deactivatePackage(options.stateDir, type, id) } : {}) }];
  }
  const result = importer.install(body);
  const installed = result.ok === true && isObject(result.item) && typeof result.item.id === "string" ? result.item.id : "";
  // Replacing an activated package refreshes what it activated; a fresh import activates nothing.
  if (installed && importer.contributions && options.writeResource) {
    const contributions = importer.contributions(installed);
    if (activationState(options.stateDir, type, installed, contributions).active > 0 || deactivatePackage(options.stateDir, type, installed) > 0) {
      await activatePackage({ stateDir: options.stateDir, enabled: options.enabled, write: options.writeResource }, type, installed, importer.version?.(installed) ?? "", contributions);
    }
  }
  return [200, { ...result, type }];
}
