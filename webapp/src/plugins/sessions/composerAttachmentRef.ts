import { post } from "../../xuenessApi";

/** One attachment identity for file selection, paste, drop, and workspace paths. */
export type AttachmentOrigin = "file" | "paste" | "drop" | "workspace";

export type RemoteAttachmentEndpoint = { connectionId: string; digest: string; workspaceIdentity: string };
export type RemoteAttachmentOwner = RemoteAttachmentEndpoint & { root: string; sessionId?: string; draftKey: string };
export function parseRemoteAttachmentEndpoint(value: unknown): RemoteAttachmentEndpoint | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as RemoteAttachmentEndpoint;
  return [r.connectionId, r.digest, r.workspaceIdentity].every(v => typeof v === "string" && v.length > 0 && v.length <= 4096)
    ? { connectionId: r.connectionId, digest: r.digest, workspaceIdentity: r.workspaceIdentity } : undefined;
}
export type AttachmentRef = {
  remoteOwner?: RemoteAttachmentOwner;
  id: string;
  name: string;
  mimeType: string;
  size: number;
  origin: AttachmentOrigin;
  /** Server token. Equal to id once begin/commit has accepted the reference. */
  token?: string;
  /** Workspace-relative path. Present only for workspace references. */
  path?: string;
  source?: "upload" | "workspace";
};

export type ComposerAttachment = {
  name: string;
  mimeType: string;
  data: string;
  ref?: AttachmentRef;
};

const ORIGINS = new Set<AttachmentOrigin>(["file", "paste", "drop", "workspace"]);
const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
};
const TEXT_TYPES: Record<string, string> = {
  ".txt": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown",
  ".csv": "text/csv", ".json": "application/json", ".xml": "application/xml",
  ".js": "application/javascript", ".mjs": "application/javascript",
};
export const COMPOSER_REF_LIMITS = {
  count: 8, nonImageCount: 4, imageBytes: 20 * 1024 * 1024,
  mediaBytes: 2 * 1024 * 1024, textBytes: 65536,
  totalBytes: 64 * 1024 * 1024, nonImageMediaBytes: 4 * 1024 * 1024,
};
export function isDurableImageMime(mime: string): boolean {
  return ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime);
}

const SERVER_ID = /^[0-9a-f]{32}$/;

export function attachmentBaseName(name: string): string {
  const base = name.split(/[/\\]/u).filter(Boolean).pop() ?? "attachment";
  return base.slice(0, 255);
}

export function attachmentExtension(name: string): string {
  const base = attachmentBaseName(name).toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot) : "";
}

/** Mime the sessions attachment store will accept, or null when it will not. */
export function attachmentMime(name: string, type: string): string | null {
  const ext = attachmentExtension(name);
  const declared = type.trim().toLowerCase();
  if (MEDIA_TYPES[ext]) return declared === "" || declared === MEDIA_TYPES[ext] ? MEDIA_TYPES[ext] : null;
  if (TEXT_TYPES[ext]) {
    if (declared === "" || declared === TEXT_TYPES[ext] || declared === "text/plain") return TEXT_TYPES[ext];
    return null;
  }
  if (declared.startsWith("text/") || declared === "application/json" || declared === "application/xml"
      || declared === "application/javascript") return declared;
  return null;
}

/** Relative workspace path that cannot climb out of the root. */
export function isBoundedWorkspacePath(path: string): boolean {
  if (!path || path.length > 1024 || path.includes("\\") || path.includes("\0")) return false;
  if (path.startsWith("/") || path.startsWith("\\")) return false;
  if (/^[A-Za-z]:/u.test(path)) return false;
  return path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

export function attachmentRefFromLocalFile(
  file: { name: string; type?: string; size: number },
  origin: Exclude<AttachmentOrigin, "workspace">,
  id = "local",
): AttachmentRef {
  return {
    id,
    name: attachmentBaseName(file.name),
    mimeType: attachmentMime(file.name, file.type ?? "") ?? (file.type || "application/octet-stream"),
    size: file.size,
    origin,
    source: "upload",
  };
}

export function isPersistedAttachmentRef(value: unknown): value is AttachmentRef {
  return parseAttachmentRef(value) !== null;
}

export function parseAttachmentRef(value: unknown): AttachmentRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if ("data" in value) return null;
  const record = value as AttachmentRef;
  if (typeof record.id !== "string" || !SERVER_ID.test(record.id)) return null;
  if (record.token !== record.id) return null;
  if (!ORIGINS.has(record.origin)) return null;
  if (typeof record.name !== "string" || !record.name || record.name.length > 255
      || record.name.includes("/") || record.name.includes("\\")) return null;
  if (typeof record.mimeType !== "string" || !record.mimeType || record.mimeType.length > 127) return null;
  if (typeof record.size !== "number" || !Number.isInteger(record.size) || record.size < 0
      || record.size > (isDurableImageMime(record.mimeType) ? COMPOSER_REF_LIMITS.imageBytes : COMPOSER_REF_LIMITS.mediaBytes)) return null;
  if (record.remoteOwner !== undefined) {
    const r = record.remoteOwner;
    if (!parseRemoteAttachmentEndpoint(r) || typeof r.root !== "string" || typeof r.draftKey !== "string" || !r.draftKey ||
        (r.sessionId !== undefined && typeof r.sessionId !== "string") || record.origin === "workspace") return null;
  }
  if (record.origin === "workspace") {
    if (typeof record.path !== "string" || !isBoundedWorkspacePath(record.path)) return null;
    return publicRef(record);
  }
  if (record.path) return null;
  return publicRef(record);
}

function publicRef(record: AttachmentRef): AttachmentRef {
  return {
    ...(record.remoteOwner ? { remoteOwner: { ...parseRemoteAttachmentEndpoint(record.remoteOwner)!, root: record.remoteOwner.root, draftKey: record.remoteOwner.draftKey, ...(record.remoteOwner.sessionId ? { sessionId: record.remoteOwner.sessionId } : {}) } } : {}),
    id: record.id,
    name: record.name,
    mimeType: record.mimeType,
    size: record.size,
    origin: record.origin,
    token: record.id,
    source: record.origin === "workspace" ? "workspace" : "upload",
    ...(record.origin === "workspace" && record.path ? { path: record.path } : {}),
  };
}

export function editorAttachmentRefs(attachments: readonly ComposerAttachment[]): AttachmentRef[] {
  const refs: AttachmentRef[] = [];
  for (const item of attachments) {
    const ref = parseAttachmentRef(item.ref);
    if (!ref) continue;
    refs.push(ref);
    if (refs.length >= COMPOSER_REF_LIMITS.count) break;
  }
  return refs;
}

export function attachmentsFromRefs(refs: readonly AttachmentRef[]): ComposerAttachment[] {
  return refs.slice(0, COMPOSER_REF_LIMITS.count).map(ref => ({ name: ref.name, mimeType: ref.mimeType, data: "", ref }));
}

/** Fields safe to put in browser storage: references only, never attachment bytes. */
export function persistedAttachmentFields(
  attachments: readonly ComposerAttachment[] | undefined,
  hadAttachments?: boolean,
): { attachmentRefs?: AttachmentRef[]; hadAttachments?: true } {
  const refs = editorAttachmentRefs(attachments ?? []);
  const inlineOnly = (attachments ?? []).some(item => !parseAttachmentRef(item.ref) && Boolean(item.data || item.name));
  const fields: { attachmentRefs?: AttachmentRef[]; hadAttachments?: true } = {};
  if (refs.length) fields.attachmentRefs = refs;
  if (inlineOnly || (hadAttachments === true && refs.length === 0)) fields.hadAttachments = true;
  return fields;
}

export function parseStoredAttachmentRefs(value: unknown): AttachmentRef[] {
  if (!Array.isArray(value)) return [];
  const refs: AttachmentRef[] = [];
  for (const item of value) {
    const ref = parseAttachmentRef(item);
    if (!ref) continue;
    refs.push(ref);
    if (refs.length >= COMPOSER_REF_LIMITS.count) break;
  }
  return refs;
}

export function attachmentPayloadForSend(
  attachments: readonly ComposerAttachment[],
  richComposer: boolean,
): { attachments: { name: string; mimeType: string; data: string }[]; attachmentRefs?: { id: string; remoteOwner?: RemoteAttachmentOwner }[] } {
  if (!richComposer) {
    return { attachments: attachments.map(item => ({ name: item.name, mimeType: item.mimeType, data: item.data })) };
  }
  const attachmentRefs: { id: string; remoteOwner?: RemoteAttachmentOwner }[] = [];
  const inline: { name: string; mimeType: string; data: string }[] = [];
  for (const item of attachments) {
    const ref = parseAttachmentRef(item.ref);
    if (ref) attachmentRefs.push({ id: ref.id, ...(ref.remoteOwner ? { remoteOwner: ref.remoteOwner } : {}) });
    else if (item.data) inline.push({ name: item.name, mimeType: item.mimeType, data: item.data });
  }
  return attachmentRefs.length ? { attachments: inline, attachmentRefs } : { attachments: inline };
}

type AttachmentResponse = { ref?: unknown; status?: unknown };

function sessionBody(sessionId?: string): { session_id?: string } {
  return sessionId ? { session_id: sessionId } : {};
}

export async function commitUploadedAttachment(input: {
  root: string;
  sessionId?: string;
  name: string;
  mimeType: string;
  size: number;
  origin: Exclude<AttachmentOrigin, "workspace">;
  data: string;
}): Promise<AttachmentRef> {
  const begun = await post<AttachmentResponse>("/api/composer/attachments/begin", {
    root: input.root,
    ...sessionBody(input.sessionId),
    name: input.name,
    mimeType: input.mimeType,
    size: input.size,
    origin: input.origin,
  });
  const pending = parseAttachmentRef(begun.ref);
  if (!pending) throw new Error("invalid attachment");
  try {
    const committed = await post<AttachmentResponse>("/api/composer/attachments/commit", {
      root: input.root,
      ...sessionBody(input.sessionId),
      id: pending.id,
      data: input.data,
    });
    const ref = parseAttachmentRef(committed.ref);
    if (!ref || committed.status !== "committed") throw new Error("invalid attachment");
    return ref;
  } catch (error) {
    await releaseComposerAttachment({ root: input.root, sessionId: input.sessionId, id: pending.id }).catch(() => undefined);
    throw error;
  }
}

export async function commitWorkspaceAttachment(input: {
  root: string;
  sessionId?: string;
  path: string;
}): Promise<AttachmentRef> {
  if (!isBoundedWorkspacePath(input.path)) throw new Error("workspace file unavailable");
  const name = attachmentBaseName(input.path);
  const begun = await post<AttachmentResponse>("/api/composer/attachments/begin", {
    root: input.root,
    ...sessionBody(input.sessionId),
    name,
    origin: "workspace",
    path: input.path,
  });
  const pending = parseAttachmentRef(begun.ref);
  if (!pending) throw new Error("invalid attachment");
  try {
    const committed = await post<AttachmentResponse>("/api/composer/attachments/commit", {
      root: input.root,
      ...sessionBody(input.sessionId),
      id: pending.id,
    });
    const ref = parseAttachmentRef(committed.ref);
    if (!ref || committed.status !== "committed") throw new Error("invalid attachment");
    return ref;
  } catch (error) {
    await releaseComposerAttachment({ root: input.root, sessionId: input.sessionId, id: pending.id }).catch(() => undefined);
    throw error;
  }
}

export async function releaseComposerAttachment(input: { root: string; sessionId?: string; id: string }): Promise<void> {
  await post("/api/composer/attachments/release", {
    root: input.root,
    ...sessionBody(input.sessionId),
    id: input.id,
  });
}
