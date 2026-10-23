// Bounded structured composer document for sessions.rich_composer.
// Plain text stays the send projection. Mention and slash nodes round-trip
// inline; an unreadable or oversized document degrades to that plain text.

export const COMPOSER_EDITOR_STATE_VERSION = 1;

export const COMPOSER_EDITOR_LIMITS = {
  maxNodes: 64,
  maxAtomic: 24,
  maxJsonChars: 24_000,
  maxTextChars: 20_000,
  maxIdChars: 240,
  maxLabelChars: 80,
} as const;

export const MENTION_NAV = "\uFFFC";

export type EditorMentionKind = "file" | "session" | "skill" | "plugin";

export type EditorTextNode = { type: "text"; text: string };
export type EditorMentionNode = {
  type: "mention";
  kind: EditorMentionKind;
  id: string;
  label: string;
};
export type EditorSlashNode = { type: "slash"; id: string; label: string };
export type ComposerEditorNode = EditorTextNode | EditorMentionNode | EditorSlashNode;

export type ComposerEditorState = {
  version: typeof COMPOSER_EDITOR_STATE_VERSION;
  nodes: ComposerEditorNode[];
};

export type EditorSuggestion = {
  kind: "command" | "file" | "session" | "skill" | "plugin" | "goal" | "workflow";
  token: string;
  label?: string;
};

export type EditorContextFields = {
  files: string[];
  sessions: string[];
  skills: string[];
  plugins: string[];
};

const MENTION_KINDS = new Set<EditorMentionKind>(["file", "session", "skill", "plugin"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanLabel(value: string): string {
  return value.replace(/\uFFFC/g, "").replace(/\s+/g, " ").trim();
}

function cleanText(value: string): string {
  return value.replace(/\uFFFC/g, "").replace(/\u0000/g, "");
}

export function nodeNavigationLength(node: ComposerEditorNode): number {
  if (node.type === "text") return node.text.length;
  if (node.type === "mention") return MENTION_NAV.length;
  return node.id.length + 2;
}

export function navigationText(state: ComposerEditorState): string {
  return state.nodes.map(node => {
    if (node.type === "text") return node.text;
    if (node.type === "mention") return MENTION_NAV;
    return `/${node.id} `;
  }).join("");
}

/** Text sent through the existing composer prepare path. Mentions stay in context. */
export function sendableText(state: ComposerEditorState): string {
  return state.nodes.map(node => {
    if (node.type === "text") return node.text;
    if (node.type === "slash") return `/${node.id} `;
    return "";
  }).join("");
}

export function editorHasAtomicNodes(state: ComposerEditorState | null | undefined): boolean {
  return Boolean(state?.nodes.some(node => node.type !== "text"));
}

export function editorStateSignature(state: ComposerEditorState): string {
  return JSON.stringify(state);
}

export function navigationLength(state: ComposerEditorState): number {
  return state.nodes.reduce((sum, node) => sum + nodeNavigationLength(node), 0);
}

function normalizeNodes(nodes: ComposerEditorNode[]): ComposerEditorNode[] {
  const merged: ComposerEditorNode[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      const text = cleanText(node.text);
      const last = merged[merged.length - 1];
      if (last?.type === "text") last.text += text;
      else merged.push({ type: "text", text });
      continue;
    }
    merged.push(node);
  }
  const slotted: ComposerEditorNode[] = [];
  for (const node of merged) {
    if (node.type !== "text" && slotted[slotted.length - 1]?.type !== "text") {
      slotted.push({ type: "text", text: "" });
    }
    slotted.push(node);
  }
  if (slotted.length === 0 || slotted[slotted.length - 1]?.type !== "text") {
    slotted.push({ type: "text", text: "" });
  }
  return slotted;
}

function bounded(state: ComposerEditorState): ComposerEditorState | null {
  if (state.nodes.length > COMPOSER_EDITOR_LIMITS.maxNodes) return null;
  const atomic = state.nodes.filter(node => node.type !== "text").length;
  if (atomic > COMPOSER_EDITOR_LIMITS.maxAtomic) return null;
  const textChars = state.nodes.reduce((sum, node) => sum + (node.type === "text" ? node.text.length : 0), 0);
  if (textChars > COMPOSER_EDITOR_LIMITS.maxTextChars) return null;
  if (JSON.stringify(state).length > COMPOSER_EDITOR_LIMITS.maxJsonChars) return null;
  return state;
}

function readNode(value: unknown): ComposerEditorNode | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  if (value.type === "text") {
    if (typeof value.text !== "string") return null;
    return { type: "text", text: cleanText(value.text) };
  }
  if (value.type === "mention") {
    if (typeof value.kind !== "string" || !MENTION_KINDS.has(value.kind as EditorMentionKind)) return null;
    if (typeof value.id !== "string" || typeof value.label !== "string") return null;
    const id = value.id.trim();
    const label = cleanLabel(value.label);
    if (!id || !label || id.length > COMPOSER_EDITOR_LIMITS.maxIdChars || label.length > COMPOSER_EDITOR_LIMITS.maxLabelChars) return null;
    if (/[\u0000\n\r<>]/.test(id)) return null;
    return { type: "mention", kind: value.kind as EditorMentionKind, id, label };
  }
  if (value.type === "slash") {
    if (typeof value.id !== "string") return null;
    const id = value.id.trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) return null;
    const label = typeof value.label === "string" && value.label.trim() ? cleanLabel(value.label) : id;
    if (!label || label.length > COMPOSER_EDITOR_LIMITS.maxLabelChars) return null;
    return { type: "slash", id, label };
  }
  return null;
}

/** Returns null when the document is corrupt or over the draft bounds. */
export function parseComposerEditorState(value: unknown): ComposerEditorState | null {
  if (!isRecord(value) || value.version !== COMPOSER_EDITOR_STATE_VERSION || !Array.isArray(value.nodes)) return null;
  const nodes: ComposerEditorNode[] = [];
  for (const item of value.nodes) {
    const node = readNode(item);
    if (!node) return null;
    nodes.push(node);
  }
  return bounded({ version: COMPOSER_EDITOR_STATE_VERSION, nodes: normalizeNodes(nodes) });
}

export function editorStateForPlainText(text: string): ComposerEditorState | null {
  if (typeof text !== "string") return null;
  return parseComposerEditorState({ version: COMPOSER_EDITOR_STATE_VERSION, nodes: [{ type: "text", text }] });
}

export function editorStateMatching(text: string, stored: unknown): ComposerEditorState | null {
  const parsed = parseComposerEditorState(stored);
  if (!parsed || sendableText(parsed) !== text) return null;
  return parsed;
}

export function editorStateHasContent(stored: unknown): boolean {
  const parsed = parseComposerEditorState(stored);
  if (!parsed) return false;
  return sendableText(parsed).trim().length > 0 || editorHasAtomicNodes(parsed);
}

function replaceRange(state: ComposerEditorState, start: number, end: number, insert: ComposerEditorNode[]): ComposerEditorState | null {
  if (start < 0 || end < start) return null;
  let cursor = 0;
  let host: { index: number; localStart: number; localEnd: number } | null = null;
  for (let index = 0; index < state.nodes.length; index += 1) {
    const node = state.nodes[index];
    const len = nodeNavigationLength(node);
    if (node.type === "text" && cursor <= start && end <= cursor + len) {
      host = { index, localStart: start - cursor, localEnd: end - cursor };
      break;
    }
    cursor += len;
  }
  if (!host) return null;
  const node = state.nodes[host.index];
  if (node.type !== "text") return null;
  const before = node.text.slice(0, host.localStart);
  const after = node.text.slice(host.localEnd);
  const nodes: ComposerEditorNode[] = [
    ...state.nodes.slice(0, host.index),
    ...(before ? [{ type: "text", text: before } satisfies EditorTextNode] : []),
    ...insert,
    ...(after ? [{ type: "text", text: after } satisfies EditorTextNode] : []),
    ...state.nodes.slice(host.index + 1),
  ];
  return parseComposerEditorState({ version: COMPOSER_EDITOR_STATE_VERSION, nodes });
}

export function applyEditorSuggestion(
  state: ComposerEditorState,
  cursor: number,
  suggestion: EditorSuggestion,
): { state: ComposerEditorState; cursor: number } | null {
  const before = navigationText(state).slice(0, Math.max(0, cursor));
  const command = /(?:^|\s)\/([A-Za-z0-9._-]*)$/.exec(before);
  const skill = /(?:^|\s)\$([^\s@#$]*)$/.exec(before);
  const mention = /(?:^|\s)@([^\s@#$]*)$/.exec(before);
  let match: RegExpExecArray | null = null;
  let insert: ComposerEditorNode[] = [];
  if (suggestion.kind === "command" || suggestion.kind === "goal" || suggestion.kind === "workflow") {
    match = command;
    if (suggestion.kind === "command") {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(suggestion.token)) return null;
      insert = [{ type: "slash", id: suggestion.token, label: suggestion.label?.trim() || suggestion.token }];
    }
  } else if (suggestion.kind === "skill") {
    match = skill;
    insert = [{ type: "mention", kind: "skill", id: suggestion.token, label: suggestion.label?.trim() || suggestion.token }];
  } else {
    match = mention;
    insert = [{ type: "mention", kind: suggestion.kind, id: suggestion.token, label: suggestion.label?.trim() || suggestion.token }];
  }
  if (!match) return null;
  const lead = match[0].match(/^\s*/)?.[0].length ?? 0;
  const triggerStart = before.length - match[0].length + lead;
  const next = replaceRange(state, triggerStart, before.length, insert);
  if (!next) return null;
  const inserted = insert.reduce((sum, node) => sum + nodeNavigationLength(node), 0);
  return { state: next, cursor: triggerStart + inserted };
}

export function insertEditorText(
  state: ComposerEditorState,
  cursor: number,
  value: string,
): { state: ComposerEditorState; cursor: number } | null {
  if (!value) return { state, cursor };
  const next = replaceRange(state, cursor, cursor, [{ type: "text", text: value }]);
  if (!next) return null;
  return { state: next, cursor: cursor + value.length };
}

export function insertTextAtEnd(state: ComposerEditorState, suffix: string): ComposerEditorState | null {
  if (!suffix) return state;
  const inserted = insertEditorText(state, navigationLength(state), suffix);
  return inserted?.state ?? null;
}

function stripSendableEnd(state: ComposerEditorState, count: number): ComposerEditorState | null {
  if (count <= 0) return state;
  const nodes = state.nodes.map(node => node.type === "text" ? { ...node } : node);
  let left = count;
  for (let index = nodes.length - 1; index >= 0 && left > 0; index -= 1) {
    const node = nodes[index];
    if (node.type !== "text" || node.text.length === 0) continue;
    if (node.text.length <= left) {
      left -= node.text.length;
      node.text = "";
    } else {
      node.text = node.text.slice(0, node.text.length - left);
      left = 0;
    }
  }
  if (left > 0) return null;
  return parseComposerEditorState({ version: COMPOSER_EDITOR_STATE_VERSION, nodes });
}

/** Keep mention/slash nodes when the sendable text only grows or trims its tail. */
export function retargetEditorText(stored: unknown, nextText: string): ComposerEditorState | null {
  const parsed = parseComposerEditorState(stored);
  if (!parsed || !editorHasAtomicNodes(parsed)) return editorStateForPlainText(nextText);
  const current = sendableText(parsed);
  if (nextText === current) return parsed;
  if (nextText.startsWith(current)) return insertTextAtEnd(parsed, nextText.slice(current.length));
  const trimmed = current.trimEnd();
  if (trimmed.length < current.length && (nextText === trimmed || nextText.startsWith(trimmed))) {
    const stripped = stripSendableEnd(parsed, current.length - trimmed.length);
    if (!stripped) return editorStateForPlainText(nextText);
    const suffix = nextText.slice(trimmed.length);
    return suffix ? insertTextAtEnd(stripped, suffix) : stripped;
  }
  return editorStateForPlainText(nextText);
}

export function deleteEditorAtom(
  state: ComposerEditorState,
  cursor: number,
  direction: "backspace" | "delete",
): { state: ComposerEditorState; cursor: number; removed: EditorMentionNode | EditorSlashNode } | null {
  let offset = 0;
  for (let index = 0; index < state.nodes.length; index += 1) {
    const node = state.nodes[index];
    const len = nodeNavigationLength(node);
    const atStart = cursor === offset;
    const atEnd = cursor === offset + len;
    const previous = index > 0 ? state.nodes[index - 1] : null;
    const next = state.nodes[index + 1];
    let removeAt = -1;
    if (direction === "backspace" && node.type === "text" && atStart && previous && previous.type !== "text") removeAt = index - 1;
    else if (direction === "backspace" && node.type !== "text" && atEnd) removeAt = index;
    else if (direction === "delete" && node.type === "text" && atEnd && next && next.type !== "text") removeAt = index + 1;
    else if (direction === "delete" && node.type !== "text" && atStart) removeAt = index;
    if (removeAt >= 0) {
      const removed = state.nodes[removeAt];
      if (!removed || removed.type === "text") return null;
      const nodes = state.nodes.filter((_, item) => item !== removeAt);
      const nextState = parseComposerEditorState({ version: COMPOSER_EDITOR_STATE_VERSION, nodes });
      if (!nextState) return null;
      return { state: nextState, cursor: Math.min(cursor, navigationLength(nextState)), removed };
    }
    offset += len;
  }
  return null;
}

const CONTEXT_FIELD: Record<EditorMentionKind, keyof EditorContextFields> = {
  file: "files",
  session: "sessions",
  skill: "skills",
  plugin: "plugins",
};

export function contextAfterEditorEdit(
  context: EditorContextFields,
  previous: ComposerEditorState | null,
  next: ComposerEditorState,
): EditorContextFields {
  if (!previous) return context;
  const still = new Set(next.nodes.filter((node): node is EditorMentionNode => node.type === "mention").map(node => `${node.kind}:${node.id}`));
  let changed = false;
  const result: EditorContextFields = {
    files: [...context.files],
    sessions: [...context.sessions],
    skills: [...context.skills],
    plugins: [...context.plugins],
  };
  for (const node of previous.nodes) {
    if (node.type !== "mention" || still.has(`${node.kind}:${node.id}`)) continue;
    const field = CONTEXT_FIELD[node.kind];
    const values = result[field].filter(id => id !== node.id);
    if (values.length !== result[field].length) {
      result[field] = values;
      changed = true;
    }
  }
  return changed ? result : context;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** Static HTML for the structured surface. Empty text slots keep a caret position. */
export function renderEditorHtml(state: ComposerEditorState): string {
  return state.nodes.map(node => {
    if (node.type === "text") {
      const text = node.text.length > 0 ? escapeHtml(node.text) : "\u200B";
      return `<span data-editor-node="text">${text}</span>`;
    }
    if (node.type === "mention") {
      return `<span data-editor-node="mention" data-mention-kind="${escapeHtml(node.kind)}" data-mention-id="${escapeHtml(node.id)}" data-testid="composer-editor-mention" class="xn-composer__editor-token" contenteditable="false" spellcheck="false">${escapeHtml(node.label)}</span>`;
    }
    return `<span data-editor-node="slash" data-slash-id="${escapeHtml(node.id)}" data-testid="composer-editor-slash" class="xn-composer__editor-token xn-composer__editor-token--slash" contenteditable="false" spellcheck="false">/${escapeHtml(node.id)}</span>`;
  }).join("");
}
