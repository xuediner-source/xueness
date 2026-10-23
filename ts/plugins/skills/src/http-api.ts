/**
 * Skills HTTP surface (Python `files_api.dispatch` plus `resources.dispatch`
 * for kind `skills`). `GET /api/resources/skills/files` lists the merged rows
 * for one fenced workspace root; other methods on that path are refused.
 * Bundled ZCode skills are not part of this listing (`bundled=null`).
 */
import { isAbsolute, join, relative } from "node:path";
import { realish, resourceDispatch } from "@xueness/sessions";
import { MAX_SKILL_FILE_BYTES, MAX_SKILLS_PER_ROOT } from "./discover.ts";
import { listAll, READ_TOTAL_BUDGET, TOTAL_MAX_CHARS } from "./render.ts";

export interface SkillsHttpOptions {
  stateDir: string | null;
  webRuns: string;
  projectDir: string;
  enabled(id: string): boolean;
  /** `workspaces_api.allowed_roots`: operator-declared and remembered workspace roots. */
  allowedRoots(): readonly string[];
}
type Reply = [number, unknown];
type Query = Record<string, readonly string[] | undefined>;
export const SKILLS_ROUTES = ["GET /api/resources/skills", "POST /api/resources/skills", "PUT /api/resources/skills", "PATCH /api/resources/skills/:id", "DELETE /api/resources/skills/:id", "GET /api/resources/skills/files"];

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

export function createSkillsHttp(o: SkillsHttpOptions) {
  const owns = (method: string, p: readonly string[]): boolean => p[0] === "api" && p[1] === "resources" && p[2] === "skills"
    && (p.length === 4 && p[3] === "files" || p.length === 3 && ["GET", "POST", "PUT"].includes(verb(method)) || p.length === 4 && ["PATCH", "DELETE"].includes(verb(method)));
  const files = (method: string, query: Query): Reply => {
    if (verb(method) !== "GET") return [405, { error: "method not allowed" }];
    if (o.stateDir == null) return [400, { error: "state_dir missing from context" }];
    const raw = queryValue(query, "root");
    let root: string | null = null;
    if (raw) { try { root = fencedRoot(raw, o); } catch { return [400, { error: "workspace root not permitted" }]; } }
    const stateDir = realish(o.stateDir);
    try {
      const document = listAll(stateDir, root, true, null);
      return [200, { root, stateDir, skills: document.skills, diagnostics: document.diagnostics,
        limits: { catalogChars: TOTAL_MAX_CHARS, bodyChars: READ_TOTAL_BUDGET, skillFileBytes: MAX_SKILL_FILE_BYTES, skillsPerRoot: MAX_SKILLS_PER_ROOT } }];
    } catch { return [500, { error: "skill roots could not be read" }]; }
  };
  return {
    routes: SKILLS_ROUTES,
    owns,
    /** Stored skill documents keep Python's exact numbers. The files GET does not. */
    lossless: (method: string, p: readonly string[]): boolean => owns(method, p) && !(p.length === 4 && p[3] === "files"),
    dispatch(method: string, p: string[], query: Query, data: unknown): Reply | null {
      if (!owns(method, p)) return null;
      if (!o.enabled("skills")) return disabled();
      if (p.length === 4 && p[3] === "files") return files(method, query);
      if (o.stateDir == null) return [400, { error: "state_dir missing from context" }];
      return resourceDispatch(realish(o.stateDir), method, p, data);
    },
  };
}
