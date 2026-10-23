/** Exact rules explicitly selected in the project approval dialog. */
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { atomicWriteJson, isLink, readJsonObject } from "@xueness/sessions";
import type { TuiPermissionRequest } from "./tui-types.ts";

function location(stateDir: string, root: string): { path: string; project: string } {
  const project = process.platform === "win32" ? resolve(root).toLowerCase() : resolve(root);
  const directory = join(stateDir, "project-permissions");
  if (isLink(stateDir) || isLink(directory)) throw new Error("project permissions directory must not be a link");
  return { project, path: join(directory, createHash("sha256").update(project).digest("hex") + ".json") };
}
export function loadProjectPermissionRules(stateDir: string, root: string): string[] {
  const { path, project } = location(stateDir, root), record = readJsonObject(path);
  return record?.project === project && Array.isArray(record.allow) ? record.allow.filter((value): value is string => typeof value === "string") : [];
}
export function rememberProjectPermission(stateDir: string, root: string, request: TuiPermissionRequest, rules: readonly string[]): void {
  if (request.code !== "approval_required" || !request.remember || !rules.length || rules.some((rule) => !request.remember!.exact.includes(rule))) throw new Error("only the offered exact project rules may be remembered");
  const { path, project } = location(stateDir, root);
  atomicWriteJson(path, { project, allow: [...new Set([...loadProjectPermissionRules(stateDir, root), ...rules])] });
}
