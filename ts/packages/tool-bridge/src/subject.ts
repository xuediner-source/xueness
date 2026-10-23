/**
 * What a permission decision is about. A tool may say so itself (`subject`,
 * `subjectKind`); otherwise its Gate kind decides. Path kinds use the call's
 * `path` (default ".") resolved inside the workspace, symlinks included, and
 * shown relative to its root, so `edit(src/**)` means the same file however
 * the model spelled it. A command kind uses `command`; anything else has an
 * empty subject, like Python's Gate.
 *
 * In plan mode the session's plan draft is the one file outside the
 * workspace a write or an edit may reach, and a read too (overwriting a file
 * needs a prior read); that call gets the draft's directory as an extra root.
 * Like Python, a draft that is a link, or sits in a linked directory, is refused.
 * A host-owned directory (`hostWritable`) works the same way in every mode,
 * with the call's real absolute path as the subject.
 */
import { lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { resolveWorkspacePath, type ToolDefinition, type ToolEnv } from "@xueness/engine-tools";
import type { PermissionSession, SubjectKind } from "@xueness/permissions";

export const PATH_KINDS: ReadonlySet<string> = new Set(["read", "list", "glob", "grep", "write", "edit"]);

export interface CallSubject {
  subject: string;
  subjectKind: SubjectKind;
  /** The plan draft's directory when plan mode lets this call write the draft. */
  draftRoot: string | null;
  /** Resolved workspace paths of a multi-file call (`subjectPaths`); each is authorized separately. */
  paths?: readonly string[];
}

export class PlanDraftLinkError extends Error {
  override name = "PlanDraftLinkError";
  readonly code = "permission_denied";
}

export function subjectKindOf(tool: Pick<ToolDefinition, "gate" | "subjectKind">): SubjectKind {
  return tool.subjectKind ?? (tool.gate === "exec" ? "command" : PATH_KINDS.has(tool.gate) ? "path" : "text");
}

/** Throws PathOutsideWorkspaceError (path_outside_workspace) or TypeError (invalid_argument). */
export async function callSubject(
  tool: ToolDefinition<any, unknown>, input: Record<string, unknown>, env: Pick<ToolEnv, "cwd" | "roots">, permissions: PermissionSession,
): Promise<CallSubject> {
  const subjectKind = subjectKindOf(tool);
  if (tool.subjectPaths) {
    const raw = tool.subjectPaths(input);
    if (!Array.isArray(raw) || !raw.length || raw.some((path) => typeof path !== "string" || !path)) throw new TypeError(`${tool.name} gave no permission subject`);
    const paths: string[] = [];
    for (const path of raw) {
      const { display } = await resolveWorkspacePath(path, env.cwd, env.roots);
      if (!paths.includes(display)) paths.push(display);
    }
    return { subject: paths.join("\n"), subjectKind: "path", draftRoot: null, paths };
  }
  if (tool.subject) {
    const subject = tool.subject(input);
    if (typeof subject !== "string") throw new TypeError(`${tool.name} gave no permission subject`);
    return { subject, subjectKind, draftRoot: null };
  }
  if (subjectKind === "command") return { subject: typeof input.command === "string" ? input.command : "", subjectKind, draftRoot: null };
  if (subjectKind !== "path") return { subject: "", subjectKind, draftRoot: null };
  const raw = typeof input.path === "string" && input.path ? input.path : ".";
  const draft = permissions.planDraftTarget(tool.gate === "read" ? "write" : tool.gate, resolve(env.cwd, raw));
  if (draft) {
    for (const path of [draft, dirname(draft)]) {
      if ((await lstat(path).catch(() => null))?.isSymbolicLink()) throw new PlanDraftLinkError("the plan draft must not be a link");
    }
    return { subject: draft, subjectKind, draftRoot: dirname(draft) };
  }
  // A host-owned directory (the visualization directory) is the call's extra root; links may not leave it.
  const host = permissions.hostWritableTarget(tool.gate, resolve(env.cwd, raw));
  if (host) return { subject: (await resolveWorkspacePath(raw, env.cwd, [host])).absolute, subjectKind, draftRoot: host };
  const { display } = await resolveWorkspacePath(raw, env.cwd, env.roots);
  return { subject: display, subjectKind, draftRoot: null };
}
