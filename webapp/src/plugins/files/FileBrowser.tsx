import React from "react";
import { t as tr, tf } from "../../i18n";
import { CodeContent } from "../../ui/CodeContent";
import type { FilePreview } from "../../xuenessWorkbench";
import { SimpleMarkdown } from "../../XuenessShell";
import { OfficeDocumentRenderer } from "../office/OfficeDocumentRenderer";
import "../../styles/office.css";

/** Markdown files render as prose instead of a raw code block. */
function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
// -- file browser ------------------------------------------------------------

export type FileBrowserProps = {
  files: { path: string; size: number }[];
  truncated?: boolean;
  selectedPath?: string | null;
  /** `image`/`embed` are data URLs served by the backend for whitelisted binary types. */
  preview?: Omit<FilePreview, "size"> | null;
  previewError?: string;
  officePreviewEnabled?: boolean;
  onSelect?: (path: string) => void;
};

export function FileBrowser({
  files,
  truncated = false,
  selectedPath,
  preview,
  previewError,
  officePreviewEnabled = true,
  onSelect,
}: FileBrowserProps) {
  return (
    <div data-testid="file-browser" className="xn-file-browser">
      <div className="xn-file-sidebar">
        <div style={{ padding: "10px 14px", fontWeight: 600, fontSize: 13, borderBottom: "1px solid var(--border)", color: "var(--fg)" }}>{tr("工作区文件")}</div>
        {!files || files.length === 0 ? (
          <div data-testid="file-browser-empty" style={{ padding: "12px 14px", fontSize: 12, color: "var(--fg-muted)" }}>{tr("暂无文件")}</div>
        ) : (
          <ul aria-label={tr("工作区文件")} style={{ listStyle: "none", margin: 0, padding: "6px" }}>
            {files.map((file) => {
              const isSelected = file.path === selectedPath;
              return (
                <li key={file.path} style={{ marginBottom: 2 }}>
                  <button
                    type="button"
                    data-testid={`file-item-${file.path}`}
                    aria-current={isSelected ? "true" : undefined}
                    onClick={onSelect ? () => onSelect(file.path) : undefined}
                    className="xn-file-item"
                  >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {file.path}
                    </span>
                    <span style={{ opacity: 0.6, flexShrink: 0, fontFamily: "var(--font-mono)" }}>
                      {formatSize(file.size)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {truncated && (
          <div data-testid="file-browser-truncated" style={{ padding: "8px 12px", fontSize: 11, color: "var(--warn-fg)", background: "var(--warn-bg)", borderTop: "1px solid var(--warn-border)" }}>{tr("文件过多，仅显示前一部分")}</div>
        )}
      </div>

      <div className="xn-file-main">
        {previewError ? (
          <p role="alert" data-testid="file-preview-error" style={{ margin: 0, color: "var(--error-fg)", background: "var(--error-bg)", border: "1px solid var(--error-border)", borderRadius: "var(--radius-md)", padding: "10px 14px", fontSize: 12 }}>{tr("预览失败：")}{previewError}
          </p>
        ) : preview ? (
          <div data-testid="file-preview">
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: "var(--fg)" }}>
              {preview.path}
              {preview.truncated ? tr("（已截断）") : ""}
            </div>
            {preview.image ? (
              <img
                src={preview.image}
                alt={tf("预览 {0}", [preview.path])}
                data-testid="file-preview-image"
                style={{ maxWidth: "100%", maxHeight: 480, border: "1px solid var(--border)", borderRadius: "var(--radius-md)", background: "var(--bg-subtle)" }}
              />
            ) : preview.embed && preview.embed.mime === "application/pdf" ? (
              <embed
                src={preview.embed.dataUrl}
                type="application/pdf"
                data-testid="file-preview-embed"
                style={{ width: "100%", height: 560, border: "1px solid var(--border)", borderRadius: "var(--radius-md)", background: "var(--bg-subtle)" }}
              />
            ) : preview.embed && preview.embed.mime.startsWith("audio/") ? (
              <audio
                controls
                src={preview.embed.dataUrl}
                data-testid="file-preview-audio"
                style={{ width: "100%" }}
              />
            ) : preview.embed && preview.embed.mime.startsWith("video/") ? (
              <video
                controls
                src={preview.embed.dataUrl}
                data-testid="file-preview-video"
                style={{ maxWidth: "100%", maxHeight: 480, border: "1px solid var(--border)", borderRadius: "var(--radius-md)", background: "var(--bg-subtle)" }}
              />
            ) : preview.office && officePreviewEnabled ? (
              <OfficeDocumentRenderer office={preview.office} />
            ) : preview.office ? (
              <p className="xn-file-preview-disabled">{tr("Office 预览插件已停用。")}</p>
            ) : isMarkdownPath(preview.path) ? (
              <div data-testid="file-preview-markdown">
                <SimpleMarkdown text={preview.text} />
              </div>
            ) : (
              <CodeContent text={preview.text} path={preview.path} />
            )}
          </div>
        ) : (
          <div data-testid="file-preview-empty" style={{ fontSize: 12, color: "var(--fg-muted)" }}>{tr("选择一个文件查看内容")}</div>
        )}
      </div>
    </div>
  );
}
