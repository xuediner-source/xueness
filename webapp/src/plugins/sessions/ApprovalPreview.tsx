import { t as tr, tf } from '../../i18n';
import { useMemo, useState } from "react";
import { parseDiffPreview } from './diffPreview';
import { approvalPreviewOpenState, setPersistedDisclosure } from './disclosureState';


export function ApprovalItemPreview({
  preview,
  toolCallId,
}: {
  preview: string;
  toolCallId: string;
}) {
  const diff = useMemo(() => parseDiffPreview(preview), [preview]);
  const [isOpen, setIsOpen] = useState(() => approvalPreviewOpenState.get(toolCallId) ?? true);

  const toggleOpen = () => {
    const next = !isOpen;
    setPersistedDisclosure(approvalPreviewOpenState, toolCallId, next);
    setIsOpen(next);
  };

  const lineCount = preview.split(/\r?\n/).length;
  const canFold = lineCount > 6 || preview.length > 280;

  if (diff.isDiff) {
    return (
      <div className="xn-approval-diff" data-testid={`approval-diff-${toolCallId}`}>
        <div className="xn-approval-diff__toolbar">
          <span className="xn-diff-stat" aria-label={tf("改动：+{0} -{1}", [diff.added, diff.removed])}>
            <span className="xn-diff-stat--add">+{diff.added}</span>{" "}
            <span className="xn-diff-stat--remove">-{diff.removed}</span>
          </span>
          {canFold && (
            <button
              type="button"
              className="xn-approval-preview-toggle"
              onClick={toggleOpen}
              aria-expanded={isOpen}
            >
              {tr(isOpen ? "收起预览" : "展开预览")}
            </button>
          )}
        </div>
        {isOpen && (
          <div
            className="xn-unified-diff"
            style={{
              maxHeight: 160,
              overflowY: "auto",
              background: "var(--bg-card)",
              padding: "4px 6px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border)",
            }}
          >
            <table aria-label={tr("文件改动差异")}>
              <tbody>
                {diff.lines.map((dl, i) => (
                  <tr key={i} className={`xn-diff-line xn-diff-line--${dl.kind}`}>
                    <td className="xn-diff-line__marker" aria-hidden="true">
                      {dl.kind === "add" ? "+" : dl.kind === "remove" ? "−" : dl.kind === "hunk" ? "@@" : " "}
                    </td>
                    <td className="xn-diff-line__text"><code>{dl.text || " "}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {canFold && (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            className="xn-approval-preview-toggle"
            onClick={toggleOpen}
            aria-expanded={isOpen}
          >
            {tr(isOpen ? "收起预览" : "展开预览")}
          </button>
        </div>
      )}
      {isOpen && (
        <div
          style={{
            color: "var(--fg-subtle)",
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            whiteSpace: "pre-wrap",
            maxHeight: 120,
            overflowY: "auto",
            background: "var(--bg-card)",
            padding: "6px 8px",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--border)",
          }}
        >
          {preview}
        </div>
      )}
    </div>
  );
}
