/**
 * Skills HTTP surface (Python `files_api.dispatch` plus `resources.dispatch`
 * for kind `skills`). `GET /api/resources/skills/files` lists the merged rows
 * for one fenced workspace root; other methods on that path are refused.
 * Bundled ZCode skills are not part of this listing (`bundled=null`).
 */
import { isAbsolute, join, relative } from "node:path";
import { realish, resourceDispatch } from "@xueness/sessions";
import { isDict } from "@xueness/contracts";
import { MAX_SKILL_FILE_BYTES, MAX_SKILLS_PER_ROOT } from "./discover.ts";
import { listAll, READ_TOTAL_BUDGET, TOTAL_MAX_CHARS } from "./render.ts";
import { beginFolderImport, cancelFolderImport, commitFolderImport, importedSkillFolder, removeImportedSkill, writeFolderChunk } from "./folder-import.ts";
import { BUNDLED_SKILLS_DIR } from "./bundled.ts";
import { setFileSkillEnabled } from "./switches.ts";

export interface SkillsHttpOptions {
  stateDir: string | null;
  webRuns: string;
  projectDir: string;
  enabled(id: string): boolean;
  bundled?: string | null;
  /** `workspaces_api.allowed_roots`: operator-declared and remembered workspace roots. */
  allowedRoots(): readonly string[];
}
type Reply = [number, unknown];
type Query = Record<string, readonly string[] | undefined>;
export const SKILLS_ROUTES = ["GET /api/resources/skills", "POST /api/resources/skills", "PUT /api/resources/skills", "PATCH /api/resources/skills/:id", "DELETE /api/resources/skills/:id", "GET /api/resources/skills/files",
  "POST /api/resources/skills/imports", "PUT /api/resources/skills/imports/:token", "POST /api/resources/skills/imports/:token/commit", "DELETE /api/resources/skills/imports/:token", "DELETE /api/resources/skills/folders/:name", "POST /api/resources/skills/files/state"];

/** `parse_qs` drops blank values: the first non-blank one, or "". */
export const queryValue = (query: Query, name: string): string => (Object.hasOwn(query, name) ? query[name] ?? [] : []).find((value) => value !== "") ?? "";

/** `web._allowed_root`: relative roots live under web runs; the target must sit inside a permitted base. */
export function fencedRoot(value: string, o: { webRuns: string; projectDir: string; allowedRoots(): readonly string[] }): string {
  if (value.includes("\0")) throw new Error("embedded null byte");
  const target = realish(isAbsolute(value) ? value : join(realish(o.webRuns), value));
  const roots = [o.webRuns, o.projectDir, ...o.allowedRoots()].map((root) => realish(root));
  if (!roots.some((root) => { const rel = relative(root, target); return rel === "" || !rel.startsWith("..") && !isAbsolute(rel); })) throw new Error("workspace root not permitted");
  return target;
}

const disabled = (): Reply => [403, { error: "plugin disabled or dependency unavailable: skills", plugin: "skills" }];
const verb = (method: string): string => method.toUpperCase();
const importing = (method: string, p: readonly string[]): boolean => p[3] === "imports" && (p.length > 4 || verb(method) === "POST") || p.length === 5 && p[3] === "folders";

export function createSkillsHttp(o: SkillsHttpOptions) {
  const owns = (method: string, p: readonly string[]): boolean => p[0] === "api" && p[1] === "resources" && p[2] === "skills"
    && (p.length === 4 && p[3] === "files" || p.length === 3 && ["GET", "POST", "PUT"].includes(verb(method)) || p.length === 4 && ["PATCH", "DELETE"].includes(verb(method))
      || p[3] === "imports" && p.length >= 4 && p.length <= 6 || p.length === 5 && (p[3] === "folders" || p[3] === "files" && p[4] === "state"));
  const files = (method: string, query: Query): Reply => {
    if (verb(method) !== "GET") return [405, { error: "method not allowed" }];
    if (o.stateDir == null) return [400, { error: "state_dir missing from context" }];
    const raw = queryValue(query, "root");
    let root: string | null = null;
    if (raw) { try { root = fencedRoot(raw, o); } catch { return [400, { error: "workspace root not permitted" }]; } }
    const stateDir = realish(o.stateDir);
    try {
      const document = listAll(stateDir, root, true, o.bundled === undefined ? BUNDLED_SKILLS_DIR : o.bundled);
      const skills = document.skills.map(skill => ({ ...skill, enabled: skill.enabled !== false, imported: skill.source === "user" && importedSkillFolder(stateDir, skill.name) }));
      return [200, { root, stateDir, skills, diagnostics: document.diagnostics,
        limits: { catalogChars: TOTAL_MAX_CHARS, bodyChars: READ_TOTAL_BUDGET, skillFileBytes: MAX_SKILL_FILE_BYTES, skillsPerRoot: MAX_SKILLS_PER_ROOT } }];
    } catch { return [500, { error: "skill roots could not be read" }]; }
  };
  return {
    routes: SKILLS_ROUTES,
    owns,
    /** Stored skill documents keep Python's exact numbers. The files GET does not. */
    lossless: (method: string, p: readonly string[]): boolean => owns(method, p) && !importing(method, p) && !(p.length === 4 && p[3] === "files"),
    dispatch(method: string, p: string[], query: Query, data: unknown): Reply | null {
      if (!owns(method, p)) return null;
      if (!o.enabled("skills")) return disabled();
      if (p.length === 4 && p[3] === "files") return files(method, query);
      if (o.stateDir == null) return [400, { error: "state_dir missing from context" }];
      if (p.length === 5 && p[3] === "files" && p[4] === "state") {
        if (verb(method) !== "POST") return [405, { error: "method not allowed" }];
        if (!isDict(data) || Object.keys(data).sort().join(",") !== "enabled,id" || typeof data.id !== "string" || typeof data.enabled !== "boolean") return [400, { error: "invalid skill switch" }];
        const state = realish(o.stateDir);
        try {
          const skill = listAll(state, null, true, o.bundled === undefined ? BUNDLED_SKILLS_DIR : o.bundled).skills.find(row => row.id === data.id && row.source !== "resource");
          if (!skill) return [404, { error: "skill not found" }];
          setFileSkillEnabled(state, skill.id, data.enabled);
          return [200, { id: skill.id, enabled: data.enabled }];
        } catch (error) { return [400, { error: error instanceof Error ? error.message : "skill switch failed" }]; }
      }
      if (importing(method, p)) {
        try {
          const state = realish(o.stateDir), m = verb(method);
          if (p.length === 4 && m === "POST") return [200, beginFolderImport(state, data)];
          if (p.length === 5 && p[3] === "imports" && m === "PUT") return [200, writeFolderChunk(state, p[4]!, data)];
          if (p.length === 6 && p[3] === "imports" && p[5] === "commit" && m === "POST") return [200, commitFolderImport(state, p[4]!)];
          if (p.length === 5 && p[3] === "imports" && m === "DELETE") return [200, cancelFolderImport(state, p[4]!)];
          if (p.length === 5 && p[3] === "folders" && m === "DELETE") return [200, removeImportedSkill(state, p[4]!)];
          return [405, { error: "method not allowed" }];
        } catch (error) { return [400, { error: error instanceof Error ? error.message : "技能文件夹导入失败" }]; }
      }
      return resourceDispatch(realish(o.stateDir), method, p, data);
    },
  };
}
