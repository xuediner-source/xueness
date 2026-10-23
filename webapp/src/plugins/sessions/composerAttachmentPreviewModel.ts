import { getLocale } from "../../i18n";
import { type AttachmentRef, parseAttachmentRef } from "./composerAttachmentRef";

// English copy lives with the lazy preview graph, not the startup catalog.
const PREVIEW_EN: Record<string, string> = {
  "预览附件：{0}": "Preview attachment: {0}",
  "关闭预览": "Close preview",
  "大图片预览暂不可用；附件仍可发送。": "Large image preview is unavailable; the attachment is still ready to send.",
  "无法预览此附件": "This attachment cannot be previewed.",
  "正在加载预览...": "Loading preview…",
  "附件预览": "Attachment preview",
  "只显示附件开头的一段文本。": "Only the start of the attachment text is shown.",
  "此文件没有内嵌预览。": "This file has no inline preview.",
  "{0} · {1} 字节": "{0} · {1} bytes",
};

export function previewText(text: string, values?: readonly unknown[]): string {
  const translated = getLocale() === "en" ? (PREVIEW_EN[text] ?? text) : text;
  if (!values) return translated;
  return translated.replace(/\{(\d+)\}/g, (_, index) => String(values[Number(index)] ?? ""));
}

/** In-memory preview of one committed attachment. Bytes are not persisted. */
export type AttachmentPreviewTransport = (ref: AttachmentRef, signal?: AbortSignal, chunkIndex?: number) => Promise<unknown>;

export type AttachmentPreviewKind = "image" | "video" | "pdf" | "text" | "file";

export type AttachmentPreview = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: AttachmentPreviewKind;
  truncated: boolean;
  data?: string;
  /** Only created locally after an authorized bounded chunk transfer. Never persisted. */
  blob?: Blob;
  text?: string;
};

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const VIDEO_MIMES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
const TEXT_MIMES = new Set([
  "text/plain", "text/markdown", "text/csv", "application/json",
  "application/xml", "application/javascript",
]);

export function attachmentPreviewKind(mime: string): AttachmentPreviewKind {
  if (IMAGE_MIMES.has(mime)) return "image";
  if (VIDEO_MIMES.has(mime)) return "video";
  if (mime === "application/pdf") return "pdf";
  if (TEXT_MIMES.has(mime) || mime.startsWith("text/")) return "text";
  return "file";
}

export function canRequestAttachmentPreview(
  enabled: boolean,
  root: string | undefined,
  attachment: { ref?: unknown },
  hasRemoteTransport = false,
): boolean {
  return Boolean(enabled && root && parseAttachmentRef(attachment.ref) && (!parseAttachmentRef(attachment.ref)?.remoteOwner || hasRemoteTransport));
}

/** Images above the negotiated upload cap cannot be previewed. */
export function largeImagePreviewUnavailable(mimeType: string, size: number): boolean {
  return attachmentPreviewKind(mimeType) === "image" && size > 20 * 1024 * 1024;
}
