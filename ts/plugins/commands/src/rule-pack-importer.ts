/**
 * The Cursor rule pack type for the host's general package import surface.
 *
 * A rule pack is loose text: a `.cursorrules` file and/or `.mdc`/`.md` rule
 * files under `.cursor/rules`. Each rule becomes one prompt template that the
 * person can activate as a slash command of this plugin. Rules are prompts,
 * so nothing here is executed. The pack's imported copy lives in the store
 * the host passes in; this module only parses and describes.
 *
 * The shape matches the import registry's importer contract structurally;
 * this plugin does not depend on the plugin that owns the registry.
 */
type Row = Record<string, unknown>;
interface Contribution { kind: "commands"; id: string; name: string; description: string; body: string }
interface StoredPack { id: string; version: string; name: string; description: string; fileName: string; importedAt: string; contributions: Contribution[] }
/** The host's text-package store for this type. */
export interface RulePackStore { list(): StoredPack[] | { id: string }[]; get(id: string): unknown; put(pkg: StoredPack): void; remove(id: string): boolean }

const MAX_RULE_CHARS = 64 * 1024, MAX_RULES = 64;
const RULE_FILE = /\.(mdc|md)$/i;
const refuse = (code: string, message: string): Row => ({ ok: false, error: { code, message } });
const isObject = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const baseName = (path: string): string => path.replace(/\\/g, "/").split("/").at(-1) ?? "";
/** A lowercase id usable as a resource id and in a slash command. */
export const ruleSlug = (value: string): string => value.toLowerCase().replace(/\.(mdc|md)$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/** `.mdc` files open with a `---` block (`description`, `globs`, `alwaysApply`); the rule is what follows. */
function ruleText(source: string): { description: string; body: string } {
  const text = source.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return { description: "", body: text.trim() };
  const description = /^description:\s*(.+)$/m.exec(match[1]!)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
  return { description: description.slice(0, 300), body: text.slice(match[0].length).trim() };
}

function decode(file: Row): string | null {
  if (typeof file.content !== "string") return null;
  try { return file.encoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content; } catch { return null; }
}

interface Parsed { id: string; fileName: string; rules: Contribution[]; wants: string[] }

function parse(body: Row): Parsed | Row {
  const fileName = typeof body.fileName === "string" ? body.fileName.replace(/\\/g, "/") : "";
  const name = baseName(fileName);
  const main = name === ".cursorrules";
  if (!main && !/\.mdc$/i.test(name)) return refuse("unknown_package_type", "not a Cursor rule file");
  if (typeof body.manifest !== "string" || body.manifest.length > MAX_RULE_CHARS) return refuse("too_large", "a rule file is limited to 64 KB of text");
  // The folder that holds the project names the pack: `<project>/.cursorrules` or `<project>/.cursor/rules/<rule>.mdc`.
  const folders = fileName.split("/").slice(0, -1);
  const project = main ? folders.at(-1) : folders.at(-1) === "rules" && folders.at(-2) === ".cursor" ? folders.at(-3) : folders.at(-1);
  const id = ruleSlug(typeof body.id === "string" && body.id ? body.id : project ?? "") || "cursor-rules";
  const seen = new Set<string>(), rules: Contribution[] = [];
  const add = (ruleName: string, source: string) => {
    const { description, body: text } = ruleText(source);
    let ruleId = ruleSlug(ruleName) || `rule-${rules.length + 1}`;
    while (seen.has(ruleId)) ruleId += "-2";
    if (!text || text.length > MAX_RULE_CHARS || rules.length >= MAX_RULES) return;
    seen.add(ruleId);
    rules.push({ kind: "commands", id: ruleId, name: `${id}.${ruleId}`, description: description || `Cursor rule from ${id}`, body: text });
  };
  add(main ? "cursor-rules" : name, body.manifest);
  const prefix = main ? ".cursor/rules/" : "";
  for (const file of Array.isArray(body.files) ? body.files.filter(isObject) : []) {
    const path = typeof file.path === "string" ? file.path.replace(/\\/g, "/") : "";
    if (!path.startsWith(prefix) || path.slice(prefix.length).includes("/") || !RULE_FILE.test(path) || (!main && baseName(path) === name)) continue;
    const text = decode(file);
    if (text !== null) add(baseName(path), text);
  }
  if (!rules.length) return refuse("invalid_manifest", "the rule file is empty");
  // Sibling rule files, relative to the picked manifest's folder.
  return { id, fileName, rules, wants: main ? [".cursor/rules/*.mdc", ".cursor/rules/*.md"] : ["*.mdc", "*.md"] };
}

const view = (pack: { id: string; version: string; name: string; description: string; contributions: Contribution[] }) => ({
  id: pack.id, version: pack.version, name: pack.name, description: pack.description, author: "", facts: [],
  counts: [{ label: "规则", count: pack.contributions.length }],
  sections: [{ title: "规则", rows: pack.contributions.map(rule => ({ name: rule.id, note: rule.description, body: rule.body.slice(0, 400) })) }],
});

export function rulePackImporter(options: { store: RulePackStore; now?: () => string }) {
  const stored = (id: unknown): StoredPack | null => { const found = typeof id === "string" ? options.store.get(id) : null; return isObject(found) ? found as unknown as StoredPack : null; };
  const packOf = (parsed: Parsed): StoredPack => ({ id: parsed.id, version: "", name: parsed.id, description: "", fileName: parsed.fileName,
    importedAt: (options.now ?? (() => new Date().toISOString()))(), contributions: parsed.rules });
  return {
    type: "cursor-rules", owner: "commands", name: "Cursor 规则包", nameEn: "Cursor rule pack", manifestNames: [".cursorrules", "*.mdc"],
    detect: (body: Row): boolean => { const name = baseName(typeof body.fileName === "string" ? body.fileName : ""); return name === ".cursorrules" || /\.mdc$/i.test(name); },
    list: (): Row[] => (options.store.list() as StoredPack[]).map(pack => ({ ...view(pack), status: "ok", importedAt: pack.importedAt, fileName: pack.fileName })),
    preview(body: Row): Row {
      const parsed = parse(body);
      if (!("rules" in parsed)) return parsed;
      return { ok: true, preview: { ...view(packOf(parsed as Parsed)), replaces: stored((parsed as Parsed).id) ? "" : null, missing: [], wants: (parsed as Parsed).wants, blocked: false,
        notes: [{ tone: "warn", text: "导入后不会自动生效；启用后每条规则成为一个斜杠命令。" }] } };
    },
    install(body: Row): Row {
      const parsed = parse(body);
      if (!("rules" in parsed)) return parsed;
      const pack = packOf(parsed as Parsed);
      if (stored(pack.id) && body.replace !== true) return refuse("already_imported", `rule pack ${pack.id} is already imported`);
      try { options.store.put(pack); } catch { return refuse("install_failed", "the rule pack could not be saved"); }
      return { ok: true, item: { ...view(pack), status: "ok", importedAt: pack.importedAt, fileName: pack.fileName } };
    },
    remove: (id: unknown): Row => typeof id === "string" && options.store.remove(id) ? { ok: true } : refuse("not_found", `rule pack ${String(id)} is not imported`),
    contributions: (id: string): Contribution[] => stored(id)?.contributions ?? [],
    version: (): string => "",
  };
}
