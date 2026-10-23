import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { tf } from "../../i18n";
import { IconX } from "../../ui/icons";
import { parseAttachmentRef, type ComposerAttachment } from "./composerAttachmentRef";
import {
  attachmentPreviewKind, canRequestAttachmentPreview, previewText,
  type AttachmentPreview, type AttachmentPreviewKind, type AttachmentPreviewTransport,
} from "./composerAttachmentPreviewModel";

export type { AttachmentPreview, AttachmentPreviewKind };
export { attachmentPreviewKind, canRequestAttachmentPreview };

// The dialog, parser and media/text renderer stay out of the startup graph until a preview opens.
const AttachmentPreviewDialog = lazy(() =>
  import("./composerAttachmentPreviewDialog").then(module => ({ default: module.AttachmentPreviewDialog })),
);

export function ComposerAttachmentChip({
  attachment,
  enabled,
  root,
  sessionId,
  onRemove,
  previewTransport,
}: {
  attachment: ComposerAttachment;
  enabled: boolean;
  root?: string;
  sessionId?: string;
  onRemove?: () => void;
  previewTransport?: AttachmentPreviewTransport;
}) {
  const previewable = canRequestAttachmentPreview(enabled, root, attachment, Boolean(previewTransport));
  const ref = useMemo(() => previewable ? parseAttachmentRef(attachment.ref) : null, [previewable, attachment.ref]);
  const [open, setOpen] = useState(false);
  const openRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!previewable && open) setOpen(false);
  }, [previewable, open]);

  const dialog = open && previewable && root && ref ? (
    <Suspense fallback={null}>
      <AttachmentPreviewDialog
        name={attachment.name}
        mimeType={ref.mimeType}
        size={ref.size}
        root={root}
        sessionId={sessionId}
        id={ref.id}
        attachmentRef={ref}
        previewTransport={previewTransport}
        returnFocusTo={openRef.current}
        onClose={() => setOpen(false)}
      />
    </Suspense>
  ) : null;

  return (
    <span className="xn-composer__context-chip" data-testid="composer-attachment-chip" data-attachment-origin={attachment.ref?.origin} data-preview-kind={ref ? attachmentPreviewKind(ref.mimeType) : undefined}>
      {ref ? (
        <button
          ref={openRef}
          type="button"
          className="xn-composer__preview-open"
          data-testid="composer-attachment-preview"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={previewText("预览附件：{0}", [attachment.name])}
          onClick={() => setOpen(true)}
        >
          <span>{attachment.name}</span>
        </button>
      ) : <span>{attachment.name}</span>}
      {attachment.ref?.remoteOwner && !previewTransport && <span role="status">Remote attachment preview is unavailable.</span>}
      {onRemove && <button type="button" aria-label={tf("移除附件：{0}", [attachment.name])} onClick={onRemove}><IconX size={12} /></button>}
      {dialog}
    </span>
  );
}

/** Loaded only when the rich composer is showing attachments. */
export default function ComposerAttachmentChips({
  attachments,
  enabled,
  root,
  sessionId,
  onRemove,
  previewTransport,
}: {
  attachments: readonly ComposerAttachment[];
  enabled: boolean;
  root?: string;
  sessionId?: string;
  onRemove: (index: number) => void;
  previewTransport?: AttachmentPreviewTransport;
}) {
  return (
    <>
      {attachments.map((attachment, index) => (
        <ComposerAttachmentChip
          key={(attachment.ref?.id ?? attachment.name) + ":" + index}
          attachment={attachment}
          enabled={enabled}
          root={root}
          sessionId={sessionId}
          onRemove={() => onRemove(index)}
          previewTransport={previewTransport}
        />
      ))}
    </>
  );
}
