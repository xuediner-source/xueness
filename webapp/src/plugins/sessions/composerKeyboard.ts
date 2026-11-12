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

