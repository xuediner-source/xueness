import { t as tr, tf } from './i18n';
/**
 * Xueness workbench view, slice 2: file browser, change view, settings.
 *
 * Pure rendering only. Every piece of data arrives through props and every
 * action leaves through a callback — this file never fetches and never builds a
 * URL. That is what makes it testable with `renderToStaticMarkup` and what keeps
 * the data layer the single place that talks to the API.
 *
 * A note on the change view: the backend exposes no diff endpoint, so the only
 * honest thing we can show is what the *session recorded* the agent trying to
 * do. `DiffView` labels that explicitly and must keep doing so — presenting it
 * as a live working-tree diff would be a lie.
 */
import React from "react";
import { CodeContent } from "./ui/CodeContent";
import type { FileChange, FileChangeSet, FilePreview, OfficeBlock, OfficeImage, OfficePreview, OfficeRun } from "./xuenessWorkbench";
import type { SettingsMap, AgentCapabilities } from "./xuenessSettings";
import { Button, CodeBlock } from "./ui/primitives";
import { SimpleMarkdown } from "./XuenessShell";
import "./styles/office.css";

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

function officeImageSource(image: OfficeImage): string | null {
  const prefix = `data:${image.mime};base64,`;
  return image.dataUrl.startsWith(prefix) && image.dataUrl.length <= 360_000 ? image.dataUrl : null;
}

function runStyle(run: OfficeRun): React.CSSProperties {
  const style: React.CSSProperties = {};
  const color = run.style?.color;
  if (color && /^#[0-9a-f]{6}$/i.test(color)) style.color = color;
  const size = run.style?.fontSize;
  if (typeof size === "number" && Number.isFinite(size)) style.fontSize = `${Math.min(48, Math.max(6, size))}pt`;
  if (run.style?.bold) style.fontWeight = 700;
  if (run.style?.italic) style.fontStyle = "italic";
  const decorations = [run.style?.underline && "underline", run.style?.strike && "line-through"].filter(Boolean);
  if (decorations.length) style.textDecoration = decorations.join(" ");
  return style;
}

function safeOfficeBlockStyle(block: OfficeBlock): React.CSSProperties {
  const style: React.CSSProperties = {};
  if (["left", "center", "right", "justify"].includes(block.style?.align ?? "")) {
    style.textAlign = block.style?.align as React.CSSProperties["textAlign"];
  }
  if (block.style?.fill && /^#[0-9a-f]{6}$/i.test(block.style.fill)) style.backgroundColor = block.style.fill;
  return style;
}

function columnNumber(letters: string): number {
  return [...letters].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0);
}

function officeCellSpans(ranges: string[] | undefined) {
  const starts = new Map<string, { colSpan: number; rowSpan: number }>();
  const covered = new Set<string>();
  for (const range of ranges ?? []) {
    const match = /^([A-Z]{1,3})(\d+):([A-Z]{1,3})(\d+)$/i.exec(range);
    if (!match) continue;
    const col = columnNumber(match[1].toUpperCase()), row = Number(match[2]);
    const endCol = columnNumber(match[3].toUpperCase()), endRow = Number(match[4]);
    if (row < 1 || endRow < row || endRow - row > 200 || endCol < col || endCol - col > 49) continue;
    starts.set(`${row - 1}:${col - 1}`, { colSpan: endCol - col + 1, rowSpan: endRow - row + 1 });
    for (let r = row - 1; r < endRow; r++) for (let c = col - 1; c < endCol; c++) {
      if (r !== row - 1 || c !== col - 1) covered.add(`${r}:${c}`);
    }
  }
  return { starts, covered };
}

function RichOfficeText({ block }: { block: OfficeBlock }) {
  if (!block.runs?.length) return <>{block.text}</>;
  return <>{block.runs.map((run, index) => <span key={index} style={runStyle(run)}>{run.text}</span>)}</>;
}

function OfficeSpreadsheet({ block }: { block: OfficeBlock }) {
  const rows = block.table ?? [];
  const colCount = Math.max(0, ...rows.map((row) => row.length));
  const { starts, covered } = officeCellSpans(block.mergedRanges);
  const widthFor = (column: number) => {
    const meta = block.columns?.find((item) => column + 1 >= item.min && column + 1 <= item.max);
    return meta && !meta.hidden ? { width: `${Math.round(meta.width * 8)}px`, minWidth: `${Math.round(meta.width * 8)}px` } : undefined;
  };
  return (
    <div className="xn-office-sheet-scroll"><table className="xn-office-sheet">
      <colgroup>{Array.from({ length: colCount }, (_, column) => <col key={column} style={widthFor(column)} />)}</colgroup>
      <tbody>{rows.map((row, r) => <tr key={r}>{row.map((cell, c) => {
        if (covered.has(`${r}:${c}`)) return null;
        const span = starts.get(`${r}:${c}`);
        const raw = block.cellStyles?.[r]?.[c] as Record<string, unknown> | undefined;
        const cellStyle: React.CSSProperties = {};
        if (typeof raw?.color === "string" && /^#[0-9a-f]{6}$/i.test(raw.color)) cellStyle.color = raw.color;
        if (typeof raw?.background === "string" && /^#[0-9a-f]{6}$/i.test(raw.background)) cellStyle.backgroundColor = raw.background;
        if (typeof raw?.fontSize === "number" && Number.isFinite(raw.fontSize)) cellStyle.fontSize = `${Math.min(48, Math.max(6, raw.fontSize))}pt`;
        if (raw?.bold === true) cellStyle.fontWeight = 700;
        if (raw?.italic === true) cellStyle.fontStyle = "italic";
        if (["left", "center", "right", "justify"].includes(String(raw?.align ?? ""))) cellStyle.textAlign = raw?.align as React.CSSProperties["textAlign"];
        return <td key={c} rowSpan={span?.rowSpan} colSpan={span?.colSpan} style={cellStyle}>{cell}</td>;
      })}</tr>)}</tbody>
    </table></div>
  );
}

function OfficeDtoRenderer({ office }: { office: OfficePreview }) {
  const ppt = office.kind === "pptx";
  return <div className={`xn-office xn-office--${office.kind}`} data-testid={`file-preview-${office.kind}`}>
    <p>{tr("Office 富内容预览")}</p>
    {office.truncated && <p role="status">{tr("内容超过预览上限，已截断。")}</p>}
    {office.sections.map((section, sectionIndex) => {
      const layout = section.layout;
      const ratio = layout?.width && layout.height ? layout.width / layout.height : 16 / 9;
      return <section key={sectionIndex} className={ppt ? "xn-office-slide" : "xn-office-document"}>
        <h3>{section.name}</h3>
        <div className={ppt ? "xn-office-slide__canvas" : undefined} style={ppt ? { aspectRatio: String(Math.max(0.5, Math.min(3, ratio))) } : undefined}>
          {section.blocks.map((block, blockIndex) => {
            const images = (block.images ?? []).filter((image) => officeImageSource(image) !== null);
            const position = block.position;
            const positioned = ppt && layout?.width && layout.height && position?.width && position.height;
            const shapeStyle: React.CSSProperties = { ...safeOfficeBlockStyle(block) };
            if (positioned) {
              const maxWidth = layout.width!, maxHeight = layout.height!;
              const bounded = [position!.x ?? 0, position!.y ?? 0, position!.width!, position!.height!].every(Number.isFinite);
              if (bounded) Object.assign(shapeStyle, {
                position: "absolute",
                left: `${Math.max(0, Math.min(100, ((position!.x ?? 0) / maxWidth) * 100))}%`,
                top: `${Math.max(0, Math.min(100, ((position!.y ?? 0) / maxHeight) * 100))}%`,
                width: `${Math.max(1, Math.min(100, (position!.width! / maxWidth) * 100))}%`,
                height: `${Math.max(1, Math.min(100, (position!.height! / maxHeight) * 100))}%`,
              });
            }
            const content = block.table
              ? <OfficeSpreadsheet block={block} />
              : <RichOfficeText block={block} />;
            return <div key={blockIndex} className={ppt ? "xn-office-shape" : "xn-office-block"} style={shapeStyle}>
              {content}
              {images.map((image, imageIndex) => {
                const src = officeImageSource(image);
                return src ? <img key={imageIndex} src={src} alt={image.alt ?? ""} loading="lazy" /> : null;
              })}
            </div>;
          })}
        </div>
      </section>;
    })}
  </div>;
}

function officePackageBytes(encoded: string): Uint8Array {
  if (encoded.length > 11_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error("Office preview package is invalid or too large.");
  }
  const binary = atob(encoded);
  if (binary.length > 8_000_000) throw new Error("Office preview package exceeds the size limit.");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function FullOfficeRenderer({ office, onFailure }: { office: OfficePreview; onFailure: (message: string) => void }) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const styleRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    let cancelled = false;
    let viewer: { destroy: () => void } | undefined;
    const host = hostRef.current;
    if (!office.fullDocument || !host) return;
    void (async () => {
      try {
        const bytes = officePackageBytes(office.fullDocument!);
        if (office.kind === "docx") {
          const renderer = await import("docx-preview");
          if (cancelled || !host) return;
          await renderer.renderAsync(bytes, host, styleRef.current ?? host, {
            className: "xn-docx-safe-preview",
            inWrapper: true,
            ignoreFonts: true,
            useBase64URL: true,
            experimental: false,
            renderAltChunks: false,
            renderChanges: false,
            renderComments: false,
            debug: false,
          });
          if (cancelled) {
            host.replaceChildren();
            if (styleRef.current && styleRef.current !== host) styleRef.current.replaceChildren();
          }
        } else if (office.kind === "pptx") {
          const renderer = await import("@aiden0z/pptx-renderer");
          if (cancelled || !host) return;
          const opened = await renderer.PptxViewer.open(bytes, host, {
            width: 960,
            fitMode: "contain",
            pdfjs: false,
            lazySlides: true,
            lazyMedia: true,
            zipLimits: {
              maxEntries: 1200,
              maxEntryUncompressedBytes: 4_000_000,
              maxTotalUncompressedBytes: 32_000_000,
              maxMediaBytes: 1_000_000,
              maxConcurrency: 4,
            },
          });
          if (cancelled) {
            opened.destroy();
            host.replaceChildren();
            return;
          }
          viewer = opened;
        }
      } catch {
        if (!cancelled) onFailure("The full renderer could not read this file; showing the safe static preview instead.");
      }
    })();
    return () => {
      cancelled = true;
      viewer?.destroy();
      if (host) host.replaceChildren();
      if (styleRef.current && styleRef.current !== host) styleRef.current.replaceChildren();
    };
  }, [office.fullDocument, office.kind, onFailure]);
  return <div className="xn-office-full-renderer" data-testid={`file-preview-${office.kind}-full`}>
    {office.kind === "docx" && <div ref={styleRef} className="xn-office-full-renderer__styles" />}
    <div ref={hostRef} className="xn-office-full-renderer__host" />
  </div>;
}

function OfficeDocumentRenderer({ office }: { office: OfficePreview }) {
  const [failedPackage, setFailedPackage] = React.useState<string | null>(null);
  const fullRendererFailed = office.fullDocument !== undefined && failedPackage === office.fullDocument;
  const fail = React.useCallback(() => setFailedPackage(office.fullDocument ?? null), [office.fullDocument]);
  const canRenderFully = Boolean(office.fullDocument) && ["docx", "pptx"].includes(office.kind);
  if (canRenderFully && !fullRendererFailed) {
    return <div className="xn-office-render-mode">
      <p className="xn-office-render-mode__label">{tr("完整文档预览（本地安全渲染）")}</p>
      <FullOfficeRenderer office={office} onFailure={fail} />
    </div>;
  }
  return <>
    {fullRendererFailed && <p className="xn-office-render-error" role="status">{tr("完整渲染不可用，已切换到静态安全预览。")}</p>}
    <OfficeDtoRenderer office={office} />
  </>;
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

// -- change view -------------------------------------------------------------

export type DiffViewProps = {
  changeSet: FileChangeSet | null;
  error?: string;
};

function ChangeBlock({ change }: { change: FileChange }) {
  return (
    <div
      data-testid={`change-${change.path}`}
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        marginBottom: 10,
        overflow: "hidden",
        boxShadow: "var(--shadow-sm)",
      }}
    >
      <div
        style={{
          padding: "6px 12px",
          background: "var(--bg-subtle)",
          borderBottom: "1px solid var(--border)",
          fontSize: 12,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span style={{ fontWeight: 600, color: "var(--fg)", fontFamily: "var(--font-mono)" }}>
          {change.path}
        </span>
        <span style={{ color: change.ok ? "var(--ok-fg)" : "var(--error-fg)", fontWeight: 500 }}>
          {change.kind} · {change.ok ? tr("已应用") : tr("未应用")}
        </span>
      </div>
      {change.kind === "edit" ? (
        <div style={{ display: "flex", flexDirection: "column" }}>
          <CodeContent text={change.old ?? ""} path={change.path} tone="remove" />
          <CodeContent text={change.new ?? ""} path={change.path} tone="add" />
        </div>
      ) : (
        <CodeContent text={change.content ?? ""} path={change.path} tone="add" />
      )}
    </div>
  );
}

export function DiffView({ changeSet, error }: DiffViewProps) {
  // The provenance line is not decoration: without it this reads as a live diff,
  // which it is not. Keep it first and keep it unconditional.
  const provenance = (
    <div
      data-testid="diff-provenance"
      className="xn-diff-provenance"
    >{tr("来自会话记录，不是当前磁盘差异")}</div>
  );

  if (error) {
    return (
      <div data-testid="diff-view" className="xn-diff-container">
        {provenance}
        <p role="alert" data-testid="diff-error" style={{ margin: 0, color: "var(--error-fg)", background: "var(--error-bg)", border: "1px solid var(--error-border)", borderRadius: "var(--radius-md)", padding: "10px 14px", fontSize: 12 }}>{tr("读取改动失败：")}{error}
        </p>
      </div>
    );
  }

  if (!changeSet || changeSet.changes.length === 0) {
    return (
      <div data-testid="diff-view" className="xn-diff-container">
        {provenance}
        <div data-testid="diff-empty" style={{ fontSize: 12, color: "var(--fg-muted)", padding: "8px 0" }}>{tr("暂无改动")}</div>
      </div>
    );
  }

  return (
    <div data-testid="diff-view" className="xn-diff-container">
      {provenance}
      {changeSet.changes.map((change, index) => (
        <ChangeBlock key={`${change.path}-${index}`} change={change} />
      ))}
    </div>
  );
}

// -- settings panel ----------------------------------------------------------

export type SettingsPanelProps = {
  values: SettingsMap;
  capabilities: AgentCapabilities;
  onToggleCapability?: (key: keyof AgentCapabilities, value: boolean) => void;
  onSave?: () => void | Promise<unknown>;
  saveError?: string;
  dirty?: boolean;
};

const CAPABILITY_LABELS = (): { key: keyof AgentCapabilities; label: string; hint: string }[] => ([
  { key: "allowMcp", label: tr("允许 MCP"), hint: tr("会启动外部 MCP 子进程") },
  { key: "allowSubagents", label: tr("允许子代理"), hint: tr("会发起嵌套模型调用") },
  { key: "allowHooks", label: tr("允许 Hooks"), hint: tr("会在工具调用前后执行钩子") },
]);

export function SettingsPanel({
  capabilities,
  onToggleCapability,
  onSave,
  saveError,
  dirty = false,
}: SettingsPanelProps) {
  return (
    <section data-testid="settings-panel" className="xn-settings-container">
      <h3 style={{ margin: "0 0 6px", fontSize: 15, fontWeight: 600, color: "var(--fg)" }}>{tr("Agent 能力")}</h3>
      <p style={{ margin: "0 0 16px", fontSize: 12, color: "var(--warn-fg)", background: "var(--warn-bg)", border: "1px solid var(--warn-border)", borderRadius: "var(--radius-md)", padding: "8px 12px" }}>{tr("以下能力会启动子进程或嵌套模型调用，默认关闭，开启前请确认风险。")}</p>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {CAPABILITY_LABELS().map(({ key, label, hint }) => {
          const enabled = capabilities[key] === true;
          return (
            <label
              key={key}
              data-testid={`capability-${key}`}
              data-enabled={enabled ? "true" : "false"}
              className="xn-settings-card"
            >
              <input
                type="checkbox"
                aria-label={label}
                checked={enabled}
                readOnly={!onToggleCapability}
                onChange={
                  onToggleCapability ? (e) => onToggleCapability(key, e.target.checked) : undefined
                }
                style={{ marginTop: 2, accentColor: "var(--primary)" }}
              />
              <span>
                <span style={{ fontWeight: 600, color: "var(--fg)" }}>{label}</span>
                <span style={{ display: "block", fontSize: 12, color: "var(--fg-muted)", marginTop: 2 }}>{hint}</span>
              </span>
            </label>
          );
        })}
      </div>

      {saveError && (
        <p role="alert" data-testid="settings-save-error" style={{ margin: "14px 0 0", color: "var(--error-fg)", background: "var(--error-bg)", border: "1px solid var(--error-border)", borderRadius: "var(--radius-md)", padding: "8px 12px", fontSize: 12 }}>{tr("保存失败：")}{saveError}
        </p>
      )}

      {onSave && (
        <button
          type="button"
          data-testid="settings-save"
          onClick={() => void onSave()}
          disabled={!dirty}
          className="xn-btn xn-btn--primary xn-btn--md"
          style={{
            marginTop: 16,
          }}
        >{tr("保存")}</button>
      )}
    </section>
  );
}
