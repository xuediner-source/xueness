import React from "react";
import type { FilePreview, Result, TimelineRow } from "../../xuenessWorkbench";
import { loadFilePreview } from "../../xuenessWorkbench";
import { t as tr, tf } from "../../i18n";
import { conversationFindRowKey } from "./ConversationFind";
import { clipMountedPreview, referencePreviewAllowed, type ReferenceKind } from "./referenceRows";

type ReferenceRow = Extract<TimelineRow, { kind: ReferenceKind }>;
type PreviewLoader = (id: string, path: string, signal?: AbortSignal) => Promise<Result<FilePreview>>;

const KIND_LABEL: Record<ReferenceKind, string> = {
  citation: "引用",
  preview: "预览",
  artifact: "产物",
};

function rowProps(row: ReferenceRow): {
  "data-zcode-row-key": string;
  "data-zcode-row-kind": ReferenceKind;
  "data-zcode-row-seq": number;
  "data-testid": string;
  "data-reference-kind": ReferenceKind;
} {
  return {
    "data-zcode-row-key": conversationFindRowKey(row),
    "data-zcode-row-kind": row.kind,
    "data-zcode-row-seq": row.seq,
    "data-testid": `timeline-item-${row.kind}-${row.seq}`,
    "data-reference-kind": row.kind,
  };
}

function location(row: ReferenceRow): string {
  return row.startLine !== undefined && row.endLine !== undefined ? `${row.path}:${row.startLine}-${row.endLine}` : row.path;
}

function PlainReference({ row }: { row: ReferenceRow }): React.JSX.Element {
  return <p className="xn-zc-ref" {...rowProps(row)} data-reference-mode="plain">
    <span className="xn-zc-ref__kind">{tr(KIND_LABEL[row.kind])}</span>
    <span>{row.label}</span>
    <span className="xn-zc-ref__path">{location(row)}</span>
  </p>;
}

function MountedPreview({ sessionId, path, startLine, endLine, loadPreview }: {
  sessionId: string;
  path: string;
  startLine?: number;
  endLine?: number;
  loadPreview: PreviewLoader;
}): React.JSX.Element {
  const [state, setState] = React.useState<"loading" | "error" | "ready">("loading");
  const [body, setBody] = React.useState<{ text?: string; image?: string } | null>(null);
  React.useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState("loading");
    setBody(null);
    void loadPreview(sessionId, path, controller.signal).then(result => {
      if (!active) return;
      if (!result.ok) {
        setState("error");
        return;
      }
      const clipped = clipMountedPreview(result.value, path, { startLine, endLine });
      if (!clipped || (clipped.text === undefined && clipped.image === undefined)) {
        setState("error");
        return;
      }
      setBody(clipped);
      setState("ready");
    }, () => { if (active) setState("error"); });
    return () => {
      active = false;
      controller.abort();
    };
  }, [sessionId, path, startLine, endLine, loadPreview]);
  if (state === "loading") return <p className="xn-zc-ref__status" role="status">{tr("正在读取预览…")}</p>;
  if (state === "error" || !body) return <p className="xn-zc-ref__status" role="alert">{tr("无法预览该文件")}</p>;
  return <>
    {body.image ? <img className="xn-zc-ref__image" alt={path} src={body.image} /> : null}
    {body.text !== undefined ? <pre>{body.text}</pre> : null}
  </>;
}

export function ReferenceRowView({ row, sessionId, effectivePluginIds, loadPreview = loadFilePreview }: {
  row: ReferenceRow;
  sessionId?: string;
  effectivePluginIds?: ReadonlySet<string>;
  loadPreview?: PreviewLoader;
}): React.JSX.Element {
  const allowed = row.kind !== "citation" && Boolean(sessionId) && referencePreviewAllowed(row.path, effectivePluginIds);
  if (!allowed && row.kind !== "citation") return <PlainReference row={row} />;
  if (row.kind === "citation") {
    return <p className="xn-zc-ref" {...rowProps(row)} data-reference-mode="text">
      <span className="xn-zc-ref__kind">{tr("引用")}</span>
      <span>{row.label}</span>
      <span className="xn-zc-ref__path">{location(row)}</span>
    </p>;
  }
  if (row.kind === "artifact") {
    return <ArtifactReference row={row} sessionId={sessionId ?? ""} loadPreview={loadPreview} />;
  }
  return <section className="xn-zc-ref" {...rowProps(row)} data-reference-mode="mounted" aria-label={tr("预览")}>
    <span className="xn-zc-ref__kind">{tr("预览")}</span>
    <span>{row.label}</span>
    <span className="xn-zc-ref__path">{location(row)}</span>
    <MountedPreview sessionId={sessionId ?? ""} path={row.path} startLine={row.startLine} endLine={row.endLine} loadPreview={loadPreview} />
  </section>;
}

function ArtifactReference({ row, sessionId, loadPreview }: {
  row: ReferenceRow;
  sessionId: string;
  loadPreview: PreviewLoader;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  return <details className="xn-zc-ref" {...rowProps(row)} data-reference-mode="artifact" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>
      <span className="xn-zc-ref__kind">{tr("产物")}</span>
      <span>{row.label}</span>
      <span className="xn-zc-ref__path">{location(row)}</span>
      {row.sizeBytes !== undefined ? <span>{tf("{0} 字节", [row.sizeBytes])}</span> : null}
    </summary>
    {open ? <MountedPreview sessionId={sessionId} path={row.path} startLine={row.startLine} endLine={row.endLine} loadPreview={loadPreview} /> : null}
  </details>;
}
