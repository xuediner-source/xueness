import type { ComposerCapability } from "../../xuenessComposer";
import { MAX_SELECTED_COMPOSER_CAPABILITIES } from './ComposerCapabilityMenu';
import { editorStateForPlainText, editorStateMatching } from './composerEditorState';
import type { ComposerMention } from './composerInputHelpers';
import type { UpdateComposerDraft } from './composerHandlerTypes';

export function createComposerDraftActions({ capabilities, updateCurrentDraft, richComposer }: {
  capabilities: ComposerCapability[];
  updateCurrentDraft: UpdateComposerDraft;
  richComposer: boolean;
}) {
  const toggleCapability = (item: ComposerCapability) => {
    if (item.available === false || !capabilities.some(entry => entry.id === item.id && entry.available !== false)) return;
    updateCurrentDraft(current => {
      const previous = current.selectedCapabilities ?? [];
      if (previous.includes(item.id)) {
        return { ...current, selectedCapabilities: previous.filter(id => id !== item.id) };
      }
      if (previous.length >= MAX_SELECTED_COMPOSER_CAPABILITIES) return current;
      return { ...current, selectedCapabilities: [...previous, item.id] };
    });
  };
  const setText = (value: string | ((previous: string) => string)) => updateCurrentDraft(current => {
    const nextText = typeof value === "function" ? value(current.text) : value;
    if (!richComposer) {
      if (nextText === current.text && !current.submissionError && !current.editorState) return current;
      return { ...current, text: nextText, editorState: undefined, submissionError: "" };
    }
    if (nextText === current.text && !current.submissionError && editorStateMatching(nextText, current.editorState)) return current;
    const editorState = editorStateForPlainText(nextText) ?? undefined;
    if (nextText === current.text && !current.submissionError && !editorState && !current.editorState) return current;
    return { ...current, text: nextText, editorState, submissionError: "" };
  });
  const setGoal = (value: boolean | ((previous: boolean) => boolean)) => updateCurrentDraft(current => {
    const nextGoal = typeof value === "function" ? value(current.goal) : value;
    return nextGoal === current.goal ? current : { ...current, goal: nextGoal };
  });
  const toggleContext = (mention: ComposerMention) => {
    const field = mention.kind === "file" ? "files" : mention.kind === "session" ? "sessions" : mention.kind === "skill" ? "skills" : "plugins";
    updateCurrentDraft(current => {
      const values = current.selectedContext[field];
      const next = values.includes(mention.id)
        ? values.filter((id) => id !== mention.id)
        : [...values, mention.id];
      if (next === values) return current;
      return { ...current, selectedContext: { ...current.selectedContext, [field]: next } };
    });
  };
  const addContext = (mention: ComposerMention) => {
    const field = mention.kind === "file" ? "files" : mention.kind === "session" ? "sessions" : mention.kind === "skill" ? "skills" : "plugins";
    updateCurrentDraft(current => current.selectedContext[field].includes(mention.id)
      ? current
      : { ...current, selectedContext: { ...current.selectedContext, [field]: [...current.selectedContext[field], mention.id] } });
  };

  return { toggleCapability, setText, setGoal, toggleContext, addContext };
}
