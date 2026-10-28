import React from "react";
import type { ComposerCapability, ComposerInput } from "../../xuenessComposer";
import { type ComposerAttachment } from "./composerAttachmentRef";
import type { UploadTransport } from './composerAttachmentUpload';
import type { RemoteAttachmentEndpoint } from './composerAttachmentRef';
import { type ComposerAttachmentOwner } from './composerAttachmentDraft';
import { type ComposerEditorState } from './composerEditorState';
import { type FollowupMode, type InputDelivery } from './CurrentTurnInput';
import { ComposerModelRecovery, ComposerStartActions, ComposerMention } from './composerInputHelpers';


export type ComposerProps = {
  sendShortcut?: "enter" | "mod-enter";
  onSend?: (text: string, input?: ComposerInput, onAccepted?: () => void, delivery?: InputDelivery) => boolean | void | Promise<boolean | void>;
  disabled?: boolean;
  /** Disable sending while keeping the prompt editable (for model/permission gates). */
  sendDisabled?: boolean;
  sendDisabledReason?: string;
  modelRecovery?: ComposerModelRecovery;
  running?: boolean;
  queueWhenRunning?: boolean;
  guideWhenRunning?: boolean;
  followupMode?: FollowupMode;
  onFollowupModeChange?: (mode: FollowupMode) => void;
  queueBusy?: boolean;
  stopping?: boolean;
  onStop?: () => void;
  /** Isolate and retain draft contents for each session without remounting the composer. */
  draftKey?: string;
  /** Parent-owned store retains per-session drafts while loading or changing views. */
  draftStore?: React.MutableRefObject<Map<string, ComposerDraftState>>;
  /** Workspace scope key for persisting prompt history and session drafts. */
  workspaceKey?: string;
  placeholder?: string;
  defaultValue?: string;
  /** "hero" renders the centered new-task card; "docked" the bottom composer. */
  variant?: "hero" | "docked";
  autoFocus?: boolean;
  inputRef?: React.Ref<HTMLElement>;
  /** Left side of the bottom row: mode/provider selects and other real controls. */
  footer?: React.ReactNode;
  /** Optional workspace/context controls shown inside the input surface. */
  topContent?: React.ReactNode;
  /** Complete model, permission and capability toolbar. */
  controls?: React.ReactNode;
  startActions?: ComposerStartActions;
  mentions?: ComposerMention[];
  capabilities?: ComposerCapability[];
  /** Slash-command candidates (loaded by the container from /api/resources/commands). */
  commands?: { id: string; description?: string }[];
  /** Workspace file candidates for @-mentions (loaded by the container). */
  files?: string[];
  /**
   * Minimal input chrome (lightweight local profile, owned by the providers
   * plugin): keep send/stop and the passed controls, hide the context "+" menu
   * and the keyboard hint. Chips and @-mention suggestions stay available.
   */
  minimal?: boolean;
  platform?: string;
  /** Settings-owned overrides for sessions-scoped send/stop commands. */
  shortcutBindings?: Record<string, string>;
  /** sessions.rich_composer. When false, keep the textarea and inline attachments. */
  richComposer?: boolean;
  /** Active session id for attachment begin/commit. Omitted for a new task. */
  attachmentSessionId?: string;
  /** Workspace root the attachment store binds to. Required for committed refs. */
  attachmentRoot?: string;
  attachmentsEnabled?: boolean;
  attachmentGeneration?: string | number;
  attachmentTransport?: UploadTransport;
  attachmentRemoteOwner?: RemoteAttachmentEndpoint;
};


export type ComposerDraftState = {
  draftId?: string;
  attachmentOwner?: ComposerAttachmentOwner;
  recoverableDrafts?: import('./composerRecovery').RecoverableComposerDraft[];
  pendingSubmission?: { id: string; draft: import('./composerRecovery').RecoverableComposerDraft };
  deliveryUnconfirmed?: boolean;
  hadAttachments?: boolean;
  /** sessions.rich_composer structured document. Absent when degraded to plain text. */
  editorState?: ComposerEditorState;
  text: string;
  attachments: ComposerAttachment[];
  goal: boolean;
  selectedCapabilities?: string[];
  selectedContext: Pick<ComposerInput, "files" | "sessions" | "skills" | "plugins">;
  submissionError: string;
  attachmentError: string;
  revision: number;
};


export function emptyComposerDraft(text = ""): ComposerDraftState {
  return {
    draftId: crypto.randomUUID(),
    text,
    attachments: [],
    goal: false,
    selectedCapabilities: [],
    selectedContext: { files: [], sessions: [], skills: [], plugins: [] },
    submissionError: "",
    attachmentError: "",
    revision: 0,
  };
}
