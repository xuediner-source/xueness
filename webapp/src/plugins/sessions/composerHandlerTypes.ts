import type React from "react";
import type { ComposerAttachmentOwner } from './composerAttachmentDraft';
import type { getComposerAttachmentUploadStore } from './composerAttachmentUploadStore';
import type { ComposerDraftState } from './composerTypes';

export type ComposerDraftsRef = React.MutableRefObject<Map<string, ComposerDraftState>>;
export type ComposerUploadStore = ReturnType<typeof getComposerAttachmentUploadStore>;
export type ComposerUploadOwner = ComposerAttachmentOwner;
export type UpdateComposerDraft = (
  update: (current: ComposerDraftState) => ComposerDraftState,
  contentChanged?: boolean,
) => ComposerDraftState;
export type UpdateComposerDraftFor = (
  scope: string,
  update: (current: ComposerDraftState) => ComposerDraftState,
  contentChanged?: boolean,
) => ComposerDraftState;
