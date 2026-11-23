/** Forking: server-issued, revision-bound turn boundaries and the fork request. */
import { requestGet, requestPost, sessionPath, toErrorMessage } from './sessionHttp';
import type { ForkBoundary, ForkBoundaryList, ForkSessionResponse, Result } from './workbenchTypes';

/** Read opaque, revision-bound safe fork selectors from the server. */
export async function loadForkBoundaries(sourceId: string, signal?: AbortSignal, request = requestGet<unknown>): Promise<Result<ForkBoundaryList>> {
  try {
    const payload = await request(sessionPath(sourceId, "/fork-boundaries"), signal);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid fork boundaries response");
    const record = payload as Record<string, unknown>;
    if (record.sourceId !== sourceId || typeof record.revision !== "string" || !record.revision
      || typeof record.historyTruncated !== "boolean" || !Array.isArray(record.boundaries)
      || (record.truncationReason !== null && typeof record.truncationReason !== "string")
      || typeof record.hasUnclosedTurn !== "boolean") {
      throw new Error("invalid fork boundaries response");
    }
    const boundaries = record.boundaries.map((item): ForkBoundary => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid fork boundaries response");
      const boundary = item as Record<string, unknown>;
      if (typeof boundary.token !== "string" || !boundary.token || !Number.isInteger(boundary.turn) || (boundary.turn as number) < 1
        || !Number.isInteger(boundary.endIndex) || (boundary.endIndex as number) < 0 || typeof boundary.preview !== "string") {
        throw new Error("invalid fork boundaries response");
      }
      return { token: boundary.token, turn: boundary.turn as number, endIndex: boundary.endIndex as number, preview: boundary.preview };
    });
    return { ok: true, value: {
      sourceId: record.sourceId,
      revision: record.revision,
      boundaries,
      historyTruncated: record.historyTruncated,
      truncationReason: record.truncationReason as string | null,
      hasUnclosedTurn: record.hasUnclosedTurn,
    } };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}

/** Create a child session from one server-issued complete-turn boundary. */
export async function forkSession(
  sourceId: string,
  boundary: string,
  revision: string,
  title?: string,
  request: (path: string, body: unknown) => Promise<unknown> = requestPost<unknown>,
): Promise<Result<ForkSessionResponse>> {
  try {
    const cleanTitle = title?.trim();
    const payload = await request(sessionPath(sourceId, "/fork"), {
      boundary,
      revision,
      ...(cleanTitle ? { title: cleanTitle } : {}),
    });
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("invalid fork response");
    const record = payload as Record<string, unknown>;
    const session = record.session;
    const selectedBoundary = record.boundary;
    const sessionRecord = session && typeof session === "object" && !Array.isArray(session) ? session as Record<string, unknown> : null;
    const forkParent = sessionRecord?.forkParent;
    const parentIsValid = forkParent === undefined || forkParent === null || (
      typeof forkParent === "object" && !Array.isArray(forkParent)
      && typeof (forkParent as Record<string, unknown>).sourceId === "string"
      && typeof (forkParent as Record<string, unknown>).sourceRevision === "string"
      && Number.isInteger((forkParent as Record<string, unknown>).turn)
      && Number.isInteger((forkParent as Record<string, unknown>).endIndex)
      && typeof (forkParent as Record<string, unknown>).historyTruncated === "boolean"
      && ((forkParent as Record<string, unknown>).truncationReason === null || typeof (forkParent as Record<string, unknown>).truncationReason === "string")
    );
    if (!session || typeof session !== "object" || Array.isArray(session)
      || typeof (session as Record<string, unknown>).id !== "string"
      || !parentIsValid
      || record.sourceId !== sourceId || !selectedBoundary || typeof selectedBoundary !== "object" || Array.isArray(selectedBoundary)
      || !Number.isInteger((selectedBoundary as Record<string, unknown>).turn)
      || typeof (selectedBoundary as Record<string, unknown>).preview !== "string"
      || typeof record.historyTruncated !== "boolean"
      || (record.truncationReason !== null && typeof record.truncationReason !== "string")) {
      throw new Error("invalid fork response");
    }
    return { ok: true, value: record as unknown as ForkSessionResponse };
  } catch (error) {
    return { ok: false, error: toErrorMessage(error) };
  }
}
