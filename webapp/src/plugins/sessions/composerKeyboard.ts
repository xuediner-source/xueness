import { isModKeyPressed, isImeComposingEvent } from '../../xuenessShortcutDisplay';



export function isImeCompositionKey(e: {
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
  keyCode?: number;
  isComposing?: boolean;
  key?: string;
  compositionActive?: boolean;
}): boolean {
  return isImeComposingEvent(e);
}


export function composerEnterIntent(
  e: {
    key: string; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean;
    nativeEvent?: { isComposing?: boolean; keyCode?: number }; keyCode?: number; isComposing?: boolean;
    compositionActive?: boolean;
  },
  sendShortcut: "enter" | "mod-enter",
  hasSuggestions: boolean,
  platform?: string,
): "accept-suggestion" | "send" | null {
  if (e.key !== "Enter" || isImeCompositionKey(e)) return null;
  if (hasSuggestions && !e.shiftKey && !e.altKey) return "accept-suggestion";
  if (e.shiftKey || e.altKey) return null;
  if (sendShortcut === "enter") return "send";
  return isModKeyPressed(e, platform) ? "send" : null;
}


export function handleComposerEscapeAction(
  e: {
    key: string;
    nativeEvent?: { isComposing?: boolean; keyCode?: number };
    keyCode?: number;
    isComposing?: boolean;
    compositionActive?: boolean;
    preventDefault: () => void;
  },
  state: {
    hasSuggestions: boolean;
    onDismissSuggestions: () => void;
    plusOpen: boolean;
    onClosePlus: () => void;
    running: boolean;
    stopping: boolean;
    onStop?: () => void;
    hasHistory?: boolean;
    onExitHistory?: () => void;
  },
): boolean {
  if (e.key !== "Escape") return false;
  if (isImeCompositionKey(e)) return false;
  e.preventDefault();
  if (state.hasSuggestions) {
    state.onDismissSuggestions();
    return true;
  }
  if (state.plusOpen) {
    state.onClosePlus();
    return true;
  }
  if (state.hasHistory && state.onExitHistory) {
    state.onExitHistory();
    return true;
  }
  if (state.running && state.onStop && !state.stopping) {
    state.onStop();
    return true;
  }
  return true;
}
