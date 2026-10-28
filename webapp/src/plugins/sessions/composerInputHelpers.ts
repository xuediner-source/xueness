import { t as tr } from '../../i18n';



/** A slash command or @-file suggestion shown above the composer. */
export type ComposerSuggestion = {
  kind: "command" | "file";
  /** Command id (without "/") or workspace file path. */
  token: string;
  description?: string;
};


/** Pure token analysis so SSR tests can assert suggestion behaviour. */
export function composerSuggestions(
  text: string,
  commands: { id: string; description?: string }[],
  files: string[],
): ComposerSuggestion[] {
  // "/name" with no whitespace yet → command suggestions by id prefix.
  const slash = /^\/([A-Za-z0-9._-]*)$/.exec(text);
  if (slash) {
    const prefix = slash[1].toLowerCase();
    return commands
      .filter((c) => c.id.toLowerCase().startsWith(prefix))
      .slice(0, 8)
      .map((c) => ({ kind: "command" as const, token: c.id, description: c.description }));
  }
  // An unfinished "@path" fragment at the end (no whitespace after the last @)
  // → file suggestions by substring, deepest-path-friendly: plain includes().
  const at = /(?:^|\s)@([^\s@]*)$/.exec(text);
  if (at) {
    const needle = at[1].toLowerCase();
    return files
      .filter((f) => f.toLowerCase().includes(needle))
      .slice(0, 8)
      .map((f) => ({ kind: "file" as const, token: f }));
  }
  return [];
}


/** Replace the trailing "/cmd" or "@path" fragment with the chosen token. */
export function applySuggestion(text: string, suggestion: ComposerSuggestion): string {
  if (suggestion.kind === "command") return `/${suggestion.token} `;
  return text.replace(/(?:^|\s)@([^\s@]*)$/, (m) => {
    const lead = m.match(/^\s*/)?.[0] ?? "";
    return `${lead}@${suggestion.token} `;
  });
}


export type ComposerMention = {
  id: string;
  label: string;
  kind: "file" | "session" | "skill" | "plugin";
  description?: string;
};


export type ContextComposerSuggestion = {
  kind: "command" | "file" | "session" | "skill" | "plugin" | "goal" | "workflow";
  token: string;
  label?: string;
  description?: string;
};


export type ComposerStartActions = {
  canGoal: boolean;
  canWorkflow: boolean;
  canCompact?: boolean;
  onGoal?: () => void;
  onWorkflow: () => void;
  onPlugins: () => void;
  onModels?: () => void;
};


/** Recovery shown when an active composer cannot send because its model catalog is unavailable. */
export type ComposerModelRecovery =
  | { kind: "loading" }
  | { kind: "error"; onRetry: () => void }
  | { kind: "missing"; onConfigure: () => void }
  | { kind: "blocked" };


/** Shared autocomplete for the hero and conversation composer. */
export function contextComposerSuggestions(
  text: string,
  commands: { id: string; description?: string }[],
  mentions: ComposerMention[],
  actions?: Pick<ComposerStartActions, "canGoal" | "canWorkflow" | "canCompact">,
  cursorOffset?: number,
): ContextComposerSuggestion[] {
  const textBefore = typeof cursorOffset === "number" ? text.slice(0, cursorOffset) : text;
  const slash = /(?:^|\s)\/([A-Za-z0-9._-]*)$/.exec(textBefore);
  if (slash) {
    const prefix = slash[1].toLowerCase();
    const items: ContextComposerSuggestion[] = commands
      .filter((command) => {
        const norm = command.id.replace(/^\/+/, "").toLowerCase();
        return norm.startsWith(prefix) || (prefix.length > 0 && command.description?.toLowerCase().includes(prefix));
      })
      .slice(0, 6)
      .map((command) => ({ kind: "command", token: command.id.replace(/^\/+/, ""), description: command.description }));
    if (actions?.canGoal && "goal".startsWith(prefix)) items.push({ kind: "goal", token: "goal", description: tr("标记为目标任务") });
    if (actions?.canWorkflow && "workflow".startsWith(prefix)) items.push({ kind: "workflow", token: "workflow", description: tr("创建工作流") });
    // /compact is a host command, not a user-defined one: it only appears while
    // the sessions plugin that implements it is effective.
    if (actions?.canCompact && "compact".startsWith(prefix) && !items.some((item) => item.token === "compact")) {
      items.push({ kind: "command", token: "compact", description: tr("压缩当前对话（可附说明）") });
    }
    return items.slice(0, 8);
  }
  const trigger = /(?:^|\s)([@$])([^\s@#$]*)$/.exec(textBefore);
  if (!trigger) return [];
  const isSkillTrigger = trigger[1] === "$";
  const needle = trigger[2].toLowerCase();
  return mentions
    .filter((mention) => (isSkillTrigger ? mention.kind === "skill" : mention.kind !== "skill") &&
      (mention.label.toLowerCase().includes(needle) || mention.id.toLowerCase().includes(needle) || (mention.description && mention.description.toLowerCase().includes(needle))))
    .slice(0, 8)
    .map((mention) => ({
      kind: mention.kind,
      token: mention.id,
      label: mention.label,
      description: mention.description,
    }));
}


export function applyContextSuggestion(
  text: string,
  suggestion: ContextComposerSuggestion,
  cursorOffset?: number,
): string {
  const offset = typeof cursorOffset === "number" ? cursorOffset : text.length;
  const before = text.slice(0, offset);
  const after = text.slice(offset);

  if (suggestion.kind === "command") {
    const replaced = before.replace(/(?:^|\s)\/[A-Za-z0-9._-]*$/, (match) =>
      (match.match(/^\s*/)?.[0] ?? "") + "/" + suggestion.token + " ",
    );
    return replaced + after;
  }
  if (suggestion.kind === "goal" || suggestion.kind === "workflow") {
    const replaced = before.replace(/(?:^|\s)\/[A-Za-z0-9._-]*$/, (match) => match.match(/^\s*/)?.[0] ?? "");
    return replaced + after;
  }
  const expression = suggestion.kind === "skill"
    ? /(?:^|\s)\$([^\s@#$]*)$/
    : /(?:^|\s)@[^\s@#$]*$/;
  const replaced = before.replace(expression, (match) => match.match(/^\s*/)?.[0] ?? "");
  return replaced + after;
}


export const COMPOSER_ATTACHMENT_LIMITS = {
  count: 4,
  eachBytes: 2 * 1024 * 1024,
  totalBytes: 4 * 1024 * 1024,
} as const;


export function composerAttachmentBytes(data: string): number {
  if (!data) return 0;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(data.length * 3 / 4) - padding);
}


export async function encodeComposerFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}


export function extractFilesFromClipboard(clipboardData: DataTransfer | null): File[] {
  if (!clipboardData) return [];
  const files: File[] = [];
  if (clipboardData.files && clipboardData.files.length > 0) {
    for (let i = 0; i < clipboardData.files.length; i++) {
      const file = clipboardData.files[i];
      if (file) files.push(file);
    }
  } else if (clipboardData.items) {
    for (let i = 0; i < clipboardData.items.length; i++) {
      const item = clipboardData.items[i];
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
  }
  return files;
}


export function isFileDragEvent(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer?.types) return false;
  return Array.from(dataTransfer.types).some(
    (type) => type.toLowerCase() === "files" || type === "application/x-moz-file",
  );
}


export const MAX_PROMPT_HISTORY = 30;


export function appendPromptHistoryEntry(
  entries: readonly string[],
  entry: string,
  limit = MAX_PROMPT_HISTORY,
): string[] {
  const trimmed = entry.trim();
  if (!trimmed) {
    return [...entries];
  }
  if (entries.at(-1)?.trim() === trimmed) {
    return [...entries];
  }
  const normalizedLimit = Math.max(1, Math.trunc(limit));
  return [...entries, trimmed].slice(-normalizedLimit);
}


export function navigatePromptHistory(
  entries: readonly string[],
  currentIndex: number | null,
  direction: "up" | "down",
): {
  nextIndex: number | null;
  nextValue: string;
  shouldHandle: boolean;
} {
  if (entries.length === 0) {
    return {
      nextIndex: currentIndex,
      nextValue: "",
      shouldHandle: false,
    };
  }

  if (direction === "up") {
    const nextIndex = currentIndex === null ? entries.length - 1 : Math.max(currentIndex - 1, 0);
    return {
      nextIndex,
      nextValue: entries[nextIndex] ?? "",
      shouldHandle: true,
    };
  }

  if (currentIndex === null) {
    const nextIndex = entries.length - 1;
    return {
      nextIndex,
      nextValue: entries[nextIndex] ?? "",
      shouldHandle: true,
    };
  }

  if (currentIndex >= entries.length - 1) {
    return {
      nextIndex: null,
      nextValue: "",
      shouldHandle: true,
    };
  }

  const nextIndex = currentIndex + 1;
  return {
    nextIndex,
    nextValue: entries[nextIndex] ?? "",
    shouldHandle: true,
  };
}
