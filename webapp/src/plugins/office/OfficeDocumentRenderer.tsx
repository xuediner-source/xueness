import React from "react";
import { t as tr } from "../../i18n";
import type { OfficeBlock, OfficeImage, OfficePreview, OfficeRun } from "../../xuenessWorkbench";
import "../../styles/office.css";

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

export function OfficeDocumentRenderer({ office }: { office: OfficePreview }) {
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
