import React from "react";
import { editorStateSignature, navigationLength, renderEditorHtml, type ComposerEditorState } from './composerEditorState';

export type ComposerEditorSurface = { scope: string; key: number; signature: string; html: string; caret: number };

export function resolveComposerEditorSurface({ surfaceRef, tokenEditor, localEditSignature, pendingCaret, scopedDraftKey }: {
  surfaceRef: React.MutableRefObject<ComposerEditorSurface>;
  tokenEditor: ComposerEditorState | null;
  localEditSignature: React.MutableRefObject<string>;
  pendingCaret: React.MutableRefObject<number | null>;
  scopedDraftKey: string;
}) {
  let editorSurface = surfaceRef.current;
  if (!tokenEditor) {
    if (editorSurface.scope) {
      editorSurface = { scope: "", key: 0, signature: "", html: "", caret: 0 };
      surfaceRef.current = editorSurface;
    }
  } else {
    const signature = editorStateSignature(tokenEditor);
    const local = localEditSignature.current === signature;
    if (local) {
      localEditSignature.current = "";
      if (editorSurface.signature !== signature) {
        editorSurface = { ...editorSurface, signature };
        surfaceRef.current = editorSurface;
      }
    } else if (editorSurface.scope !== scopedDraftKey || editorSurface.signature !== signature) {
      const caret = pendingCaret.current ?? navigationLength(tokenEditor);
      pendingCaret.current = null;
      editorSurface = {
        scope: scopedDraftKey,
        key: editorSurface.scope === scopedDraftKey ? editorSurface.key + 1 : 0,
        signature,
        html: renderEditorHtml(tokenEditor),
        caret,
      };
      surfaceRef.current = editorSurface;
    }
  }
  return editorSurface;
}
