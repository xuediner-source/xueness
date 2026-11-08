/**
 * Files plugin wiring for the workbench: the active session's file candidates
 * and preview, the journal-derived changes view, and the host-side directory
 * browser. Each request is scoped to the session that started it and is
 * dropped (or aborted) when the session changes. Moved unchanged out of
 * XuenessWorkbenchContainer.
 */
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { deriveFileChanges, loadFilePreview, loadFiles, loadJournal, type FileChangeSet, type FilePreview } from "../../xuenessWorkbench";
import { createFolder, loadDirectory, loadHome, type XuenessDirectoryListing } from "../../xuenessWorkspace";
import { createCleanSessionTransientState, shouldIgnoreSessionResponse } from "../sessions/workbenchSessionState";

type WorkbenchFilesInput = {
  activeId: string | null;
  activeIdRef: React.MutableRefObject<string | null>;
  panel: string;
  isPluginEffective: (id: string) => boolean;
  pluginEffectiveRef: React.MutableRefObject<(id: string) => boolean>;
};

export function useWorkbenchFiles({ activeId, activeIdRef, panel, isPluginEffective, pluginEffectiveRef }: WorkbenchFilesInput) {
  const mountedRef = useRef(true);
  const filesAbortRef = useRef<AbortController | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);
  const selectedPathRef = useRef<string | null>(null);
  const changesAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      filesAbortRef.current?.abort();
      previewAbortRef.current?.abort();
      changesAbortRef.current?.abort();
    };
  }, []);

  // Files panel
  const [files, setFiles] = useState<{ path: string; size: number }[]>([]);
  const [filesTruncated, setFilesTruncated] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  selectedPathRef.current = selectedPath;
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewError, setPreviewError] = useState("");

  // Changes panel (journal-derived, not a disk diff)
  const [changeSet, setChangeSet] = useState<FileChangeSet | null>(null);
  const [changesError, setChangesError] = useState("");

  // Directory panel (host-side browse; the browser shell has no native folder dialog)
  const [dirListing, setDirListing] = useState<XuenessDirectoryListing | null>(null);
  const [dirError, setDirError] = useState("");
  const [dirLoading, setDirLoading] = useState(false);

  // A session switch drops every in-flight file request and the previous session's file state.
  useEffect(() => {
    filesAbortRef.current?.abort();
    filesAbortRef.current = null;
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    changesAbortRef.current?.abort();
    changesAbortRef.current = null;

    const clean = createCleanSessionTransientState();
    setFiles(clean.files);
    setFilesTruncated(clean.filesTruncated);
    setSelectedPath(clean.selectedPath);
    setPreview(clean.preview);
    setPreviewError(clean.previewError);
    setChangeSet(clean.changeSet);
    setChangesError(clean.changesError);
  }, [activeId]);

  /** File candidates for the composer and file views, refreshed with the active conversation. */
  const loadFileCandidates = useCallback(async (id: string) => {
    // File candidates keep their own cancellation scope: a conversation
    // delta must not repeatedly abort a file listing started by an action.
    filesAbortRef.current?.abort();
    const controller = new AbortController();
    filesAbortRef.current = controller;
    const listing = await loadFiles(id, controller.signal);
    if (shouldIgnoreSessionResponse(id, activeIdRef.current, mountedRef.current, controller.signal)
        || !pluginEffectiveRef.current('sessions') || !pluginEffectiveRef.current('files')) return;
    if (listing.ok) {
      setFiles(listing.value.files);
      setFilesTruncated(listing.value.truncated);
    }
  }, []);

  // -- files panel ---------------------------------------------------------
  const handleLoadFiles = useCallback(async () => {
    const currentId = activeId;
    if (!currentId || !isPluginEffective("files")) return;
    filesAbortRef.current?.abort();
    const controller = new AbortController();
    filesAbortRef.current = controller;
    const res = await loadFiles(currentId, controller.signal);
    if (shouldIgnoreSessionResponse(currentId, activeIdRef.current, mountedRef.current, controller.signal) || !isPluginEffective("files")) return;
    if (res.ok) {
      setFiles(res.value.files);
      setFilesTruncated(res.value.truncated);
    } else {
      setPreviewError(res.error);
    }
  }, [activeId, isPluginEffective]);

  const handleSelectFile = useCallback(
    async (path: string) => {
      const currentId = activeId;
      if (!currentId || !isPluginEffective("files")) return;
      selectedPathRef.current = path;
      setSelectedPath(path);
      setPreview(null);
      setPreviewError("");
      previewAbortRef.current?.abort();
      const controller = new AbortController();
      previewAbortRef.current = controller;
      const res = await loadFilePreview(currentId, path, controller.signal);
      if (shouldIgnoreSessionResponse(currentId, activeIdRef.current, mountedRef.current, controller.signal) || selectedPathRef.current !== path) return;
      if (res.ok)
        setPreview({
          ...res.value,
        });
      else setPreviewError(res.error);
    },
    [activeId, isPluginEffective],
  );

  // -- changes panel -------------------------------------------------------
  const handleLoadChanges = useCallback(async () => {
    const currentId = activeId;
    if (!currentId || !isPluginEffective("files")) return;
    setChangesError("");
    changesAbortRef.current?.abort();
    const controller = new AbortController();
    changesAbortRef.current = controller;
    const res = await loadJournal(currentId, controller.signal);
    if (shouldIgnoreSessionResponse(currentId, activeIdRef.current, mountedRef.current, controller.signal) || !isPluginEffective("files")) return;
    if (res.ok) setChangeSet(deriveFileChanges(res.value));
    else {
      setChangeSet(null);
      setChangesError(res.error);
    }
  }, [activeId, isPluginEffective]);

  // Load panel data when the panel opens, so each view has a real round trip.
  useEffect(() => {
    if (panel === "files" && isPluginEffective("files")) void handleLoadFiles();
    else if (panel === "changes" && isPluginEffective("files")) void handleLoadChanges();
  }, [panel, activeId, isPluginEffective, handleLoadFiles, handleLoadChanges]);

  // -- directory panel -----------------------------------------------------
  // The browser shell has no native folder dialog, so browsing goes through the
  // host-side directory API. Errors are shown, never swallowed into an empty tree.
  const browseDirectory = useCallback(async (path: string) => {
    if (!isPluginEffective("files")) return;
    setDirLoading(true);
    setDirError("");
    try {
      const res = await loadDirectory(path);
      if (!mountedRef.current) return;
      if (res.ok) setDirListing(res.value);
      else setDirError(res.error);
    } finally {
      if (mountedRef.current) setDirLoading(false);
    }
  }, [isPluginEffective]);

  useEffect(() => {
    if (panel !== "directory" || !isPluginEffective("files") || dirListing) return;
    setDirLoading(true);
    void (async () => {
      const home = await loadHome();
      if (!mountedRef.current) return;
      setDirLoading(false);
      if (home.ok) await browseDirectory(home.value);
      else setDirError(home.error);
    })();
  }, [panel, dirListing, isPluginEffective, browseDirectory]);

  const handleCreateDir = useCallback(
    async (name: string) => {
      if (!dirListing || !isPluginEffective("files")) return;
      const res = await createFolder(dirListing.path, name);
      if (res.ok) await browseDirectory(dirListing.path);
      else setDirError(res.error);
    },
    [dirListing, isPluginEffective, browseDirectory],
  );

  return {
    files, filesTruncated, selectedPath, preview, previewError, changeSet, changesError,
    dirListing, dirError, dirLoading, loadFileCandidates, handleSelectFile, browseDirectory, handleCreateDir,
  };
}
