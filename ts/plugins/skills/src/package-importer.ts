/**
 * The skill folder type for the host's general package import surface.
 *
 * A skill folder is a `SKILL.md` with `name` and `description` frontmatter
 * plus whatever the skill refers to (scripts, references, assets). Importing
 * one here is the same operation as "add from folder" on the skills page: it
 * goes through the staged, validated folder import of this plugin and lands
 * in the user skill directory, where the skill's own switch applies. Skill
 * folders written for Claude Code use the same layout and import unchanged.
 * Files are copied as data; nothing in the folder is executed by importing.
 *
 * The shape matches the import registry's importer contract structurally;
 * this plugin does not depend on the plugin that owns the registry.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { MAX_SKILL_FILE_BYTES } from "./discover.ts";
import { beginFolderImport, cancelFolderImport, commitFolderImport, FOLDER_IMPORT_LIMITS, importedSkillFolder, removeImportedSkill, writeFolderChunk } from "./folder-import.ts";
import { parseFrontmatter, validateFrontmatter } from "./frontmatter.ts";
import { isDir, isLink, lexists, readText } from "./paths.ts";

type Row = Record<string, unknown>;
const refuse = (code: string, message: string): Row => ({ ok: false, error: { code, message } });
const isObject = (value: unknown): value is Row => typeof value === "object" && value !== null && !Array.isArray(value);
const baseName = (path: string): string => path.replace(/\\/g, "/").split("/").at(-1) ?? "";

function meta(text: unknown): { name: string; description: string } | null {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_SKILL_FILE_BYTES) return null;
  const parsed = parseFrontmatter(text.replace(/^﻿/, ""));
  const checked = validateFrontmatter(parsed.values, parsed.keys);
  return parsed.error || !checked.meta ? null : { name: checked.meta.name, description: checked.meta.description };
}

/** The other files of the folder, as bytes; `SKILL.md` itself comes from the manifest text. */
function attachments(body: Row): { path: string; bytes: Buffer }[] | null {
  const files: { path: string; bytes: Buffer }[] = [];
  for (const file of Array.isArray(body.files) ? body.files : []) {
    if (!isObject(file) || typeof file.path !== "string" || typeof file.content !== "string") return null;
    const path = file.path.replace(/\\/g, "/");
    if (path === "SKILL.md") continue;
    files.push({ path, bytes: file.encoding === "base64" ? Buffer.from(file.content, "base64") : Buffer.from(file.content, "utf8") });
  }
  return files;
}

const view = (name: string, description: string, files: readonly string[]) => ({
  id: name, version: "", name, description, author: "", facts: [],
  counts: [{ label: "文件", count: files.length }],
  sections: files.length > 1 ? [{ title: "文件", rows: files.slice(0, 60).map(path => ({ name: path })) }] : [],
});

export function skillPackageImporter(options: { stateDir: string }) {
  const root = join(options.stateDir, "skills");
  const filesOf = (name: string): string[] => {
    const found: string[] = [];
    const walk = (directory: string, prefix: string) => {
      let names: string[];
      try { names = readdirSync(directory).sort(); } catch { return; }
      for (const entry of names) {
        const path = join(directory, entry);
        if (isLink(path) || entry === ".xueness-import.json" || found.length >= 200) continue;
        if (isDir(path)) walk(path, `${prefix}${entry}/`); else found.push(prefix + entry);
      }
    };
    walk(join(root, name), "");
    return found;
  };
  return {
    type: "skill", owner: "skills", name: "技能文件夹", nameEn: "Skill folder", manifestNames: ["SKILL.md"],
    detect: (body: Row): boolean => baseName(typeof body.fileName === "string" ? body.fileName : "") === "SKILL.md" && meta(body.manifest) !== null,
    /** Skills added from a folder, here or on the skills page. */
    list(): Row[] {
      if (isLink(options.stateDir) || isLink(root) || !isDir(root)) return [];
      let names: string[];
      try { names = readdirSync(root).sort(); } catch { return []; }
      return names.filter(name => importedSkillFolder(options.stateDir, name)).map(name => {
        const read = readText(join(root, name, "SKILL.md"), MAX_SKILL_FILE_BYTES);
        return { ...view(name, meta(read.text)?.description ?? "", filesOf(name)), status: read.text === null ? "attention" : "ok" };
      });
    },
    preview(body: Row): Row {
      const skill = meta(body.manifest);
      if (!skill) return refuse("invalid_manifest", "SKILL.md needs valid name and description frontmatter");
      const extra = attachments(body);
      if (extra === null) return refuse("invalid_input", "each file needs a path and content");
      const exists = lexists(join(root, skill.name)), replaceable = exists && importedSkillFolder(options.stateDir, skill.name);
      return { ok: true, preview: { ...view(skill.name, skill.description, ["SKILL.md", ...extra.map(file => file.path)]), replaces: replaceable ? "" : null, missing: [], wants: ["**"],
        blocked: exists && !replaceable,
        notes: exists && !replaceable ? [{ tone: "danger", text: "已有同名技能，且不是通过文件夹添加的。请先改名或在技能页面处理。" }] : [{ tone: "warn", text: "导入后技能立即可用，可在技能页面单独关闭。" }] } };
    },
    install(body: Row): Row {
      const skill = meta(body.manifest);
      if (!skill) return refuse("invalid_manifest", "SKILL.md needs valid name and description frontmatter");
      const extra = attachments(body);
      if (extra === null) return refuse("invalid_input", "each file needs a path and content");
      const exists = lexists(join(root, skill.name));
      if (exists && !(body.replace === true && importedSkillFolder(options.stateDir, skill.name))) return refuse("already_imported", `skill ${skill.name} already exists`);
      const files = [{ path: "SKILL.md", bytes: Buffer.from(String(body.manifest), "utf8") }, ...extra].map(file => ({ path: `skill/${file.path}`, bytes: file.bytes }));
      let token = "";
      try {
        // The staged upload validates every path and size before anything becomes visible.
        token = beginFolderImport(options.stateDir, { files: files.map(file => ({ path: file.path, bytes: file.bytes.length })) }).token;
        for (const file of files) {
          for (let offset = 0; offset < file.bytes.length || offset === 0; offset += FOLDER_IMPORT_LIMITS.chunkBytes) {
            writeFolderChunk(options.stateDir, token, { path: file.path, offset, content: file.bytes.subarray(offset, offset + FOLDER_IMPORT_LIMITS.chunkBytes).toString("base64") });
            if (!file.bytes.length) break;
          }
        }
        if (exists) removeImportedSkill(options.stateDir, skill.name);
        commitFolderImport(options.stateDir, token);
      } catch (error) {
        if (token) { try { cancelFolderImport(options.stateDir, token); } catch { /* The staging folder expires on its own. */ } }
        return refuse("install_failed", error instanceof Error ? error.message : "the skill folder could not be imported");
      }
      return { ok: true, item: { ...view(skill.name, skill.description, files.map(file => file.path.slice("skill/".length))), status: "ok" } };
    },
    remove(id: unknown): Row {
      if (typeof id !== "string") return refuse("invalid_input", "a skill name is required");
      try { removeImportedSkill(options.stateDir, id); return { ok: true }; } catch (error) { return refuse("remove_failed", error instanceof Error ? error.message : "the skill could not be removed"); }
    },
  };
}
