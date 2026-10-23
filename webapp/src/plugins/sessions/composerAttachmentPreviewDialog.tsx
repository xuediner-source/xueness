import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { post } from "../../xuenessApi";
import { IconX } from "../../ui/icons";
import { shouldDismissModalOnEscape, useModalFocusScope } from "../shared";
import {
  attachmentPreviewKind, largeImagePreviewUnavailable, previewText, type AttachmentPreview, type AttachmentPreviewKind, type AttachmentPreviewTransport,
} from "./composerAttachmentPreviewModel";

import { collectImagePreview, isImagePreviewFragment, withPreviewDeadline } from "./composerImagePreviewTransfer";

import type { AttachmentRef } from "./composerAttachmentRef";

const SERVER_ID = /^[0-9a-f]{32}$/;
const TEXT_PREVIEW_CHARS = 2000;
const MAX_TEXT_BYTES = 65536;
const MAX_MEDIA_BYTES = 2 * 1024 * 1024;
const MAX_DATA_CHARS = 4 * Math.floor((MAX_MEDIA_BYTES + 2) / 3);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const KINDS = new Set<AttachmentPreviewKind>(["image", "video", "pdf", "text", "file"]);
const PREVIEW_KEYS = new Set(["id", "name", "mimeType", "size", "kind", "truncated", "data", "text"]);

function validPreviewName(name: string): boolean {
  if (!name || name.length > 255 || name.includes("/") || name.includes("\\") || name === "." || name === "..") return false;
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function mediaByteLength(data: string): number | null {
  if (!BASE64.test(data) || data.length === 0 || data.length % 4 !== 0 || data.length > MAX_DATA_CHARS) return null;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  if (padding === 2 && data.length < 8) return null;
  return (data.length / 4) * 3 - padding;
}

/** Accept only the bounded preview shape. External URLs and extra fields are dropped. */
export function parseAttachmentPreview(value: unknown): AttachmentPreview | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !PREVIEW_KEYS.has(key))) return null;
  if (typeof record.id !== "string" || !SERVER_ID.test(record.id)) return null;
  if (typeof record.name !== "string" || !validPreviewName(record.name)) return null;
  if (typeof record.mimeType !== "string" || !record.mimeType || record.mimeType.length > 127) return null;
  if (typeof record.size !== "number" || !Number.isInteger(record.size) || record.size < 0) return null;
  if (typeof record.truncated !== "boolean") return null;
  if (typeof record.kind !== "string" || !KINDS.has(record.kind as AttachmentPreviewKind)) return null;
  const kind = record.kind as AttachmentPreviewKind;
  if (kind !== attachmentPreviewKind(record.mimeType)) return null;
  const data = record.data;
  const text = record.text;
  if (kind === "image" || kind === "video" || kind === "pdf") {
    if (record.truncated || typeof data !== "string" || text !== undefined) return null;
    const bytes = mediaByteLength(data);
    if (bytes === null || bytes !== record.size || bytes > MAX_MEDIA_BYTES) return null;
    return { id: record.id, name: record.name, mimeType: record.mimeType, size: record.size, kind, truncated: false, data };
  }
  if (kind === "text") {
    if (typeof text !== "string" || data !== undefined || text.length > TEXT_PREVIEW_CHARS || text.includes("\0")) return null;
    if (record.size > MAX_TEXT_BYTES) return null;
    const excerptBytes = new TextEncoder().encode(text).length;
    if (record.truncated) {
      if (text.length !== TEXT_PREVIEW_CHARS || record.size <= excerptBytes) return null;
    } else if (excerptBytes !== record.size) return null;
    return {
      id: record.id, name: record.name, mimeType: record.mimeType, size: record.size, kind,
      truncated: record.truncated, text,
    };
  }
  if (data !== undefined || text !== undefined || record.truncated || record.size > MAX_MEDIA_BYTES) return null;
  return { id: record.id, name: record.name, mimeType: record.mimeType, size: record.size, kind, truncated: false };
}

type PreviewInput = {
  enabled: boolean;
  root: string;
  sessionId?: string;
  id: string;
  mimeType?: string;
  size?: number;
  attachmentRef?: AttachmentRef;
  previewTransport?: AttachmentPreviewTransport;
};

export async function loadAttachmentPreview(input: PreviewInput, signal?: AbortSignal): Promise<AttachmentPreview> {
  return withPreviewDeadline(inner => loadPreview(input, inner), signal);
}

async function loadPreview(input: PreviewInput, signal: AbortSignal): Promise<AttachmentPreview> {
  if (!input.enabled || !input.root || !SERVER_ID.test(input.id)) throw new Error("invalid attachment");
  if (largeImagePreviewUnavailable(input.mimeType ?? "", input.size ?? 0)) throw new Error(previewText("大图片预览暂不可用；附件仍可发送。"));
  const read = async (chunkIndex?: number, nextSignal?: AbortSignal): Promise<{ preview?: unknown }> => {
    const value = input.previewTransport && input.attachmentRef
      ? await input.previewTransport(input.attachmentRef, nextSignal, chunkIndex)
      : await post<unknown>("/api/composer/attachments/preview", {
        root: input.root, ...(input.sessionId ? { session_id: input.sessionId } : {}), id: input.id,
        ...(chunkIndex !== undefined ? { chunkIndex } : {}),
      }, nextSignal);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid attachment");
    return value as { preview?: unknown };
  };
  // A remote identity must never accidentally reach the local HTTP route.
  if (input.attachmentRef?.remoteOwner && !input.previewTransport) throw new Error("remote preview unavailable");
  const body = await withPreviewDeadline(inner => read(undefined, inner), signal, 15_000);
  if (isImagePreviewFragment(body.preview)) {
    if ((body.preview as { id?: unknown }).id !== input.id) throw new Error("invalid attachment");
    return collectImagePreview(body.preview, async (chunkIndex, nextSignal) => (await read(chunkIndex, nextSignal)).preview, signal);
  }
  const preview = parseAttachmentPreview(body.preview);
  if (!preview || preview.id !== input.id) throw new Error("invalid attachment");
  return preview;
}

export function AttachmentPreviewBody({ preview }: { preview: AttachmentPreview }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!preview.blob || preview.kind !== "image") { setBlobUrl(null); return; }
    const url = URL.createObjectURL(preview.blob);
    setBlobUrl(url);
    return () => { URL.revokeObjectURL(url); };
  }, [preview]);
  if (preview.kind === "image" && preview.blob) {
    return blobUrl ? <img className="xn-composer-preview__media" alt={preview.name} src={blobUrl} data-testid="composer-attachment-preview-image" /> : null;
  }
  if (preview.kind === "text" && preview.text !== undefined) {
    return <pre className="xn-composer-preview__text" data-testid="composer-attachment-preview-text">{preview.text}</pre>;
  }
  if ((preview.kind === "image" || preview.kind === "video" || preview.kind === "pdf") && preview.data) {
    const url = `data:${preview.mimeType};base64,${preview.data}`;
    if (preview.kind === "image") {
      return <img className="xn-composer-preview__media" alt={preview.name} src={url} data-testid="composer-attachment-preview-image" />;
    }
    if (preview.kind === "video") {
      return <video className="xn-composer-preview__media" controls preload="none" src={url} data-testid="composer-attachment-preview-video" />;
    }
    return (
      <object className="xn-composer-preview__frame" type={preview.mimeType} data={url} aria-label={preview.name} data-testid="composer-attachment-preview-pdf">
        {preview.name}
      </object>
    );
  }
  return (
    <p className="xn-composer-preview__file" data-testid="composer-attachment-preview-file">
      <span>{preview.name}</span>
      <span>{previewText("{0} · {1} 字节", [preview.mimeType, preview.size])}</span>
      <span>{previewText("此文件没有内嵌预览。")}</span>
    </p>
  );
}

/** Loaded only after the user opens a committed attachment. Bytes stay in this dialog. */
export function AttachmentPreviewDialog({
  name,
  mimeType = "",
  size = 0,
  root,
  sessionId,
  id,
  onClose,
  returnFocusTo,
  attachmentRef,
  previewTransport,
}: {
  name: string;
  mimeType?: string;
  size?: number;
  attachmentRef?: AttachmentRef;
  previewTransport?: AttachmentPreviewTransport;
  root: string;
  sessionId?: string;
  id: string;
  onClose: () => void;
  returnFocusTo?: HTMLElement | null;
}) {
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<AttachmentPreview | null>(null);
  const unavailable = largeImagePreviewUnavailable(mimeType, size);
  const [error, setError] = useState(unavailable ? previewText("大图片预览暂不可用；附件仍可发送。") : "");
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useModalFocusScope({ open: true, dialogRef, initialFocusRef: closeRef, returnFocusTo });

  useEffect(() => {
    if (unavailable) {
      setLoading(false); setPreview(null);
      setError(previewText("大图片预览暂不可用；附件仍可发送。"));
      return;
    }
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setPreview(null);
    setError("");
    loadAttachmentPreview({
      enabled: true, root, sessionId, id, mimeType, size, attachmentRef, previewTransport,
    }, controller.signal).then(next => {
      if (active) setPreview(next);
    }).catch(() => {
      if (active && !controller.signal.aborted) setError(previewText("无法预览此附件"));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [root, sessionId, id, mimeType, size, unavailable, attachmentRef, previewTransport]);

  const state = error ? "error" : loading || !preview ? "loading" : "ready";
  const dialog = (
    <div
      className="xn-composer-preview"
      onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={previewText("附件预览")}
        tabIndex={-1}
        className="xn-composer-preview__panel"
        data-testid="composer-attachment-preview-dialog"
        data-preview-state={state}
        onKeyDown={event => {
          if (!shouldDismissModalOnEscape(event)) return;
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }}
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="xn-composer-preview__header">
          <h2>{name}</h2>
          <button ref={closeRef} type="button" aria-label={previewText("关闭预览")} onClick={onClose}><IconX size={14} /></button>
        </header>
        {error ? <p className="xn-composer-preview__status" role="alert">{error}</p> : null}
        {loading && !error ? <p className="xn-composer-preview__status" role="status">{previewText("正在加载预览...")}</p> : null}
        {preview ? (
          <>
            <AttachmentPreviewBody preview={preview} />
            {preview.truncated ? <p className="xn-composer-preview__status">{previewText("只显示附件开头的一段文本。")}</p> : null}
          </>
        ) : null}
      </div>
    </div>
  );
  return typeof document !== "undefined" ? createPortal(dialog, document.body) : dialog;
}
